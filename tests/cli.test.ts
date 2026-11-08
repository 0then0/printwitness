import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compare } from '../src/core/compare.ts';
import { parseManifest } from '../src/core/manifest.ts';
import type { Manifest, Report } from '../src/core/types.ts';
import { exitCodes, reportFiles } from '../src/node/cli.ts';
import { sha256 } from '../src/node/hash.ts';
import { maxJsonBytes, maxPdfBytes } from '../src/node/limits.ts';
import { analyzePdf } from '../src/node/pdf.ts';
import { startServer } from '../src/node/server.ts';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const cli = here('../src/node/cli.ts');
const preload = here('./support/cli-fault.ts');
const pdfFixture = (name: string) => here(`../fixtures/pdf/${name}.pdf`);
const base = JSON.parse(await readFile(here('../fixtures/pdf/cmap-manifest.json'), 'utf8'));

// plain.pdf contains "Required Plain control End". Every manifest here is written by hand
// from that known text, never derived from extraction output.
const section = (id: string, anchor: string, texts: string[]) => ({
  ...base.sections[0],
  id,
  selector: `#${id}`,
  title: id,
  anchor,
  endContext: 'End',
  expectations: texts.map((text, i) => ({ id: `${id}-${i}`, kind: 'text', text })),
});
const manifestOf = (...sections: unknown[]): Manifest => ({ ...base, sections });
const found = manifestOf(section('ok', 'Required', ['Plain control']));
const lost = manifestOf(section('lost', 'Required', ['Plain control', 'Missing record']));
// The anchor is absent, so the section boundary cannot be established.
const ambiguous = manifestOf(section('vague', 'Absent anchor', ['Plain control']));
const lostAndAmbiguous = manifestOf(
  section('lost', 'Required', ['Plain control', 'Missing record']),
  section('vague', 'Absent anchor', ['Plain control']),
);

interface Workspace {
  dir: string;
  file(name: string): string;
}
async function workspace(t: { after(fn: () => Promise<void>): void }): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), 'printwitness cli 日本語 '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['plain', 'textless', 'corrupt', 'predefined-cmap'])
    await copyFile(pdfFixture(name), join(dir, `${name}.pdf`));
  return { dir, file: (name) => join(dir, name) };
}
const put = (w: Workspace, name: string, value: unknown) =>
  writeFile(w.file(name), typeof value === 'string' ? value : JSON.stringify(value));

function run(w: Workspace, args: string[], env: Record<string, string> = {}, preloaded = false) {
  const result = spawnSync(
    process.execPath,
    [...(preloaded ? ['--import', preload] : []), cli, ...args],
    // Relative paths resolve against the caller's directory, not the checkout.
    { cwd: w.dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env } },
  );
  assert.ifError(result.error);
  return result;
}
const check = (manifest: string, pdf: string, output: string, ...more: string[]) => [
  'check',
  '--manifest',
  manifest,
  '--pdf',
  pdf,
  '--output',
  output,
  ...more,
];
const readReport = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Report;
// JSON drops undefined fields; compare the serialized contract without the run time.
const semantic = ({ createdAt: _, ...report }: Report) => JSON.parse(JSON.stringify(report));

test('a valid PDF and manifest pass with JSON and HTML evidence from one run', async (t) => {
  const w = await workspace(t);
  await put(w, 'expected.json', found);
  const before = await Promise.all(['expected.json', 'plain.pdf'].map((n) => readFile(w.file(n))));
  const times = await Promise.all(['expected.json', 'plain.pdf'].map((n) => stat(w.file(n))));
  const result = run(w, check('expected.json', 'plain.pdf', 'out/nested'));
  assert.equal(result.status, exitCodes.passed, result.stderr);
  assert.match(result.stdout, /^PrintWitness check: found \(exit 0\)/);
  assert.match(result.stdout, /Text-layer check only/);
  const report = await readReport(w.file(`out/nested/${reportFiles.json}`));
  assert.equal(report.status, 'found');
  assert.equal(report.pdf.name, 'plain.pdf');
  assert.equal(report.pdf.sha256, sha256(before[1]));
  assert.deepEqual(report.manifest, found);
  const html = await readFile(w.file(`out/nested/${reportFiles.html}`), 'utf8');
  assert(html.startsWith('<!doctype html>'));
  assert(html.includes(report.pdf.sha256), 'HTML must describe the same PDF as the JSON');
  assert(html.includes('data:image/png;base64,'), 'HTML embeds page previews');
  assert.equal(html.match(/<figure id="page-/g)?.length, report.pdf.pages.length);
  for (const finding of report.findings) assert(html.includes(`data-finding="${finding.id}"`));
  assert.deepEqual(
    (await readdir(w.file('out/nested'))).sort(),
    [reportFiles.html, reportFiles.json].sort(),
    'no staging files remain',
  );
  // Inputs are read-only evidence.
  assert.deepEqual(await readFile(w.file('expected.json')), before[0]);
  assert.deepEqual(await readFile(w.file('plain.pdf')), before[1]);
  assert.equal((await stat(w.file('plain.pdf'))).mtimeMs, times[1].mtimeMs);
  assert.equal((await stat(w.file('expected.json'))).mtimeMs, times[0].mtimeMs);
});

test('missing required content is a confirmed violation with exit code 1', async (t) => {
  const w = await workspace(t);
  await put(w, 'expected.json', lost);
  const result = run(w, check('expected.json', 'plain.pdf', 'out'));
  assert.equal(result.status, exitCodes.mismatch);
  assert.match(result.stdout, /mismatch: \[lost\] Missing record/);
  const report = await readReport(w.file(`out/${reportFiles.json}`));
  assert.equal(report.status, 'mismatch');
  assert.deepEqual(
    report.findings.map((f) => [f.expected, f.status]),
    [
      ['Plain control', 'found'],
      ['Missing record', 'mismatch'],
    ],
  );
});

test('a mismatch takes priority over manual review while the report keeps both', async (t) => {
  const w = await workspace(t);
  await put(w, 'expected.json', lostAndAmbiguous);
  const result = run(w, check('expected.json', 'plain.pdf', 'out'));
  assert.equal(result.status, exitCodes.mismatch);
  const statuses = (await readReport(w.file(`out/${reportFiles.json}`))).findings.map(
    (f) => f.status,
  );
  assert.deepEqual(statuses, ['found', 'mismatch', 'manual']);
});

test('manual and unverifiable results never exit with the success code', async (t) => {
  const w = await workspace(t);
  const cases: [string, Manifest, string, string][] = [
    ['manual', ambiguous, 'plain.pdf', 'manual'],
    ['textless', found, 'textless.pdf', 'unverifiable'],
    ['corrupt', found, 'corrupt.pdf', 'unverifiable'],
  ];
  for (const [name, manifest, pdf, status] of cases) {
    await put(w, `${name}.json`, manifest);
    const result = run(w, check(`${name}.json`, pdf, `out-${name}`));
    assert.equal(result.status, exitCodes.incomplete, `${name}: ${result.stderr}`);
    const report = await readReport(w.file(`out-${name}/${reportFiles.json}`));
    assert.equal(report.status, status);
    assert(report.findings.every((f) => f.status === status));
  }
  // A damaged PDF is incomplete evidence, not proof that content was lost.
  const corrupt = await readReport(w.file(`out-corrupt/${reportFiles.json}`));
  assert.match(corrupt.findings[0].reason, /^Cannot read PDF:/);
});

test('input and usage errors use exit code 3 with distinct codes and no output', async (t) => {
  const w = await workspace(t);
  await put(w, 'expected.json', found);
  await put(w, 'broken.json', '{ not json');
  await put(w, 'wrong-schema.json', { schema: 'other' });
  await mkdir(w.file('a-directory'));
  const errors: [string[], string][] = [
    [check('absent.json', 'plain.pdf', 'out'), 'input-not-found'],
    [check('expected.json', 'absent.pdf', 'out'), 'input-not-found'],
    [check('broken.json', 'plain.pdf', 'out'), 'manifest-invalid'],
    [check('wrong-schema.json', 'plain.pdf', 'out'), 'manifest-invalid'],
    [check('expected.json', 'a-directory', 'out'), 'input-(not-file|unreadable)'],
    [['check', '--pdf', 'plain.pdf'], 'usage'],
    [['check', '--manifest', 'a', '--manifest', 'b', '--pdf', 'p', '--output', 'o'], 'usage'],
    [[...check('expected.json', 'plain.pdf', 'out'), '--serve'], 'usage'],
    [['verify'], 'usage'],
  ];
  for (const [args, code] of errors) {
    const result = run(w, args);
    assert.equal(result.status, exitCodes.error, args.join(' '));
    assert.match(result.stderr, new RegExp(`^printwitness: error\\[${code}\\]`), args.join(' '));
    assert.equal(result.stdout, '', 'stdout stays empty on errors');
    const json = run(w, [...args, '--json']);
    assert.equal(json.status, exitCodes.error);
    assert.equal(json.stdout, '');
  }
  assert.deepEqual(
    (await readdir(w.dir)).filter((n) => n.startsWith('out')),
    [],
  );
});

test('a symlinked entry path still runs the check instead of exiting silently', {
  skip: process.platform === 'win32',
}, async (t) => {
  const w = await workspace(t);
  await put(w, 'expected.json', found);
  await symlink(here('..'), w.file('checkout'), 'dir');
  const result = spawnSync(
    process.execPath,
    [w.file('checkout/src/node/cli.ts'), ...check('expected.json', 'textless.pdf', 'out')],
    { cwd: w.dir, encoding: 'utf8', timeout: 60_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, exitCodes.incomplete, result.stderr);
  assert.match(result.stdout, /^PrintWitness check: unverifiable/);
  assert((await readdir(w.file('out'))).includes(reportFiles.json));
});

test('uninstalled dependencies are an error, never the violation code', async (t) => {
  const w = await workspace(t);
  await put(w, 'expected.json', found);
  // A copy of the sources with no node_modules anywhere above it.
  await cp(here('../src'), w.file('app/src'), { recursive: true });
  await put(w, 'app/package.json', { type: 'module' });
  const result = spawnSync(
    process.execPath,
    [w.file('app/src/node/cli.ts'), ...check('expected.json', 'plain.pdf', 'out')],
    { cwd: w.dir, encoding: 'utf8', timeout: 60_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, exitCodes.error, result.stderr);
  assert.match(
    result.stderr,
    /^printwitness: error\[dependency-unavailable\]: PDF\.js cannot be loaded/,
  );
  assert.match(result.stderr, /npm ci/);
  assert.equal(result.stdout, '');
  assert.deepEqual(
    (await readdir(w.dir)).filter((n) => n.startsWith('out')),
    [],
  );
});

test('input size limits are enforced before the file is loaded', async (t) => {
  const w = await workspace(t);
  await put(w, 'expected.json', found);
  // Sparse files: the limit check must reject them from metadata, not by reading them.
  await writeFile(w.file('huge.pdf'), '');
  await truncate(w.file('huge.pdf'), maxPdfBytes + 1);
  await writeFile(w.file('huge.json'), '');
  await truncate(w.file('huge.json'), maxJsonBytes + 1);
  for (const [args, label] of [
    [check('expected.json', 'huge.pdf', 'out'), 'PDF'],
    [check('huge.json', 'plain.pdf', 'out'), 'Manifest'],
  ] as const) {
    const result = run(w, args);
    assert.equal(result.status, exitCodes.error);
    assert.match(result.stderr, new RegExp(`error\\[input-too-large\\]: ${label} exceeds`));
  }
});

test('JSON mode keeps stdout machine-readable and identical to the saved report', async (t) => {
  const w = await workspace(t);
  await put(w, 'expected.json', lost);
  await put(w, 'cmap.json', base);
  for (const [manifest, pdf, status] of [
    ['expected.json', 'plain.pdf', exitCodes.mismatch],
    ['cmap.json', 'predefined-cmap.pdf', exitCodes.passed],
  ] as const) {
    const output = `json-${basename(pdf, '.pdf')}`;
    const result = run(w, check(manifest, pdf, output, '--json'));
    assert.equal(result.status, status, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout),
      await readReport(w.file(`${output}/${reportFiles.json}`)),
    );
    assert.match(result.stderr, /^PrintWitness check: /, 'the human summary moves to stderr');
  }
  // Library diagnostics written with console.log/info must not reach stdout.
  const faulty = run(
    w,
    check('cmap.json', 'predefined-cmap.pdf', 'json-fault', '--json'),
    {
      PW_FAULT: 'resource-missing',
    },
    true,
  );
  assert.equal(faulty.status, exitCodes.incomplete);
  assert.equal(JSON.parse(faulty.stdout).status, 'unverifiable');
  assert.match(faulty.stderr, /simulated library noise via console\.log/);
  assert.match(faulty.stderr, /simulated library noise via console\.info/);
});

test('unavailable PDF.js resources are reported as incomplete, never as success', async (t) => {
  const w = await workspace(t);
  await put(w, 'cmap.json', base);
  const result = run(
    w,
    check('cmap.json', 'predefined-cmap.pdf', 'out'),
    { PW_FAULT: 'resource-missing' },
    true,
  );
  assert.equal(result.status, exitCodes.incomplete, result.stderr);
  assert.match(result.stdout, /PDF runtime resource unavailable:.*UniJIS-UCS2-H\.bcmap/);
  const report = await readReport(w.file(`out/${reportFiles.json}`));
  assert.equal(report.status, 'unverifiable');
  assert(report.findings.every((f) => /Processing is incomplete/.test(f.reason)));
});

test('existing reports are never overwritten, even partially', async (t) => {
  const w = await workspace(t);
  await put(w, 'expected.json', found);
  assert.equal(run(w, check('expected.json', 'plain.pdf', 'out')).status, exitCodes.passed);
  const original = await readFile(w.file(`out/${reportFiles.json}`));
  const again = run(w, check('expected.json', 'plain.pdf', 'out'));
  assert.equal(again.status, exitCodes.error);
  assert.match(again.stderr, /error\[output-exists\]: Refusing to overwrite/);
  assert.deepEqual(await readFile(w.file(`out/${reportFiles.json}`)), original);
  // A single leftover report name blocks the run before anything is written.
  await mkdir(w.file('partial'));
  await put(w, `partial/${reportFiles.html}`, 'precious');
  const blocked = run(w, check('expected.json', 'plain.pdf', 'partial'));
  assert.equal(blocked.status, exitCodes.error);
  assert.deepEqual(await readdir(w.file('partial')), [reportFiles.html]);
  assert.equal(await readFile(w.file(`partial/${reportFiles.html}`), 'utf8'), 'precious');
  // An existing directory with unrelated content is fine.
  await mkdir(w.file('shared'));
  await put(w, 'shared/notes.txt', 'keep');
  assert.equal(run(w, check('expected.json', 'plain.pdf', 'shared')).status, exitCodes.passed);
  assert.equal(await readFile(w.file('shared/notes.txt'), 'utf8'), 'keep');
});

test('a failed write reports an error and leaves no report or staging file', async (t) => {
  const w = await workspace(t);
  await put(w, 'expected.json', found);
  const result = run(
    w,
    check('expected.json', 'plain.pdf', 'out/new'),
    { PW_FAULT: 'html-write' },
    true,
  );
  assert.equal(result.status, exitCodes.error);
  assert.match(result.stderr, /error\[output-failed\]: Could not save reports/);
  assert.equal(result.stdout, '');
  assert.deepEqual(await readdir(w.dir).then((names) => names.filter((n) => n === 'out')), []);
  // Into an existing directory only this run's files are removed.
  await mkdir(w.file('kept'));
  await put(w, 'kept/notes.txt', 'keep');
  const again = run(
    w,
    check('expected.json', 'plain.pdf', 'kept', '--json'),
    { PW_FAULT: 'html-write' },
    true,
  );
  assert.equal(again.status, exitCodes.error);
  assert.equal(again.stdout, '');
  assert.deepEqual(await readdir(w.file('kept')), ['notes.txt']);
});

test('an unwritable output directory is an error, not a saved report', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const w = await workspace(t);
  await put(w, 'expected.json', found);
  await mkdir(w.file('locked'));
  await chmod(w.file('locked'), 0o500);
  try {
    const result = run(w, check('expected.json', 'plain.pdf', 'locked'));
    assert.equal(result.status, exitCodes.error);
    assert.match(result.stderr, /error\[output-failed\]/);
    assert.deepEqual(await readdir(w.file('locked')), []);
  } finally {
    await chmod(w.file('locked'), 0o700);
  }
});

test('SIGTERM during PDF analysis exits 143 and writes nothing', {
  skip: process.platform === 'win32',
}, async (t) => {
  const w = await workspace(t);
  await put(w, 'cmap.json', base);
  const child = spawn(
    process.execPath,
    ['--import', preload, cli, ...check('cmap.json', 'predefined-cmap.pdf', 'out')],
    { cwd: w.dir, env: { ...process.env, PW_FAULT: 'resource-hang', PW_MARKER: w.file('marker') } },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d;
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const exit = new Promise<number | null>((done) => child.once('close', (code) => done(code)));
  for (
    let i = 0;
    i < 300 &&
    !(await stat(w.file('marker')).then(
      () => true,
      () => false,
    ));
    i++
  )
    await new Promise((done) => setTimeout(done, 100));
  await stat(w.file('marker'));
  child.kill('SIGTERM');
  assert.equal(await exit, 143, stderr);
  assert.equal(stdout, '');
  assert.match(stderr, /Interrupted by SIGTERM\. No reports were written\./);
  assert.deepEqual(
    (await readdir(w.dir)).filter((n) => n.startsWith('out')),
    [],
  );
});

test('CLI reports are semantically identical to the core and to the local server', async (t) => {
  const w = await workspace(t);
  const cases: [string, Manifest, string][] = [
    ['found', found, 'plain.pdf'],
    ['lost', lostAndAmbiguous, 'plain.pdf'],
    ['cmap', base, 'predefined-cmap.pdf'],
    ['textless', found, 'textless.pdf'],
  ];
  const server = await startServer({ port: 0 });
  t.after(() => server.close());
  for (const [name, manifest, pdf] of cases) {
    await put(w, `${name}.json`, manifest);
    const result = run(w, check(`${name}.json`, pdf, `out-${name}`));
    assert.notEqual(result.status, exitCodes.error, result.stderr);
    const viaCli = await readReport(w.file(`out-${name}/${reportFiles.json}`));
    const bytes = await readFile(w.file(pdf));
    const { index } = await analyzePdf(bytes);
    const viaCore = compare(parseManifest(manifest), index, { name: pdf, sha256: sha256(bytes) });
    assert.deepEqual(semantic(viaCli), semantic(viaCore));
    const response = await fetch(`${server.url}/api/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PrintWitness': '1' },
      body: JSON.stringify({ manifest, name: pdf, pdf: bytes.toString('base64') }),
    });
    assert.deepEqual(
      semantic(((await response.json()) as { report: Report }).report),
      semantic(viaCli),
    );
  }
});

test('help prints usage with the exit-code contract', async (t) => {
  const w = await workspace(t);
  const result = run(w, ['--help']);
  assert.equal(result.status, exitCodes.passed);
  assert.match(result.stdout, /^Usage: node src\/node\/cli\.ts check/);
  assert.match(result.stdout, /3 {2}invalid arguments/);
  assert.equal(result.stderr, '');
});
