# Contributing

PrintWitness is a local HTML-to-PDF content verifier. Keep the checking core small, conservative and independent of the interface. Changes should preserve the distinction between text-layer presence and visual integrity.

Participation follows the [code of conduct](CODE_OF_CONDUCT.md). Use the [issue forms](https://github.com/0then0/PrintWitness/issues/new/choose) for reproducible bugs and concrete feature proposals. For security-sensitive reports, follow [SECURITY.md](SECURITY.md).

## Development

Follow the [source installation instructions](README.md#install-from-source), then run:

```sh
npm run dev
```

Use the committed npm lockfile. Run `npm run format` for Biome formatting and safe fixes, and `npm run check` before submitting a change. See [validation](docs/validation.md) for targeted commands and generated reports. Add regressions for meaningful behavior changes, especially any change that could turn an uncertain result into a positive match.

`.editorconfig` defines UTF-8, LF line endings and indentation; Biome is the source formatter. `.gitattributes` keeps checked-out text files on LF on every platform and preserves binary assets. Do not mass-format source fixtures, change frozen manifests to pass a check, or update dependencies as part of an unrelated change. Keep `package-lock.json` committed; caches, generated packages, reports and browser engines stay ignored.

Biome checks source, configuration and styles. Generated artifacts, dependencies, the lockfile and the source fixture are excluded. The CSS specificity-order rule is disabled because responsive component rules intentionally overlap.

## Code layout

- `src/core/`: portable types, manifest validation, normalization and deterministic matching.
- `src/node/`: source capture and printing, PDF.js extraction/rendering, report export, the local HTTP server and the `check` command (`cli.ts`). `cli.ts` must stay free of Playwright and source-capture imports.
- `src/ui/`: React document, checklist and finding-detail interface.
- `src/i18n/`: typed catalogs and presentation-only diagnostic translation.
- `fixtures/`, `tests/`, `scripts/`: the open acceptance template and reproducible validation.

Node executes server-side TypeScript directly. Vite builds the browser application. No database or external service is required.

## Translations and interface

English (`en`) defines the catalog keys in `src/i18n/en.ts`. Update every supported catalog when adding a message, preserving named interpolation parameters. Register stable core diagnostics in `src/i18n/index.ts`; JSON diagnostics remain English. Do not translate source content, URLs or identifiers.

The interface uses system fonts, warm paper surfaces, restrained typography and functional status colors. Keep the document/check/detail workflow accessible at narrow widths. Verify long translated labels, keyboard focus, errors, empty states and exported HTML reports. Avoid decorative dashboards and network-loaded visual assets.

## Standalone packaging

`scripts/prepare-desktop.ts` creates a self-contained native payload; `scripts/bundle-desktop.ts` produces portable and installation formats from it. `src/node/launcher.ts` manages the loopback server, startup state and browser opening. Resource paths are relative to the application root, independently of the working directory. No desktop framework is added to the checking core.

Run `npm run desktop:build` on a supported native host and follow the [packaging guide](docs/desktop.md). This downloads a checksum-verified official Node runtime and the Playwright browser revision. Keep `desktop.nodeVersion` on a supported, patched Node.js 24 release; it is a pinned distribution runtime, separate from the developer's Node installation. Browser and native canvas updates require checking every packaged target.

## Pull requests

Describe the concrete problem, resulting behavior and checks actually run. Include a minimal fixture for matching changes and screenshots for meaningful interface changes. Use Conventional Commit titles in English, such as `fix: preserve inline whitespace during capture`.

Do not commit generated reports, browser binaries, npm caches, private documents or secrets. The icon, documentation, source and original fixture are licensed under Apache-2.0. Report security-sensitive issues through the process in [SECURITY.md](SECURITY.md).

Record notable user-facing changes under Unreleased in [CHANGELOG.md](CHANGELOG.md). Include license notices for third-party materials; the external renderer lab has its own [attribution and export policy](scripts/labs/weasyprint-2469/NOTICE.md).

CI runs `npm run check` on main pushes and pull requests. Desktop packaging runs for changes to its build inputs and can be dispatched manually; new PR updates cancel older runs, while main desktop builds are allowed to finish so their release artifacts remain available. Workflows use read-only repository permissions and do not publish releases automatically.

For a release, choose the appropriate version, update `package.json`, `package-lock.json` and the changelog, then build and test that exact commit on all four native targets. Verify each package against its job's checksums, publish the eight distribution files with a combined `SHA256SUMS.txt`, and point the release tag to the tested commit. Do not relabel packages from another version or claim signing/notarization that was not performed.
