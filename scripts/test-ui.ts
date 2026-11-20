import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from '../src/node/source.ts';
import { fixtureServer } from './fixture-server.ts';
import { testLocales } from './test-locales.ts';
import { testThemes } from './test-themes.ts';

const port = 4187;
const base = `http://127.0.0.1:${port}`;
const processServer = spawn(process.execPath, ['src/node/server.ts'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
processServer.stdout.on('data', (x) => {
  serverOutput += String(x);
});
processServer.stderr.on('data', (x) => {
  serverOutput += String(x);
});
const fixture = await fixtureServer();
const browser = await chromium.launch();
await mkdir('artifacts/ui', { recursive: true });
try {
  await new Promise<void>((done, reject) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      if (serverOutput.includes('PrintWitness v0.1')) done();
      else if (Date.now() > deadline || processServer.exitCode !== null)
        reject(new Error(serverOutput || 'Server startup timeout'));
      else setTimeout(poll, 50);
    };
    poll();
  });
  const malformedStatus = await new Promise<number | undefined>((done, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port, path: '//[', headers: { Host: `127.0.0.1:${port}` } },
      (res) => {
        res.resume();
        done(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(malformedStatus, 400);
  assert.equal((await fetch(base)).status, 200, 'server must survive malformed request targets');
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1050 },
    locale: 'es-ES',
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  assert.equal(
    await page.getByRole('button', { name: 'Quit PrintWitness', exact: true }).count(),
    0,
  );
  await page.getByRole('heading', { name: 'Is every required item still there?' }).waitFor();
  await page.getByLabel('HTML path or localhost URL').fill(fixture.url);
  await page.getByLabel('Page readiness').selectOption('signal');
  await page.getByLabel('Global signal name').fill('PRINTWITNESS_READY');
  await page.getByRole('button', { name: 'Freeze manifest', exact: true }).click();
  await page.getByRole('heading', { name: 'Expectations saved' }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Source & manifest' }).click();
  await page.getByLabel('HTML path or localhost URL').fill(`${fixture.url}?variant=broken`);
  await page.getByRole('button', { name: 'Create PDF', exact: true }).click();
  await page.getByTestId('report-status').waitFor({ timeout: 30000 });
  assert.equal(await page.getByTestId('report-status').textContent(), 'Mismatch');
  await page.getByLabel('Filter checks').selectOption('mismatch');
  assert.equal(await page.locator('.check').count(), 6);
  await page.locator('.check').filter({ hasText: 'PW-042' }).click();
  assert((await page.locator('.detail-content').textContent())?.includes('PW-042'));
  await page.getByLabel('Search checks').fill('missing text');
  assert.equal(await page.locator('.check').count(), 0);
  await page.getByLabel('Search checks').fill('');
  await page.screenshot({ path: 'artifacts/ui/broken-desktop.png', fullPage: true });
  // Download and parse real exported artifacts rather than only checking href values.
  const jsonDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: 'JSON report ↓' }).click();
  const jsonFile = await jsonDownload;
  await jsonFile.saveAs('artifacts/ui/exported-report.json');
  const exported = JSON.parse(await readFile('artifacts/ui/exported-report.json', 'utf8'));
  assert.equal(exported.status, 'mismatch');
  const htmlDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Standalone HTML report ↓' }).click();
  await (await htmlDownload).saveAs('artifacts/ui/exported-report.html');
  const offline = await browser.newPage();
  const requests: string[] = [];
  offline.on('request', (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  await offline.goto(`file://${resolve('artifacts/ui/exported-report.html')}`);
  assert.equal(await offline.locator('figure').count(), exported.pdf.pages.length);
  assert(
    await offline
      .locator('img')
      .evaluateAll((imgs) =>
        imgs.every(
          (img) => img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0,
        ),
      ),
  );
  await offline.locator('[data-finding]').first().click();
  assert.equal(requests.length, 0);
  await offline.close();
  await page.getByRole('button', { name: 'Source & manifest' }).click();
  await page.getByLabel('HTML path or localhost URL').fill(`${fixture.url}?variant=fixed`);
  await page.getByRole('button', { name: 'Create PDF', exact: true }).click();
  await page
    .getByText('Creating and checking PDF…', { exact: true })
    .waitFor({ state: 'hidden', timeout: 30000 });
  assert.equal(await page.getByTestId('report-status').textContent(), 'Found in text layer');
  await page.getByLabel('Filter checks').selectOption('all');
  await page.locator('.check').filter({ hasText: 'PW-096' }).click();
  assert((await page.locator('.paper rect').count()) > 0);
  await page.locator('.paper img').evaluate((img: HTMLImageElement) => img.decode());
  assert(
    await page
      .locator('.paper img')
      .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
  );
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.screenshot({ path: 'artifacts/ui/fixed-desktop.png', fullPage: true });
  // Import a pre-existing PDF against the same frozen manifest.
  await page
    .getByText('Check PDF', { exact: true })
    .locator('input')
    .setInputFiles(resolve('artifacts/validation/broken.pdf'));
  await page
    .getByText('Checking PDF…', { exact: true })
    .waitFor({ state: 'hidden', timeout: 30000 });
  assert.equal(await page.getByTestId('report-status').textContent(), 'Mismatch');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/ui/mobile.png', fullPage: true });
  assert(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'no horizontal overflow on mobile',
  );
  await testLocales(page, browser, base);
  await testThemes(page, browser, base);
  await page.getByRole('button', { name: 'Source & manifest' }).click();
  await page
    .getByText('Import manifest', { exact: true })
    .locator('input')
    .setInputFiles(resolve('artifacts/validation/internal-links-manifest.json'));
  await page.getByRole('heading', { name: 'Expectations saved' }).waitFor();
  await page
    .getByText('Check PDF', { exact: true })
    .locator('input')
    .setInputFiles(resolve('artifacts/validation/internal-links.pdf'));
  await page.getByTestId('report-status').waitFor();
  assert.equal(await page.getByTestId('report-status').textContent(), 'Found in text layer');
  await page
    .locator('.check')
    .filter({ hasText: 'Appendix A: Delivery terms' })
    .filter({ has: page.getByText('Link', { exact: true }) })
    .click();
  const detail = page.locator('.detail-content');
  assert.equal(await detail.getByRole('heading', { name: 'Expected heading' }).count(), 1);
  assert.equal(await detail.getByRole('heading', { name: 'Destination in PDF' }).count(), 1);
  assert.match((await detail.textContent()) ?? '', /p\. 1 · y [\d.]+ pt/);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  // Manifest import works independently of the original source path.
  await page.getByRole('button', { name: 'Source & manifest' }).click();
  await page
    .getByText('Import manifest', { exact: true })
    .locator('input')
    .setInputFiles(resolve('artifacts/validation/manifest.json'));
  await page.getByRole('heading', { name: 'Expectations saved' }).waitFor();
  await page.getByLabel('Exclusion reason', { exact: true }).fill('Explicit validation exclusion');
  await page.getByRole('button', { name: 'Exclude with reason' }).click();
  assert((await page.locator('.check-footer').textContent())?.includes('Explicitly excluded: 1'));
  await page.getByRole('button', { name: 'Make required' }).click();
  // Visible error state, preserving the last good manifest.
  await page.getByRole('button', { name: 'Source & manifest' }).click();
  await page.getByLabel('Section or table CSS selectors, one per line').fill('#missing-section');
  await page.getByRole('button', { name: 'Freeze manifest', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert((await page.getByRole('alert').textContent())?.includes('matches no elements'));
  await page.screenshot({ path: 'artifacts/ui/error-mobile.png', fullPage: true });
  // Keyboard focus, no console errors, and local API browser isolation.
  await page.keyboard.press('Tab');
  assert(await page.evaluate(() => document.activeElement !== document.body));
  assert.deepEqual(errors, []);
  const hostile = await fetch(`${base}/api/capture`, {
    method: 'POST',
    headers: {
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
      'X-PrintWitness': '1',
    },
    body: '{}',
  });
  assert.equal(hostile.status, 403);
  const noHeader = await fetch(`${base}/api/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(noHeader.status, 403);
  console.log(
    'UI: capture, broken/fixed print, frozen-manifest PDF import, evidence, JSON/HTML downloads, offline report, manifest import, exclusions, filters, mobile, keyboard, error state and API origin checks passed.',
  );
} catch (e) {
  console.error(serverOutput);
  throw e;
} finally {
  await browser.close();
  await fixture.close();
  processServer.kill('SIGTERM');
}
