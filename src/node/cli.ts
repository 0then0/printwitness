import { randomUUID } from 'node:crypto';
import { constants as fsConstants, realpathSync } from 'node:fs';
import { link, lstat, mkdir, open, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compare } from '../core/compare.ts';
import { parseManifest } from '../core/manifest.ts';
import type { Report, Status } from '../core/types.ts';
import { sha256 } from './hash.ts';
import { maxJsonBytes, maxPdfBytes } from './limits.ts';
import { reportHtml } from './report.ts';

/** Process exit codes of `printwitness check`; interruption exits with 128 + signal number. */
export const exitCodes = { passed: 0, mismatch: 1, incomplete: 2, error: 3 } as const;
export const reportFiles = {
  json: 'printwitness-report.json',
  html: 'printwitness-report.html',
} as const;

const usage = `Usage: node src/node/cli.ts check --manifest <file> --pdf <file> --output <dir> [--json]

Compare a finished PDF with a saved PrintWitness manifest and write
${reportFiles.json} and ${reportFiles.html} to <dir>.

Options:
  --manifest <file>  Frozen printwitness/1 manifest (read only)
  --pdf <file>       PDF to check (read only, up to 25 MiB)
  --output <dir>     Report directory; created if missing, never overwritten
  --json             Print the JSON report to stdout instead of the text summary
  -h, --help         Show this help

Exit codes:
  0  every applicable check was found in the PDF text layer
  1  confirmed violation (at least one mismatch)
  2  manual review needed or check incomplete (manual or unverifiable, no mismatch)
  3  invalid arguments, unreadable input, invalid manifest or failed report output
  128+n  interrupted by signal n (130 for SIGINT, 143 for SIGTERM)
`;

class CliError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
class Interrupted extends Error {
  signal: 'SIGINT' | 'SIGTERM';
  constructor(signal: 'SIGINT' | 'SIGTERM') {
    super(`Interrupted by ${signal}.`);
    this.signal = signal;
  }
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const exitFor = (status: Status) =>
  status === 'found'
    ? exitCodes.passed
    : status === 'mismatch'
      ? exitCodes.mismatch
      : exitCodes.incomplete;

// Reject oversized or non-regular files before and while reading them into memory.
async function readInput(path: string, limit: number, label: string): Promise<Buffer> {
  const tooLarge = () =>
    new CliError('input-too-large', `${label} exceeds ${limit / 1024 / 1024} MiB: ${path}`);
  try {
    // O_NONBLOCK keeps a FIFO from stalling open(); it is not defined on Windows.
    const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile())
        throw new CliError('input-not-file', `${label} is not a regular file: ${path}`);
      if (info.size > limit) throw tooLarge();
      const buffer = Buffer.allocUnsafe(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== info.size)
        throw new CliError('input-unreadable', `${label} changed while it was read: ${path}`);
      return buffer.subarray(0, length);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (['ENOENT', 'ENOTDIR'].includes(errno(error) ?? ''))
      throw new CliError('input-not-found', `${label} not found: ${path}`);
    throw new CliError(
      'input-unreadable',
      `Cannot read ${label} ${path}: ${errno(error) ?? (error as Error).message}`,
    );
  }
}

function readManifest(bytes: Buffer, path: string) {
  let value: unknown;
  try {
    // The default decoder strips a UTF-8 BOM; fatal rejects invalid sequences.
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new CliError('manifest-invalid', `Invalid manifest: ${path} is not valid UTF-8 JSON.`);
  }
  try {
    return parseManifest(value);
  } catch (error) {
    throw new CliError('manifest-invalid', `${(error as Error).message} (${path})`);
  }
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error) => {
      if (errno(error) === 'ENOENT') return false;
      throw error;
    },
  );

// Fail before the expensive analysis if the report names are already taken.
async function assertOutputFree(directory: string) {
  try {
    if (!(await stat(directory)).isDirectory())
      throw new CliError(
        'output-exists',
        `Output path exists and is not a directory: ${directory}`,
      );
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (errno(error) === 'ENOENT') return;
    throw new CliError('output-failed', `Cannot use output ${directory}: ${errno(error)}`);
  }
  for (const name of Object.values(reportFiles))
    if (await exists(join(directory, name)))
      throw new CliError(
        'output-exists',
        `Refusing to overwrite ${join(directory, name)}. Choose a new --output directory.`,
      );
}

/**
 * Stage every file under a temporary name, then link it to its final name. link() fails
 * if the name appeared in the meantime, so an existing report is never replaced and a
 * partially written file never carries a report name. All staged files are removed on error.
 */
async function writeReports(directory: string, contents: Record<string, string>) {
  const created = await mkdir(directory, { recursive: true }).catch((error) => {
    throw new CliError('output-failed', `Cannot create ${directory}: ${errno(error)}`);
  });
  const temporary: string[] = [];
  const published: string[] = [];
  try {
    for (const [name, text] of Object.entries(contents)) {
      const path = join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
      temporary.push(path);
      await writeFile(path, text, { flag: 'wx' });
    }
    for (const [index, name] of Object.keys(contents).entries()) {
      const target = join(directory, name);
      try {
        await link(temporary[index], target);
      } catch (error) {
        if (errno(error) === 'EEXIST')
          throw new CliError('output-exists', `Refusing to overwrite ${target}.`);
        // File systems without hard links: fall back to a checked rename.
        if (!['ENOTSUP', 'EPERM', 'ENOSYS', 'EXDEV'].includes(errno(error) ?? '')) throw error;
        if (await exists(target))
          throw new CliError('output-exists', `Refusing to overwrite ${target}.`);
        await rename(temporary[index], target);
      }
      published.push(target);
    }
  } catch (error) {
    for (const path of published) await unlink(path).catch(() => {});
    for (const path of temporary) await unlink(path).catch(() => {});
    // Remove only directories this run created, innermost first.
    if (created)
      for (let at = directory; ; at = dirname(at)) {
        if (
          !(await rmdir(at).then(
            () => true,
            () => false,
          )) ||
          at === created
        )
          break;
      }
    if (error instanceof CliError) throw error;
    throw new CliError(
      'output-failed',
      `Could not save reports in ${directory}: ${errno(error) ?? (error as Error).message}`,
    );
  }
  for (const path of temporary) await unlink(path).catch(() => {});
}

// pdfjs-dist is loaded here, not at module load: without installed dependencies Node would
// otherwise exit with code 1, which this command reserves for a confirmed violation.
async function loadAnalyzer() {
  try {
    return (await import('./pdf.ts')).analyzePdf;
  } catch (error) {
    throw new CliError(
      'dependency-unavailable',
      `PDF.js cannot be loaded (${(error as Error).message.split('\n')[0]}). Run npm ci in the PrintWitness checkout.`,
    );
  }
}

function interruptible<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise((done, fail) => {
    if (signal.aborted) return fail(signal.reason);
    const onAbort = () => fail(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(done, fail).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const plain = (value: string, max = 140) => {
  const text = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
function summary(report: Report, directory: string, code: number) {
  const tally = { found: 0, mismatch: 0, manual: 0, unverifiable: 0, excluded: 0 };
  for (const f of report.findings) tally[f.excluded ? 'excluded' : f.status]++;
  const open = report.findings.filter((f) => !f.excluded && f.status !== 'found');
  const lines = [
    `PrintWitness check: ${report.status} (exit ${code})`,
    `PDF: ${plain(report.pdf.name)} · ${report.pdf.pages.length} pages · sha256 ${report.pdf.sha256}`,
    `Findings: ${tally.found} found, ${tally.mismatch} mismatch, ${tally.manual} manual, ${tally.unverifiable} unverifiable, ${tally.excluded} excluded`,
  ];
  for (const f of open.slice(0, 20))
    lines.push(
      `  ${f.status}: [${plain(f.section, 60)}] ${plain(f.expected)} (${f.id}) — ${plain(f.reason, 200)}`,
    );
  if (open.length > 20) lines.push(`  … ${open.length - 20} more in the JSON report.`);
  lines.push(
    `Reports: ${join(directory, reportFiles.json)}`,
    `         ${join(directory, reportFiles.html)}`,
    'Text-layer check only: visibility, overlap and layout are not verified.',
  );
  return `${lines.join('\n')}\n`;
}

const options = {
  manifest: { type: 'string', multiple: true },
  pdf: { type: 'string', multiple: true },
  output: { type: 'string', multiple: true },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;
function parse(argv: string[]) {
  const { values, positionals } = (() => {
    try {
      return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    } catch (error) {
      throw new CliError('usage', (error as Error).message);
    }
  })();
  if (values.help) return { help: true as const };
  if (positionals.length !== 1 || positionals[0] !== 'check')
    throw new CliError('usage', 'Expected the single command "check".');
  const one = (name: 'manifest' | 'pdf' | 'output') => {
    const list = values[name] ?? [];
    if (list.length !== 1 || !list[0])
      throw new CliError('usage', `Provide --${name} exactly once with a non-empty value.`);
    return resolve(list[0]);
  };
  return {
    help: false as const,
    manifest: one('manifest'),
    pdf: one('pdf'),
    output: one('output'),
    json: !!values.json,
  };
}

const write = (stream: NodeJS.WriteStream, text: string) =>
  new Promise<void>((done) => {
    stream.write(text, () => done());
  });

export async function main(argv: string[]): Promise<number> {
  // PDF.js reports recoverable problems through console.log; keep stdout machine-readable.
  for (const method of ['log', 'info', 'debug'] as const)
    console[method] = (...args: unknown[]) => console.error(...args);
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
  const controller = new AbortController();
  const listeners = (['SIGINT', 'SIGTERM'] as const).map((name) => {
    const listener = () => {
      // A second signal means the user does not want to wait for cleanup.
      if (controller.signal.aborted) process.exit(128 + osConstants.signals[name]);
      controller.abort(new Interrupted(name));
    };
    process.on(name, listener);
    return [name, listener] as const;
  });
  try {
    const args = parse(argv);
    if (args.help) {
      await write(process.stdout, usage);
      return exitCodes.passed;
    }
    await assertOutputFree(args.output);
    const manifest = readManifest(
      await readInput(args.manifest, maxJsonBytes, 'Manifest'),
      args.manifest,
    );
    const pdf = await readInput(args.pdf, maxPdfBytes, 'PDF');
    controller.signal.throwIfAborted();
    const analyzePdf = await loadAnalyzer();
    const { index, images } = await interruptible(controller.signal, analyzePdf(pdf));
    const report = compare(manifest, index, {
      name: basename(args.pdf).slice(0, 500),
      sha256: sha256(pdf),
    });
    controller.signal.throwIfAborted();
    const json = `${JSON.stringify(report, null, 2)}\n`;
    await writeReports(args.output, {
      [reportFiles.json]: json,
      [reportFiles.html]: reportHtml(report, images),
    });
    const code = exitFor(report.status);
    const text = summary(report, args.output, code);
    if (args.json) {
      await write(process.stderr, text);
      await write(process.stdout, json);
    } else await write(process.stdout, text);
    return code;
  } catch (error) {
    if (error instanceof Interrupted) {
      await write(process.stderr, `printwitness: ${error.message} No reports were written.\n`);
      return 128 + osConstants.signals[error.signal];
    }
    const failure =
      error instanceof CliError
        ? error
        : new CliError('internal-error', error instanceof Error ? error.message : String(error));
    await write(
      process.stderr,
      `printwitness: error[${failure.code}]: ${failure.message}\n${failure.code === 'usage' ? `\n${usage}` : ''}`,
    );
    return exitCodes.error;
  } finally {
    for (const [name, listener] of listeners) process.off(name, listener);
  }
}

// Compare real paths: Node resolves symlinks in import.meta.url, so a symlinked checkout or
// temporary directory would otherwise skip main() and exit 0 without checking anything.
const entry = process.argv[1] && realpathSync(resolve(process.argv[1]));
if (entry && entry === realpathSync(fileURLToPath(import.meta.url)))
  process.exit(await main(process.argv.slice(2)));
