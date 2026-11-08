# Changelog

Notable user-facing changes are recorded here. Release dates use UTC. Published packages and checksums are available on [GitHub Releases](https://github.com/0then0/PrintWitness/releases).

## [Unreleased]

### Added

- `node src/node/cli.ts check` compares a finished PDF with a saved manifest without the web interface, using the same parser, PDF.js analysis, comparator and standalone report. It writes JSON and HTML reports to a new output directory, supports `--json` for pure machine output, and exits with `0` (all found), `1` (mismatch), `2` (manual or unverifiable) or `3` (invalid arguments, input or output). See the [usage guide](docs/usage.md#check-a-finished-pdf-from-the-command-line).

### Changed

- Added repository editor/Git conventions, community policies, issue forms and a pull request template.
- Refined CI permissions, action pinning, concurrency, artifact scope and desktop build triggers.

## [0.1.2] - 2026-10-31

### Fixed

- Disable Chromium file logging so Windows runtime checks do not create `debug.log` inside the installation.

- Resolve PDF.js CMaps, standard fonts and WASM from the same installed dependency as the PDF engine, including relocated desktop packages and paths containing spaces or Unicode.
- Report failed runtime-resource reads as incomplete, unverifiable processing instead of silently diagnosing a missing text layer. Disable system-font fallback for reproducible local resource use.

### Added

- Original synthetic PDF controls and a predefined `UniJIS-UCS2-H` extraction/comparison regression for 日本語, including isolated missing-resource failures.
- Packaged CMap checks, resource inventory verification and an outgoing-network-blocked extraction pass in the existing desktop smoke test. This verifies a specific horizontal-text path, not complete CJK, OCR, visual or accessibility support.
- Runtime-resource diagnostics in all seven supported languages and external-PDF documentation.

## [0.1.1] - 2026-10-24

### Fixed

- Retry macOS DMG creation up to three times for `Resource busy`, removing partial images and preserving failures for other errors.
- Exclude external lab fixtures from desktop distributions so separately licensed test materials are not shipped without their notices.
- Reject mismatched PDF/report identities before external lab verification or packaging overwrites existing outputs.

### Added

- An isolated, reproducible WeasyPrint #2469 case study with pinned revisions, frozen expectations and independent extraction, rendering and upstream regression checks. The buggy PDF remains `manual` because its section end boundary is missing; the fixed PDF is `found` against the same manifest.
- Regressions for DMG failures, changed or swapped PDFs, stale manifests and desktop fixture contents.

## [0.1.0] - 2026-10-24

### Added

- Local HTML and localhost source capture with CSS selectors, exclusions and bounded readiness.
- Frozen portable manifests and checks for required text, table records and link destinations in generated or existing PDFs.
- Separate found, mismatch, manual-review and unverifiable results with page previews and JSON/standalone HTML reports.
- Seven interface languages and system, light and dark themes.
- Standalone macOS arm64/x64, Windows x64 and Ubuntu 24.04 x64 packages with bundled Node.js and Chromium, native launchers and installer smoke tests.

[Unreleased]: https://github.com/0then0/PrintWitness/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/0then0/PrintWitness/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/0then0/PrintWitness/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/0then0/PrintWitness/releases/tag/v0.1.0
