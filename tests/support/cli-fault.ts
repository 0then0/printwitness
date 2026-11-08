// Preloaded into CLI subprocesses with `node --import`. It injects one deterministic
// file-system fault so the public entry point can be tested without test-only product hooks.
//   PW_FAULT=resource-missing  reading the UniJIS-UCS2-H CMap fails with ENOENT
//   PW_FAULT=resource-hang     the same read never completes; PW_MARKER is written first
//   PW_FAULT=html-write        writing the HTML report fails after the JSON report was staged
import { writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const fault = process.env.PW_FAULT;
const { readFile, writeFile } = fsp;
const isCMap = (path: unknown) => String(path).endsWith('UniJIS-UCS2-H.bcmap');

fsp.readFile = (async (...args: Parameters<typeof readFile>) => {
  if (isCMap(args[0]) && fault === 'resource-missing') {
    // Library diagnostics that Node would otherwise send to stdout.
    console.log('simulated library noise via console.log');
    console.info('simulated library noise via console.info');
    throw Object.assign(new Error('ENOENT: simulated missing PDF.js resource'), { code: 'ENOENT' });
  }
  if (isCMap(args[0]) && fault === 'resource-hang') {
    writeFileSync(process.env.PW_MARKER ?? '', 'reading');
    setInterval(() => {}, 1000); // keep the process alive until a signal arrives
    await new Promise(() => {});
  }
  return readFile(...args);
}) as typeof readFile;
fsp.writeFile = (async (...args: Parameters<typeof writeFile>) => {
  if (fault === 'html-write' && String(args[0]).includes('printwitness-report.html'))
    throw Object.assign(new Error('ENOSPC: simulated full disk'), { code: 'ENOSPC' });
  return writeFile(...args);
}) as typeof writeFile;
syncBuiltinESMExports();
