import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Report } from '../src/core/types.ts';
import { chromium } from '../src/node/source.ts';

export async function validatePagination() {
  const fixture = new URL('../fixtures/pagination/', import.meta.url);
  const cli = fileURLToPath(new URL('../src/node/cli.ts', import.meta.url));
  const source = await readFile(new URL('source.html', fixture), 'utf8');
  const manifestPath = fileURLToPath(new URL('manifest.json', fixture));
  const output = await mkdtemp(resolve('artifacts/validation/pagination-'));
  const browser = await chromium.launch({ args: ['--disable-logging'] });
  try {
    const page = await browser.newPage({ offline: true });
    const offline = await browser.newPage({ offline: true });
    await page.setContent(source);
    for (const [variant, pages, headingPage, countStatus, headingStatus, exit] of [
      ['correct', 2, 2, 'found', 'found', 0],
      ['leading-page', 3, 3, 'mismatch', 'manual', 1],
      ['moved-heading', 2, 1, 'found', 'mismatch', 1],
    ] as const) {
      await page.evaluate((variant) => {
        document.documentElement.dataset.variant = variant;
      }, variant);
      const pdf = join(output, `${variant}.pdf`);
      await page.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true, tagged: true });

      const reports = join(output, variant);
      const result = spawnSync(
        process.execPath,
        [cli, 'check', '--manifest', manifestPath, '--pdf', pdf, '--output', reports, '--json'],
        { encoding: 'utf8', timeout: 60_000 },
      );
      assert.ifError(result.error);
      assert.equal(result.status, exit, `${variant}: ${result.stderr}`);
      const json = await readFile(join(reports, 'printwitness-report.json'), 'utf8');
      assert.equal(result.stdout, json);
      const report = JSON.parse(json) as Report;
      assert.equal(report.status, exit === 0 ? 'found' : 'mismatch');
      assert.equal(report.pdf.pageCount, pages);
      assert.equal(report.findings.length, 2);
      const [count, heading] = report.findings;
      assert.equal(count.kind, 'page-count');
      assert.equal(count.expectedPageCount, 2);
      assert.equal(count.actualPageCount, pages);
      assert.equal(count.status, countStatus, count.reason);
      assert.match(count.reason, countStatus === 'found' ? /expected number/ : /differs/);
      assert.equal(heading.kind, 'heading-page');
      assert.equal(heading.expected, 'Release approval');
      assert.equal(heading.expectedPage, 2);
      assert.deepEqual(heading.actualPages, [headingPage]);
      assert.equal(heading.status, headingStatus, heading.reason);
      assert.match(
        heading.reason,
        /expected PDF page|different PDF page|lack usable extracted text/,
      );

      await offline.goto(pathToFileURL(join(reports, 'printwitness-report.html')).href);
      assert.equal(await offline.locator('figure').count(), pages);
      for (const finding of [count, heading]) {
        const item = offline
          .locator('li')
          .filter({ has: offline.locator(`[data-finding="${finding.id}"]`) });
        assert.equal(await item.getAttribute('class'), finding.status);
        assert.equal(await item.locator('small').textContent(), finding.reason);
      }
      const countItem = (await offline.locator('li').nth(0).textContent()) ?? '';
      assert(countItem.includes('Expected page count: 2'));
      assert(countItem.includes(`Actual page count: ${pages}`));
      const headingItem = (await offline.locator('li').nth(1).textContent()) ?? '';
      assert(headingItem.includes('Release approval'));
      assert(headingItem.includes('Expected page: 2'));
      assert(headingItem.includes(`Detected pages: ${headingPage}`));
      assert.equal(
        await offline.locator(`[data-finding="${heading.id}"]`).getAttribute('href'),
        `#page-${headingPage}`,
      );
      console.log(
        `Pagination ${variant}: ${pages} pages, heading on ${headingPage}, ${countStatus}/${headingStatus}, exit ${exit}`,
      );
    }
    console.log(`Pagination PDFs and CLI reports: ${output}`);
  } finally {
    await browser.close();
  }
}
