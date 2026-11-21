import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compare } from '../src/core/compare.ts';
import { analyzePdf } from '../src/node/pdf.ts';
import { reportHtml } from '../src/node/report.ts';
import { capture, printSource, type SourceOptions, sha256 } from '../src/node/source.ts';
import { fixtureServer } from './fixture-server.ts';
import { validateNetwork } from './validate-network.ts';
import { validatePagination } from './validate-pagination.ts';
import { validateRegressions } from './validate-regressions.ts';

await mkdir('artifacts/validation', { recursive: true });
const originalHash = sha256(await readFile('fixtures/validation.html'));
const fixture = await fixtureServer();
const options: SourceOptions = {
  source: fixture.url,
  selectors: ['#summary', '#register', '#terms'],
  exclusions: ['.screen-note'],
  ready: { mode: 'signal', value: 'PRINTWITNESS_READY', timeout: 10000 },
};
try {
  const manifest = await capture(options);
  assert(
    manifest.sections[0].expectations.some(
      (e) => e.text === 'Dynamic records are ready for export.',
    ),
  );
  assert.equal(
    manifest.sections.flatMap((s) => s.expectations).filter((e) => e.kind === 'row').length,
    96,
  );
  await writeFile('artifacts/validation/manifest.json', JSON.stringify(manifest, null, 2));
  for (const variant of ['broken', 'fixed']) {
    const bytes = await printSource({ ...options, source: `${fixture.url}?variant=${variant}` });
    const { index, images } = await analyzePdf(bytes);
    const report = compare(manifest, index, { name: `${variant}.pdf`, sha256: sha256(bytes) });
    await writeFile(`artifacts/validation/${variant}.pdf`, bytes);
    await writeFile(`artifacts/validation/${variant}.json`, JSON.stringify(report, null, 2));
    await writeFile(`artifacts/validation/${variant}.html`, reportHtml(report, images));
    assert(index.pages.length >= 4, `expected multipage template, got ${index.pages.length} pages`);
    assert(
      images.every((i) => i.startsWith('data:image/png;base64,')),
      'all page previews must render',
    );
    if (variant === 'broken') {
      assert.equal(report.status, 'mismatch');
      assert.equal(
        report.findings.find((f) => f.kind === 'row' && f.expected.startsWith('PW-042 '))?.status,
        'mismatch',
      );
      assert.deepEqual(
        report.findings
          .filter((f) => f.expected === 'Mandatory approval is recorded.')
          .map((f) => f.status),
        ['found', 'mismatch'],
      );
      assert.equal(
        report.findings.find((f) => f.expected === 'Archive the signed acceptance receipt.')
          ?.status,
        'mismatch',
      );
      assert.equal(report.findings.find((f) => f.kind === 'link')?.status, 'mismatch');
      assert.equal(report.findings.filter((f) => f.status === 'mismatch').length, 6);
    } else {
      assert.equal(
        report.status,
        'found',
        JSON.stringify(
          report.findings.filter((f) => f.status !== 'found'),
          null,
          2,
        ),
      );
      assert(report.findings.every((f) => f.status === 'found'));
    }
    console.log(
      `${variant}: ${report.status}; ${index.pages.length} pages; ${report.findings.length} checks; ${report.findings.filter((f) => f.status === 'mismatch').length} mismatches`,
    );
  }
  // Also exercise the local-file path with relative assets and signal readiness.
  const local = await capture({ ...options, source: resolve('fixtures/validation.html') });
  assert.deepEqual(local.sections, manifest.sections);
  await assert.rejects(
    capture({ ...options, ready: { mode: 'signal', value: 'NEVER_READY', timeout: 200 } }),
    /Timeout/,
  );
  await assert.rejects(
    capture({ ...options, selectors: ['#does-not-exist'] }),
    /matches no elements/,
  );
  await assert.rejects(
    capture({ ...options, selectors: ['#register', '#register table'] }),
    /overlap/,
  );
  assert.equal(sha256(await readFile('fixtures/validation.html')), originalHash);
  const corrupt = await analyzePdf(new TextEncoder().encode('not a PDF'));
  assert.equal(
    compare(manifest, corrupt.index, { name: 'corrupt.pdf', sha256: 'test' }).status,
    'unverifiable',
  );
  console.log(
    'Local file, explicit readiness timeout, invalid/overlapping selectors, corrupt PDF and source immutability: passed',
  );
} finally {
  await fixture.close();
}
await validateNetwork();
await validateRegressions();
await validatePagination();
