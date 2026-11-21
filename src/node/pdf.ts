import {
  getDocument,
  isValidExplicitDest,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Box, PdfDestination, PdfIndex } from '../core/types.ts';
import { pdfResources } from './pdf-resources.ts';

async function resolveDestination(
  doc: PDFDocumentProxy,
  dest: string | unknown[],
): Promise<PdfDestination> {
  const observed: PdfDestination = typeof dest === 'string' ? { name: dest } : {};
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || !isValidExplicitDest(explicit)) return observed;
    const [ref, mode, first, second] = explicit;
    observed.type = mode.name;
    const page = typeof ref === 'number' ? ref + 1 : (await doc.getPageIndex(ref)) + 1;
    if (page < 1 || page > doc.numPages) return observed;
    observed.page = page;

    // XYZ supplies left/top, while FitH and FitBH only specify a usable top.
    // Other fit modes are page-level evidence for this check.
    const horizontalFit = mode.name === 'FitH' || mode.name === 'FitBH';
    if (mode.name !== 'XYZ' && !horizontalFit) return observed;
    const x = horizontalFit ? undefined : first;
    const y = horizontalFit ? first : second;
    const viewport = (await doc.getPage(page)).getViewport({ scale: 1 });
    const [, b, , d] = viewport.transform;
    // On a quarter-turned page the vertical position depends on PDF x instead of PDF y.
    if ((b && !Number.isFinite(x)) || (d && (!Number.isFinite(y) || (horizontalFit && y < 0))))
      return observed;
    const [, top] = viewport.convertToViewportPoint(b ? x : 0, d ? y : 0);
    if (top >= 0 && top <= viewport.height) observed.y = top;
  } catch {
    // A broken page reference or name leaves this destination unresolved.
  }
  return observed;
}

export interface PdfAnalysis {
  index: PdfIndex;
  images: string[];
}
export async function analyzePdf(
  bytes: Uint8Array,
  { resourceRoot }: { resourceRoot?: URL } = {},
): Promise<PdfAnalysis> {
  const index: PdfIndex = { pages: [], tokens: [], links: [], warnings: [] };
  const linkAnnotationPages: number[] = [];
  index.linkAnnotationPages = linkAnnotationPages;
  const namedDestinations = new Map<string, PdfDestination>();
  const images: string[] = [];
  let doc: PDFDocumentProxy | undefined;
  const resources = pdfResources(resourceRoot);
  const task = getDocument({
    data: new Uint8Array(bytes),
    ...resources.options,
    stopAtErrors: true,
  });
  task.onPassword = () => task.destroy();
  try {
    doc = await task.promise;
    index.pageCount = doc.numPages;
    if (doc.numPages > 100) throw new Error('v0.1 supports up to 100 PDF pages.');
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const rect = (r: number[]): Box => {
        const [a, b, c, d, e, f] = viewport.transform;
        const [x1, y1, x2, y2] = [
          a * r[0] + c * r[1] + e,
          b * r[0] + d * r[1] + f,
          a * r[2] + c * r[3] + e,
          b * r[2] + d * r[3] + f,
        ];
        return {
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
        };
      };
      const content = await page.getTextContent();
      const pageText: string[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [a, b, , , x, y] = item.transform;
        if (Math.abs(b) > 0.1 || a < 0 || item.dir === 'ttb')
          index.warnings.push(`Page ${n}: rotated/vertical text needs manual inspection.`);
        index.tokens.push({
          page: n,
          text: item.str,
          lineEnd: item.hasEOL,
          box: rect([x, y, x + item.width, y + Math.max(item.height, 1)]),
        });
        pageText.push(item.str);
      }
      index.pages.push({
        number: n,
        width: viewport.width,
        height: viewport.height,
        text: pageText.join(' '),
      });
      let linkRectanglesComplete = true;
      for (const annotation of await page.getAnnotations({ intent: 'display' })) {
        if (annotation.subtype !== 'Link') continue;
        if (
          !Array.isArray(annotation.rect) ||
          annotation.rect.length !== 4 ||
          !annotation.rect.every(Number.isFinite)
        ) {
          linkRectanglesComplete = false;
          continue;
        }
        const box = rect(annotation.rect);
        if (!box.width || !box.height) linkRectanglesComplete = false;
        const dest: unknown = annotation.dest;
        let destination: PdfDestination | undefined;
        if (typeof dest === 'string') {
          destination = namedDestinations.get(dest) ?? (await resolveDestination(doc, dest));
          namedDestinations.set(dest, destination);
        } else if (Array.isArray(dest)) {
          destination = await resolveDestination(doc, dest);
        }
        const hitBoxes: Box[] = [];
        if (annotation.quadPoints instanceof Float32Array) {
          const quad = annotation.quadPoints;
          for (let i = 0; i < quad.length; i += 8)
            hitBoxes.push(rect([quad[i], quad[i + 1], quad[i + 6], quad[i + 7]]));
        }
        index.links.push({
          page: n,
          box,
          href: typeof annotation.url === 'string' ? annotation.url : undefined,
          destination,
          hitBoxes: hitBoxes.length ? hitBoxes : undefined,
        });
      }
      if (linkRectanglesComplete) linkAnnotationPages.push(n);
      try {
        const scale = Math.min(1.25, Math.sqrt(2_000_000 / (viewport.width * viewport.height)));
        const renderViewport = page.getViewport({ scale });
        // PDF.js uses its own bundled Node canvas factory; no additional canvas dependency.
        const factory = doc.canvasFactory as {
          create(
            w: number,
            h: number,
          ): {
            canvas: HTMLCanvasElement & { toBuffer(type: string): Buffer };
            context: CanvasRenderingContext2D;
          };
          destroy(c: unknown): void;
        };
        const canvas = factory.create(
          Math.ceil(renderViewport.width),
          Math.ceil(renderViewport.height),
        );
        try {
          await page.render({
            canvas: canvas.canvas,
            canvasContext: canvas.context,
            viewport: renderViewport,
          }).promise;
          images.push(
            `data:image/png;base64,${canvas.canvas.toBuffer('image/png').toString('base64')}`,
          );
        } finally {
          factory.destroy(canvas);
        }
      } catch {
        images.push('');
        index.warnings.push(`Page ${n}: preview could not be rendered.`);
      }
      page.cleanup();
    }
    if (index.warnings.some((w) => w.includes('rotated/vertical')))
      index.error =
        'Rotated or vertical text is not reliably mapped by v0.1. Inspect this PDF manually.';
  } catch (error) {
    index.error = `Cannot read PDF: ${error instanceof Error ? error.message : 'unknown PDF error'}`;
  } finally {
    await task.destroy();
  }
  if (resources.failures.size)
    index.error = `PDF runtime resource unavailable: ${[...resources.failures].join(', ')}. Processing is incomplete.`;
  return { index, images };
}
