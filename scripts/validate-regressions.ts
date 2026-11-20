import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compare } from '../src/core/compare.ts';
import { analyzePdf } from '../src/node/pdf.ts';
import { capture, printSource, type SourceOptions, sha256 } from '../src/node/source.ts';

/** Real DOM -> manifest -> Chromium PDF -> PDF.js regressions, without external resources. */
export async function validateRegressions() {
  const root = resolve('artifacts/regressions');
  await mkdir(root, { recursive: true });
  const options: SourceOptions = {
    source: `${root}/source.html`,
    selectors: ['#required'],
    exclusions: [],
    ready: { mode: 'dom', value: '', timeout: 5000 },
  };
  const document = (body: string) =>
    `<!doctype html><meta charset="utf-8"><style>body{font:16px Arial}td{padding:8px 20px} @media print{.lost,.omit{display:none}}</style><h1>Title</h1>${body}`;
  const run = async (html: string, exclusions: string[] = []) => {
    await writeFile(options.source, document(html));
    const manifest = await capture({ ...options, exclusions });
    const bytes = await printSource({ ...options, exclusions });
    const { index } = await analyzePdf(bytes);
    return {
      manifest,
      report: compare(manifest, index, { name: 'regression.pdf', sha256: sha256(bytes) }),
    };
  };
  for (const tail of ['<section><p>Approval</p></section>', '<p>Approval</p><h2>Appendix</h2>']) {
    const { report } = await run(
      `<section id="required"><h2>Required</h2><p class="lost">Approval</p></section>${tail}`,
    );
    assert.notEqual(
      report.findings.find((f) => f.expected === 'Approval')?.status,
      'found',
      'a following foreign paragraph must not cover a loss',
    );
  }
  const hidden = await run(
    '<p>Secret terms</p><section id="required" class="lost"><h2>Required</h2><p>Secret terms</p></section><h2>Appendix</h2>',
  );
  assert.equal(
    hidden.report.findings.find((f) => f.expected === 'Secret terms')?.status,
    'mismatch',
    'preceding foreign text cannot cover a hidden section',
  );
  const whitespace = await run(
    '<section id="required"><h2>Required</h2><p>Hello<br>world</p><p><span>first</span> <span>second</span></p><table><tr><td>A <span class="omit">EXCLUDED</span></td><td>B</td></tr></table></section><h2>Appendix</h2>',
    ['#required .omit'],
  );
  assert(whitespace.manifest.sections[0].expectations.some((e) => e.text === 'Hello world'));
  assert(whitespace.manifest.sections[0].expectations.some((e) => e.text === 'first second'));
  assert.deepEqual(
    whitespace.manifest.sections[0].expectations.find((e) => e.kind === 'row')?.cells,
    ['A', 'B'],
  );
  assert.equal(whitespace.report.status, 'found', JSON.stringify(whitespace.report.findings));
  const japanese = await run(
    '<section id="required"><h2>必須の内容</h2><p style="width:140px">この文書には重要な必須情報が含まれています。すべての内容を保存して確認してください。</p></section><h2>Appendix</h2>',
  );
  assert.equal(japanese.report.status, 'found', JSON.stringify(japanese.report.findings));
  const row = await run(
    '<section id="required"><h2>Required</h2><table><tr><td id="a">A B</td><td id="b">C</td></tr></table></section><h2>Appendix</h2><script>addEventListener("beforeprint",()=>{document.querySelector("#a").textContent="A";document.querySelector("#b").textContent="B C"})</script>',
  );
  assert.notEqual(row.report.findings.find((f) => f.kind === 'row')?.status, 'found');
  // A real PDF with both labels in one text item and swapped URL rectangles.
  const stream =
    'BT /F1 12 Tf 30 750 Td (Title) Tj 0 -30 Td (Required) Tj 0 -30 Td (alpha beta) Tj 0 -30 Td (Appendix) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R 7 0 R] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Annot /Subtype /Link /Rect [30 687 60 704] /A << /S /URI /URI (https://example.org/beta) >> >>',
    '<< /Type /Annot /Subtype /Link /Rect [61 687 90 704] /A << /S /URI /URI (https://example.org/alpha) >> >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const { index } = await analyzePdf(Buffer.from(pdf));
  const m = structuredClone(whitespace.manifest);
  m.sections[0].expectations = ['alpha', 'beta'].map((label) => ({
    id: label,
    kind: 'link',
    text: label,
    href: `https://example.org/${label}`,
  }));
  assert(
    compare(m, index, { name: 'swapped.pdf', sha256: sha256(pdf) }).findings.every(
      (f) => f.status === 'manual',
    ),
  );
  const contents = {
    ...options,
    source: resolve('fixtures/internal-links.html'),
    selectors: ['#contents'],
  };
  const toc = await capture(contents);
  assert.equal(toc.sections[0].endContextNext, 'Delivery takes five days.');
  const tocPdf = await printSource(contents);
  const actual = (await analyzePdf(tocPdf)).index;
  const tocReport = compare(toc, actual, { name: 'internal-links.pdf', sha256: sha256(tocPdf) });
  assert.equal(tocReport.status, 'found', JSON.stringify(tocReport.findings));
  await writeFile('artifacts/validation/internal-links-manifest.json', JSON.stringify(toc));
  await writeFile('artifacts/validation/internal-links.pdf', tocPdf);

  await writeFile(
    options.source,
    document(`
    <nav id="required"><h2>Fragment cases</h2>
      <p><a href="#missing">Missing destination</a></p>
      <p><a href="#same">Duplicate ID</a></p>
      <p><a href="#empty">Empty heading</a></p>
      <p><a href="#paragraph">Wrong element</a></p>
      <p><a href="#repeated">Repeated heading</a></p>
      <p><a href="#repeated-in-body">Repeated in body</a></p>
      <p><a href="#caf%C3%A9">Encoded destination</a></p>
    </nav>
    <h2 id="same">Shipping terms</h2><p id="same">Duplicate ID here</p>
    <h2 id="empty"><img alt="Decoration"></h2>
    <p id="paragraph">Body paragraph</p>
    <h2 id="repeated">Return terms</h2><h3>Return terms</h3>
    <h2 id="repeated-in-body">Service terms</h2><p>Service terms</p>
    <h2 id="café">Coffee terms</h2>`),
  );
  const fragments = (await capture(options)).sections[0].expectations.flatMap((e) =>
    e.internalTarget ? [e.internalTarget] : [],
  );
  assert.deepEqual(
    fragments.map((target) => [target.fragment, target.issue]),
    [
      ['missing', 'missing-fragment'],
      ['same', 'duplicate-id'],
      ['empty', 'heading-text-unavailable'],
      ['paragraph', 'not-heading'],
      ['repeated', 'ambiguous-heading-text'],
      ['repeated-in-body', 'ambiguous-heading-text'],
      ['café', undefined],
    ],
  );
  assert.equal(fragments.at(-1)?.heading, 'Coffee terms');
  console.log(
    'Regressions: DOM section edges, inline whitespace, contextual exclusions, Japanese wraps, cell partitions, merged link labels and internal link capture passed.',
  );
}
