import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright';
import { parseManifest } from '../core/manifest.ts';
import type { Manifest, Section } from '../core/types.ts';
import { sha256 } from './hash.ts';
import { appRoot } from './paths.ts';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(appRoot, '.local-browsers');
export const { chromium } = await import('playwright');

export interface SourceOptions {
  source: string;
  selectors: string[];
  exclusions: string[];
  ready: { mode: 'dom' | 'selector' | 'signal'; value: string; timeout: number };
}
export { sha256 };
export function validateOptions(value: unknown): SourceOptions {
  const v = value as SourceOptions;
  if (
    !v ||
    typeof v.source !== 'string' ||
    !v.source ||
    v.source.length > 4096 ||
    !Array.isArray(v.selectors) ||
    !v.selectors.length ||
    v.selectors.length > 100 ||
    !v.selectors.every((s) => typeof s === 'string' && !!s.trim() && s.length < 2000) ||
    !Array.isArray(v.exclusions) ||
    v.exclusions.length > 100 ||
    !v.exclusions.every((s) => typeof s === 'string' && !!s.trim() && s.length < 2000) ||
    !v.ready ||
    !['dom', 'selector', 'signal'].includes(v.ready.mode) ||
    typeof v.ready.value !== 'string' ||
    !Number.isInteger(v.ready.timeout) ||
    v.ready.timeout < 100 ||
    v.ready.timeout > 60_000 ||
    (v.ready.mode !== 'dom' && !v.ready.value.trim())
  )
    throw new Error('Invalid source options. Timeout must be 100–60000 ms.');
  return v;
}
export function localUrl(value: string): URL {
  const u = new URL(value);
  if (
    !['http:', 'https:'].includes(u.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ||
    u.username ||
    u.password
  )
    throw new Error('Only local HTML files and loopback HTTP(S) URLs are supported.');
  return u;
}
async function openSource(
  options: SourceOptions,
): Promise<{ browser: Browser; page: Page; name: string }> {
  let url: string;
  let root: string | undefined;
  let origin: string | undefined;
  let name: string;
  if (/^https?:/i.test(options.source)) {
    const u = localUrl(options.source);
    url = u.href;
    origin = u.origin;
    name = u.pathname.split('/').pop() || u.hostname;
  } else {
    const path = await realpath(
      options.source.startsWith('file:') ? fileURLToPath(options.source) : resolve(options.source),
    );
    if (!['.html', '.htm'].includes(extname(path).toLowerCase()))
      throw new Error('Choose an .html or .htm file.');
    root = dirname(path);
    name = basename(path);
    // Serve approved local assets through an intercepted synthetic origin. file:// would permit
    // page scripts to read unrelated files, which routing cannot reliably isolate.
    url = `http://printwitness-source.invalid/${encodeURIComponent(basename(path))}`;
  }
  const browser = await chromium.launch({
    // Keep Chromium diagnostics from creating debug.log inside the installation.
    args: ['--disable-background-networking', '--disable-component-update', '--disable-logging'],
  });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    // Init scripts run before source scripts in every frame, including srcdoc frames.
    // HTTP routing cannot intercept ICE/STUN/TURN transports.
    await context.addInitScript(() => {
      for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection'])
        Object.defineProperty(window, key, {
          value: undefined,
          configurable: false,
          writable: false,
        });
    });
    await context.route('**/*', async (route) => {
      const requestUrl = new URL(route.request().url());
      if (!['GET', 'HEAD'].includes(route.request().method())) {
        await route.abort('blockedbyclient');
        return;
      }
      if (root && requestUrl.origin === 'http://printwitness-source.invalid') {
        try {
          const asset = await realpath(
            resolve(root, `.${decodeURIComponent(requestUrl.pathname)}`),
          );
          if (!asset.startsWith(root + sep)) return await route.abort();
          const type: Record<string, string> = {
            '.html': 'text/html',
            '.htm': 'text/html',
            '.css': 'text/css',
            '.js': 'text/javascript',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.woff2': 'font/woff2',
          };
          await route.fulfill({
            body: await readFile(asset),
            contentType: type[extname(asset)] ?? 'application/octet-stream',
          });
        } catch {
          await route.abort();
        }
      } else if (origin && requestUrl.origin === origin) {
        try {
          const response = await route.fetch({ maxRedirects: 0, timeout: options.ready.timeout });
          const target = response.headers().location;
          if (target && new URL(target, requestUrl).origin !== origin)
            await route.abort('blockedbyclient');
          else await route.fulfill({ response });
        } catch {
          await route.abort('failed');
        }
      } else await route.abort('blockedbyclient');
    });
    // WebSocket traffic bypasses normal request routing.
    await context.routeWebSocket('**/*', (ws) => ws.close());
    const page = await context.newPage();
    page.setDefaultTimeout(options.ready.timeout);
    const deadline = Date.now() + options.ready.timeout;
    const remaining = () => Math.max(1, deadline - Date.now());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
    if (options.ready.mode === 'selector')
      await page
        .locator(options.ready.value)
        .first()
        .waitFor({ state: 'attached', timeout: remaining() });
    if (options.ready.mode === 'signal')
      await page.waitForFunction(
        (key) => (window as unknown as Record<string, unknown>)[key] === true,
        options.ready.value,
        { timeout: remaining() },
      );
    await page.waitForFunction(() => document.fonts.status === 'loaded', undefined, {
      timeout: remaining(),
    });
    await page.emulateMedia({ media: 'screen' });
    return { browser, page, name };
  } catch (e) {
    await browser.close();
    throw e;
  }
}

export async function capture(options: SourceOptions): Promise<Manifest> {
  const { browser, page, name } = await openSource(options);
  try {
    const snapshot = await page.evaluate(({ selectors, exclusions }) => {
      const clean = (s: string) =>
        s
          .normalize('NFKC')
          .replace(/[\u00ad\u200b\ufeff]/gu, '')
          .replace(/\s+/gu, ' ')
          .trim();
      const excluded = (e: Element) => exclusions.some((s) => e.matches(s) || !!e.closest(s));
      // Read the live tree without changing it. Contextual selectors must retain ancestors.
      const rawContent = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
        if (
          !(node instanceof Element) ||
          excluded(node) ||
          node.matches('script,style,template,noscript')
        )
          return '';
        if (node.tagName === 'BR') return ' ';
        const value = [...node.childNodes].map(rawContent).join('');
        return node.matches('p,li,div,section,article,h1,h2,h3,h4,h5,h6,tr,td,th')
          ? ` ${value} `
          : value;
      };
      const content = (e: Element) => clean(rawContent(e));
      for (const s of [...selectors, ...exclusions]) document.querySelectorAll(s);
      const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(
        (h) => !excluded(h) && content(h),
      );
      const selected = selectors.flatMap((s) => {
        const els = [...document.querySelectorAll(s)];
        if (!els.length) throw new Error(`Selector matches no elements: ${s}`);
        return els.map((el) => ({ selector: s, el }));
      });
      if (selected.length > 100) throw new Error('Maximum 100 selected sections.');
      if (
        selected.some((a, i) =>
          selected.some((b, j) => i !== j && (a.el.contains(b.el) || b.el.contains(a.el))),
        )
      )
        throw new Error('Selected elements overlap. Choose disjoint sections or tables.');
      return selected.map(({ selector, el }, si): Section => {
        if (excluded(el)) throw new Error(`Selected element is excluded: ${selector}`);
        const heading =
          headings.find((h) => h === el || el.contains(h)) ??
          [...headings]
            .reverse()
            .find((h) => !!(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
        if (!heading)
          throw new Error(
            `Section ${selector} needs a heading (h1–h6), inside it or preceding it.`,
          );
        const before = [...headings]
          .reverse()
          .find(
            (h) =>
              h !== heading &&
              !!(h.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING),
          );
        const after = headings.find(
          (h) =>
            !el.contains(h) &&
            h !== el &&
            !!(el.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING),
        );
        if (el.matches('table')) {
          const neighbours = [...document.querySelectorAll('table')].filter(
            (t) =>
              !excluded(t) &&
              !!(heading.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) &&
              (!after || !!(t.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING)),
          );
          if (neighbours.length > 1)
            throw new Error(
              `Table ${selector} shares a heading with other tables. Select their containing section or provide separate headings.`,
            );
        }
        const expectations: Section['expectations'] = [];
        let serial = 0;
        const add = (e: Omit<Section['expectations'][number], 'id'>) => {
          if (e.text) expectations.push({ id: `s${si + 1}-e${++serial}`, ...e });
        };
        // Walk text nodes into semantic blocks, preserving direct text and repeated paragraphs.
        const walker = document.createTreeWalker(
          el,
          NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        );
        const blocks = new Map<Element, string[]>();
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.nodeType === Node.ELEMENT_NODE && !(node instanceof HTMLBRElement)) continue;
          const parent = node.parentElement;
          if (!parent || excluded(parent) || parent.closest('table,script,style,template,noscript'))
            continue;
          let block = parent.closest('p,li,h1,h2,h3,h4,h5,h6,dt,dd,blockquote,pre,figcaption');
          if (!block || !el.contains(block)) block = parent;
          const parts = blocks.get(block) ?? [];
          parts.push(node instanceof HTMLBRElement ? ' ' : (node.textContent ?? ''));
          blocks.set(block, parts);
        }
        for (const parts of blocks.values()) add({ kind: 'text', text: clean(parts.join('')) });
        const tables = el.matches('table') ? [el] : [...el.querySelectorAll('table')];
        const headers: string[] = [];
        for (const table of tables) {
          if (excluded(table)) continue;
          const caption = table.querySelector('caption');
          if (caption && !excluded(caption)) add({ kind: 'text', text: content(caption) });
          const rows = [...table.querySelectorAll('tr')].filter(
            (r) => r.closest('table') === table && !excluded(r),
          );
          for (const row of rows) {
            const cells = [...row.querySelectorAll(':scope > th,:scope > td')]
              .filter((c) => !excluded(c))
              .map(content);
            const text = cells.join(' ');
            if (!text.trim()) continue;
            if (row.closest('thead') || [...row.children].every((c) => c.tagName === 'TH')) {
              headers.push(text);
              add({ kind: 'text', role: 'table-header', text });
            } else add({ kind: 'row', cells, text });
          }
        }
        for (const a of [...el.querySelectorAll<HTMLAnchorElement>('a[href]')])
          if (!excluded(a) && content(a)) {
            const raw = a.getAttribute('href') ?? '';
            // Synthetic file origin is not a portable destination; keep relative file links explicit.
            const href =
              location.hostname === 'printwitness-source.invalid' &&
              !/^[a-z][a-z\d+.-]*:/i.test(raw)
                ? raw
                : a.href;
            add({ kind: 'link', text: content(a), href });
          }
        if (!expectations.length) throw new Error(`No expected content: ${selector}`);
        // The next heading alone is too broad: unselected text can precede it.
        const following = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let endContext: string | null = null;
        let startContext: string | null = null;
        while (following.nextNode()) {
          const node = following.currentNode;
          const parent = node.parentElement;
          if (
            !parent ||
            el.contains(node) ||
            excluded(parent) ||
            parent.closest('script,style,template,noscript') ||
            !clean(node.textContent ?? '')
          )
            continue;
          if (el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING) {
            const block = parent.closest(
              'p,li,h1,h2,h3,h4,h5,h6,dt,dd,blockquote,pre,figcaption,tr',
            );
            startContext =
              block && !block.contains(el) ? content(block) : clean(node.textContent ?? '');
            continue;
          }
          if (!(el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
          const block = parent.closest('p,li,h1,h2,h3,h4,h5,h6,dt,dd,blockquote,pre,figcaption,tr');
          endContext =
            block && !block.contains(el) ? content(block) : clean(node.textContent ?? '');
          break;
        }
        return {
          id: `s${si + 1}`,
          endContext,
          startContext,
          anchorInside: el.contains(heading),
          selector,
          title: content(heading),
          anchor: content(heading),
          before: before ? content(before) : null,
          after: after ? content(after) : null,
          headers,
          expectations,
        };
      });
    }, options);
    const digest = sha256(await page.content());
    return parseManifest({
      schema: 'printwitness/1',
      createdAt: new Date().toISOString(),
      source: {
        name,
        sha256: digest,
        readiness: `${options.ready.mode}:${options.ready.value}; timeout=${options.ready.timeout}ms`,
      },
      exclusions: options.exclusions,
      sections: snapshot,
    });
  } finally {
    await browser.close();
  }
}

export async function printSource(options: SourceOptions): Promise<Buffer> {
  const { browser, page } = await openSource(options);
  try {
    await page.emulateMedia({ media: 'print' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        page.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true, tagged: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('PDF export timed out')),
            options.ready.timeout,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await browser.close();
  }
}
