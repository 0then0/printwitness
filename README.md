<p align="center">
  <img src="public/icon.svg" width="144" height="108" alt="HTML content transferred to PDF, with a missing line marked" />
</p>

# PrintWitness

[![CI](https://img.shields.io/github/actions/workflow/status/0then0/PrintWitness/ci.yml?branch=main&label=CI)](https://github.com/0then0/PrintWitness/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-54534f)](LICENSE)

Check whether required HTML text, table records and link destinations survive a PDF export. Freeze the expectations before printing, then compare a Chromium export or an existing text PDF with the same portable manifest.

PrintWitness runs locally. Its workspace combines a checklist, rendered document pages and finding details. Reports export as JSON or standalone HTML with embedded page previews.

![PrintWitness workspace showing a missing table record beside the PDF and its finding details](docs/images/workspace.png)

**A text-layer match does not prove that content is visible.** Clipping, overlays, transparency and white-on-white text are not universally detected. Inspect the rendered pages before accepting the layout.

## Standalone application

Standalone packages include Node.js, Playwright, Chromium and the built interface. Launch PrintWitness with one click; Git, npm and a separate Chromium installation are not required. Portable and installation packages use the same prepared application.

Download packages and `SHA256SUMS.txt` from [GitHub Releases](https://github.com/0then0/PrintWitness/releases/latest). See the [changelog](CHANGELOG.md) for changes between versions. Applications are unsigned; macOS packages are not notarized.

See [standalone installation and packaging](docs/desktop.md) for macOS ZIP/DMG, Windows ZIP/installer and Ubuntu archive/Debian packages. The [Desktop workflow](.github/workflows/desktop.yml) builds and tests native distributions and stores them as CI artifacts. It does not publish releases automatically.

## Install from source

Use Node.js **24.13 or newer** and npm. Run these commands from the project directory:

```sh
npm ci
npm run browsers
npm run build
npm start
```

Open [127.0.0.1:4173](http://127.0.0.1:4173). On Linux, install Chromium's system dependencies with `npm run browsers -- --with-deps`; this may require administrator privileges. Browser binaries and npm cache default to the ignored `.local-browsers/` and `.npm-cache/` directories. `PLAYWRIGHT_BROWSERS_PATH` can override the browser location.

For development use `npm run dev`. Set `PORT` to change the local server port.

## Quickstart

1. Click **Open example**, or enter an absolute HTML path or localhost URL.
2. Enter CSS selectors for the required sections or tables. The example uses `#summary`, `#register` and `#terms`.
3. Choose how to wait for the page. For asynchronous data, use an explicit selector or global readiness signal with a bounded timeout.
4. Set intentional exclusions, then click **Freeze manifest**. Review the expectations and download the manifest.
5. Click **Create PDF**, or use **Check PDF** to select an existing text PDF. Both operations check against the frozen expectations. Required PDF.js resources are read from the local application; unavailable resources produce an explicit unverifiable result. See [external PDF diagnostics](docs/usage.md#external-pdf-runtime-resources).
6. Select a finding to inspect its explanation and page coordinates. Export the JSON report, standalone HTML report and checked PDF.

Capturing again creates a new baseline. Printing never silently replaces it. Keep the manifest, PDF and report together.

Choose System, Light or Dark in the theme selector. System follows your operating system automatically; explicit choices are saved locally. PDF pages keep their original colors.

English is the default language. Spanish, German, French, Japanese, Brazilian Portuguese and Russian are also available. Interface text and HTML reports follow the selection; original content, URLs and machine-readable JSON remain unchanged.

See the [usage guide](docs/usage.md) for selectors, readiness, exclusions and report states, and the [matching reference](docs/matching.md) for the manifest contract and confidence limits.

## Check a finished PDF from the command line

Use `check` in CI after your build has produced the PDF. It compares the PDF with a manifest frozen earlier, without the web interface, an HTTP server, the source HTML, Chromium or network access. From the checkout, install the pinned dependencies once with `npm ci`, then run:

```sh
node /path/to/PrintWitness/src/node/cli.ts check \
  --manifest expected.json \
  --pdf invoice.pdf \
  --output artifacts/printwitness
```

It writes `printwitness-report.json` and the standalone `printwitness-report.html` to a new output directory and never overwrites existing reports. `--json` prints only the JSON report to stdout; the summary and diagnostics go to stderr. Exit codes:
- `0`: all applicable checks were found in the text layer.
- `1`: confirmed violation (mismatch); it takes priority over incomplete findings in the same report.
- `2`: manual review needed or the check is incomplete (manual or unverifiable). This is not a pass.
- `3`: invalid arguments, unreadable input, invalid manifest or failed report output.

Success proves the manifest's text-layer contract, not visible text or correct layout. `check` never creates or updates a manifest. See the [usage guide](docs/usage.md#check-a-finished-pdf-from-the-command-line) for incomplete results, limits and a CI example that keeps the reports when the check fails.

## Example report

The open [validation template](fixtures/validation.html) contains a long table with 96 records, repeated headings and mandatory text, Unicode content, a link and an asynchronous readiness signal. It has no external assets and is covered by this repository's Apache-2.0 license.

```sh
npm run validate
```

Open `artifacts/validation/broken.html` or `fixed.html` directly in a browser. The reports embed all page previews and work offline.
- The broken export has six confirmed mismatches: a missing row, one missing repetition, a hidden section with three expectations, and an altered link destination.
- The fixed export finds all 109 expectations against the **same manifest**.

A missing-row finding contains the expected record and its established context:

```json
{
  "kind": "row",
  "expected": "PW-042 Север · участок 042 1042,00 EUR Verified",
  "status": "mismatch",
  "reason": "Expected text/row is absent inside the established section boundaries.",
  "evidence": []
}
```

## Validation and development

```sh
npm run check
```

This runs Biome, strict TypeScript checking, the production build, core regression tests, real Chromium/PDF.js validation and browser interaction tests. Browser tests cover every supported language at desktop, tablet and narrow mobile widths. [Reproducible validation](docs/validation.md) describes the assertions and generated artifacts.

[CI](.github/workflows/ci.yml) runs the same checks on Ubuntu with Node.js 24 for pushes and pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md) for the code layout, formatting and translation workflow.

For bugs and feature requests, use the [issue forms](https://github.com/0then0/PrintWitness/issues/new/choose) with synthetic examples. Participation follows the [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities using [SECURITY.md](SECURITY.md), without posting exploit details or private documents publicly.

## External renderer case study

The [WeasyPrint #2469 lab](docs/case-studies/weasyprint-2469.md) reproduces real content loss across pinned parent/fix revisions, independently checked by extraction, page inspection and the upstream regression. One frozen manifest gives `manual` for the buggy PDF because its section end boundary also disappears, and `found` for the fixed PDF. This is a documented conservative result, not confirmed automatic loss detection or evidence of adoption by WeasyPrint.

## Limits and privacy

PrintWitness v0.1 supports text PDFs, mandatory DOM text, ordinary table rows and URL annotations. It does not provide OCR, AI analysis, automatic layout repair, PDF/A validation, accounts or a hosted service.

The server binds to loopback. Source files are read without modification, and source content is not sent to external services. Dynamic source scripts execute in a disposable Chromium context with restricted networking. Remote assets must be made local first. Use trusted local documents; see the [security model](SECURITY.md) for the exact boundary.

Ambiguous section boundaries, wrapped or merged table cells, combined link-label items, unusual reading order and unsupported text layouts require manual review. The limits are 25 MiB per PDF, 100 PDF pages, 100 selected sections and 10,000 expectations. Reports contain document content and should be handled with the same care as their sources.

## Dependency maintenance

[Dependabot](.github/dependabot.yml) checks npm and GitHub Actions monthly. Minor and patch version updates are grouped per ecosystem; major updates remain separate. Each ecosystem has one scheduled PR slot, for a combined maximum of two. Automerge is not configured. Security updates are separate from those groups and limits; repository administrators must keep Dependabot alerts and security updates enabled.

## License

[Apache-2.0](LICENSE), including the SVG icon and original validation template. The external lab's adapted fixture and embedded fonts have separate notices in [the lab attribution](scripts/labs/weasyprint-2469/NOTICE.md).
