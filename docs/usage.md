# Usage guide

## Choose a source

Enter an absolute `.html` or `.htm` path, a `file:` URL, or an HTTP(S) URL on `localhost`, `127.0.0.1` or `[::1]`. Local file assets must remain inside the HTML file's directory, including resolved symlink targets. Localhost pages can load resources only from their own origin.

PrintWitness executes source scripts to capture dynamic content. It reads the source without changing it. Remote fonts, CDNs and data services are unavailable during capture and printing; provide local copies.

## Select required content

Enter one CSS selector per line. Every matched element becomes a section. Select disjoint elements: a section and its descendant table cannot both be selected.

A selected element needs an `h1`–`h6` heading inside it or preceding it. Prefer a containing section with its own unique heading. A table can be selected directly when it is the only table under that heading. If several tables share a heading, select their containing section or give each table a separate heading.

Text blocks become individual expectations. Table rows retain their ordered cell values. Table headers are required once; repeated printed header copies cannot replenish missing body records. Links retain both their labels and destinations.

## Wait for dynamic content

Choose one readiness mode:
- **DOM and fonts:** wait for DOM content and loaded fonts. This does not establish that asynchronous data is complete.
- **CSS selector:** wait for a matching element to be attached. Choose a selector that appears only after all required data has arrived.
- **Global signal:** wait for a named window property to equal `true`, for example `window.PRINTWITNESS_READY = true`.

The timeout must be between 100 and 60,000 ms. The readiness deadline covers navigation, the selected condition and fonts. PDF export has its own bounded timeout. Capture and printing each reload the source and wait independently.

## Freeze expectations and exclusions

Specify intentional CSS exclusions before capture. Contextual selectors such as `#required .screen-note` are supported. Exclusions are evaluated in the original DOM context. Hidden DOM text is otherwise still expected.

Click **Freeze manifest**, then inspect the checklist. Before checking, an individual expectation can also be excluded with an explicit reason. Exclusions remain in the manifest and report and never count as successes.

Download the manifest to reuse it independently of the source. Importing a manifest validates its structure without executing source scripts or opening paths from that manifest. An older manifest without DOM boundary context remains readable, but cannot establish a positive section match; capture a new manifest for current matching.

## Check and inspect

**Create PDF** reloads the current source with print media and compares the export with the frozen manifest. Changes since capture are compared to that original baseline. **Check PDF** compares an uploaded PDF with the same expectations and needs no source access.

Select a check to see its expected text, explanation, URL details and available evidence. Evidence highlights extraction-item coordinates, which can cover more than the precise matching characters. Navigate pages independently of the selection. Use the status filter and search to inspect losses or uncertain results.

The four result states are:
- **Found in text layer:** an independent occurrence exists in established section context. Links additionally need a uniquely associated matching URL annotation. Visual integrity is unproven.
- **Mismatch:** required content is absent in established context, an independent repetition is missing, or a uniquely associated URL differs.
- **Manual review:** section context, cell geometry, reading order or link association is ambiguous. Missing text in a PDF with an empty-text page also requires inspection.
- **Unverifiable:** no usable text layer, unreadable or unsupported PDF, or no active expectations.

The overall result prioritizes mismatch, then unverifiable, then manual review, then found. An entirely excluded manifest is unverifiable.

## Export results

Download the checked PDF, JSON report or standalone HTML report. HTML exports include raster page previews, coordinate highlights and translated explanations, with no external assets. Select a finding to highlight its evidence. JSON preserves stable status values and English diagnostics for automation.

The local server retains at most three checked documents in memory. Restarting clears them. Export results explicitly if you need to keep them. Exports include expected text, page text, URLs and hashes; they are not redacted.

## Check a finished PDF from the command line

`check` compares a finished PDF with a saved manifest without starting the web interface or any HTTP server. It uses the same manifest parser, PDF.js extraction, comparator and standalone report as **Check PDF**. It does not open the source HTML, create a PDF, capture or replace a manifest, install anything or use the network.

Prepare the existing dependencies once, from the PrintWitness checkout. Node.js 24.13 or newer is required; Chromium is not (`npm run browsers` is only for capture and printing):

```sh
npm ci
```

In CI, a production install is enough: `npm ci --omit=dev --ignore-scripts`.

Run the entry point by its path. Relative `--manifest`, `--pdf` and `--output` values resolve against your current directory, so the command works from any project. Do not wrap it in `npm run`: npm changes the working directory to the checkout.

```sh
node /path/to/PrintWitness/src/node/cli.ts check \
  --manifest expected.json \
  --pdf invoice.pdf \
  --output artifacts/printwitness
```

The command prints a short result and the non-passing findings, then exits with a code. Add `--json` to print only the JSON report to stdout, identical to the saved file. The text summary then goes to stderr, together with every diagnostic and library warning, so stdout can be parsed directly. On any error stdout stays empty. `--help` prints the options.

### Output files

`--output` is created when missing and receives two files from the same run:
- `printwitness-report.json`: the report exported by the interface, including the manifest, PDF hash, findings and evidence coordinates.
- `printwitness-report.html`: the standalone report with embedded page previews, as exported by the interface.

Existing results are never replaced. If either file already exists the command stops with exit code 3 before reading the PDF, so use a new directory for each run. An existing directory with unrelated files is accepted. Files are staged under temporary names and published only when both are complete. After a write failure or interruption neither report name exists, no staging file remains, and no success is reported. The manifest and PDF are only read.

### Exit codes

- `0`: every applicable check is **found**. Excluded expectations are listed but do not count.
- `1`: confirmed violation. At least one finding is a **mismatch**.
- `2`: manual review or an incomplete check. No finding is a mismatch, but at least one is **manual** or **unverifiable**, including a manifest with only excluded expectations.
- `3`: invalid arguments, a missing or unreadable input, an invalid manifest, an oversized file, an existing report, a failed write or an unexpected failure. The `error[code]` on stderr names the cause: `usage`, `input-not-found`, `input-not-file`, `input-unreadable`, `input-too-large`, `manifest-invalid`, `dependency-unavailable`, `output-exists`, `output-failed` or `internal-error`.
- `128` plus the signal number (130 for SIGINT, 143 for SIGTERM): interrupted before any report was saved.

The exit code follows the overall status of the report, which keeps the interface's priority: mismatch, then unverifiable, then manual review, then found. When a report contains a mismatch together with manual or unverifiable findings, the exit code is `1`; the JSON report and the HTML report still list every finding with its own status.

### Incomplete results

Exit code `2` is neither a pass nor proof of lost content. Open the HTML report, read each reason and inspect the pages. A damaged or unsupported PDF, a PDF without a text layer, rotated text and a missing PDF.js resource (CMap, standard font or WASM) all produce **unverifiable** findings with the cause in `reason`; a damaged file is not reported as a mismatch. Ambiguous section boundaries, row geometry or link association produce **manual** findings. Reinstall the dependencies if a resource is unavailable. Do not treat code `2` as success by default; accept it only after someone has reviewed the report.

### Limits

Success means that the text-layer content contract of the manifest holds in this PDF. It does not prove that text is visible, unclipped or unobscured, that glyphs look right or that the layout is correct. See the [matching reference](matching.md).

The limits of the interface apply: at most 25 MiB per PDF, 100 pages, 100 sections and 10,000 expectations. A manifest file may be up to 40 MiB. Size and file type are checked before a file is read into memory.

### Manifest ownership

The manifest is frozen separately, before the PDF is generated, with **Freeze manifest** in the interface. Keep it in version control or next to the build inputs. `check` never writes, updates or accepts a manifest. When the expected content changes intentionally, capture and review a new manifest deliberately; do not regenerate it from the PDF being checked.

### CI example

This GitHub Actions job generates the PDF, runs the check and uploads the reports even when the check fails. Replace the pinned revision with the PrintWitness commit you have reviewed:

```yaml
jobs:
  pdf-content:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
      - run: ./build-invoice-pdf.sh # writes build/invoice.pdf
      - uses: actions/checkout@v7
        with:
          repository: 0then0/PrintWitness
          ref: <reviewed commit SHA>
          path: .printwitness
      - uses: actions/setup-node@v7
        with:
          node-version: "24"
      - run: npm ci --omit=dev --ignore-scripts
        working-directory: .printwitness
      - run: |
          node .printwitness/src/node/cli.ts check \
            --manifest tests/invoice.manifest.json \
            --pdf build/invoice.pdf \
            --output artifacts/printwitness
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: printwitness-report
          path: artifacts/printwitness
          if-no-files-found: ignore
```

The step fails for codes `1`, `2` and `3`. To tolerate only incomplete results, handle `2` explicitly in the shell and keep `1` and `3` as failures. Reports contain document text and hashes; do not upload them from private documents to public CI.

## External PDF runtime resources

PDF.js reads CMaps, standard fonts and image decoder data from the installed application, without CDN access. Some PDFs require a predefined CMap to interpret their text. Version 0.1.2 checks this path with a synthetic horizontal `UniJIS-UCS2-H` document containing 日本語; this is not a claim of complete CJK or arbitrary PDF support.

At module initialization the application resolves the same installed PDF.js entry point used for extraction. It does not require every optional resource to be readable before accepting any document. During processing, the local `BinaryDataFactory` reads requested CMaps, standard-font data and WASM. A failed or empty resource read is retained even when PDF.js catches the error and continues. The report then says **PDF runtime resource unavailable**, identifies the requested resource and marks active checks **Unverifiable**, including when some text survived. Reinstall the complete application rather than treating this as evidence of missing PDF content. Unused missing resources do not fail unrelated PDFs.

A PDF with no extracted text and no detected processing failure is reported separately as having no usable text layer; OCR remains outside v0.1. Parsing/extraction failures are reported as unreadable or unsupported PDFs. Preview failures have page warnings. This does not detect every recovery or warning inside PDF.js: its API provides no complete processing-success contract, and decoder JavaScript fallback imports are outside `BinaryDataFactory`. A successful text comparison still does not prove visible content, absence of clipping/overlap, correct glyph appearance or PDF accessibility. Rotated and vertical text still require manual inspection.
