# WeasyPrint #2469: independently reproduced content loss

Checked on October 24, 2026. The renderer defect reproduces, but this case does
**not** establish automatic confirmed-loss detection by PrintWitness. Against
one frozen manifest, PrintWitness returns **manual** for the parent PDF and
**found** for the fixed PDF. No product behavior or version was changed.

## Which upstream case

The [original issue](https://github.com/Kozea/WeasyPrint/issues/2469) opened in June
2025 included a large example that the maintainer did not reproduce. This lab
uses [septatrix's minimal example from March 14, 2026](https://github.com/Kozea/WeasyPrint/issues/2469#issuecomment-4060916782):
a column flex body, a tall empty pusher, and table rows `B` and `C`, with a forced
page break after `B`. The maintainer distinguished this from the initial report,
kept the issue for the new sample, and confirmed a tested fix on March 16.
The live issue was closed, with six comments and a last update of March 16, 2026.
`issue-evidence.json` records the retrieval time, comment URLs and body hashes.

The pinned revisions are:
- Parent: `8ace950151b4fdf380721e06f3ff65af9a464158`.
- Fix: `8415e28a6269144cbc28e20c4b22d2d85e3b6d0e`.

The [fix](https://github.com/Kozea/WeasyPrint/commit/8415e28a6269144cbc28e20c4b22d2d85e3b6d0e)
corrects the resume/skip stack after a forced break inside a flex item. It changes
only `weasyprint/layout/flex.py` and adds
[`test_flex_break_after_page`](https://github.com/Kozea/WeasyPrint/blob/8415e28a6269144cbc28e20c4b22d2d85e3b6d0e/tests/layout/test_flex.py#L2006).
Both revisions identify themselves as WeasyPrint 68.1; the commit IDs, not that
version string, distinguish them.

## Inputs and frozen expectations

The late issue example is downloaded unchanged into the ignored work directory.
Its UTF-8 bytes, including one terminal newline, have SHA-256
`699af6e0833dc72bb383a75077608002c07aea1fdd7d10809a42e8a0bb6707b0`.
The capture API requires an HTML heading, which this upstream sample does not
have. It is reproduced independently, rather than given invented PDF-derived
section boundaries. Its source expectations `B` and `C` are recorded before
rendering in `upstream-expectations.json`.

The separate [adapted input](../../fixtures/weasyprint-2469/adapted.html) follows
the BSD-licensed upstream regression's block-based structure, with readable
markers and document context. It retains the column flex layout, tall empty
first item and forced break in the second item. Changes from the regression
include A4 pages, a 16px DejaVu Sans font, an 80em pusher, a selected section
heading, and an end-context heading after the section. Unlike the issue sample,
it uses blocks rather than table rows. It has no content-removal script,
print-only hiding, clipping, transparency or manual PDF edits.

PrintWitness captures `#required`, with no exclusions and DOM readiness, **before
any PDF generation or analysis**. Three active text expectations are frozen:
- `PW2469 Required content`
- `PW2469-B before forced break`
- `PW2469-C after forced break`

The start context is document start; the end context is `PW2469 End context`.
The manifest was captured at `2026-10-24T12:15:29.272Z`, with file SHA-256
`2f02077021b4d83e29db290b20b16e15f4ccdbef7bde1a9461195bf7390c54d5`.
The source file SHA-256 is
`2e119a090790f7741fe4e0bdf4de1207a84299575931491f0e8a3169c2c3c91e`;
the manifest's separate source hash covers Chromium's serialized DOM.
Both JSON reports embed the same complete manifest. Hash checks bracket
generation and comparison; the freeze command refuses to overwrite a manifest
or capture after a PDF already exists. Expectations were not changed after
examining results.

## Independent observations

Poppler 22.12.0 extraction, Poppler page renders at 90 DPI and WeasyPrint's layout
regression agree:
- Unchanged upstream, parent: three pages, extracted text `[]`, `[B]`, `[]`.
  All pages were inspected. The first page contains the pusher and outlines;
  page 2 visibly contains `B`; page 3 has outlines but no `C`.
- Unchanged upstream, fix: three pages, `[]`, `[B]`, `[C]`. `C` is visible on
  page 3. The first page still contains graphics without extractable text.
- Adapted, parent: three pages. Page 1 contains the pusher outline. Page 2
  visibly contains the heading and `PW2469-B`. Page 3 is visually blank in this
  render; both `PW2469-C` and the end-context heading are absent.
- Adapted, fix: three pages. Page 2 retains the heading and `PW2469-B`; page 3
  visibly contains `PW2469-C` and the end-context heading. All six adapted pages
  were inspected, including the pages with no extractable text.

Two causal controls on **each** input remove either flex display or the forced
break using a separate user stylesheet with `!important`. On the parent, each
control restores the subsequent content. These controls retain the HTML text
and do not implement the defect by deleting or hiding content. Thus the adapted
input preserves the revision difference and the relevant layout mechanism.

The exact upstream test function, including its log assertion, is transplanted
unchanged into both isolated test trees with the same SHA-256. On the parent it
fails because the third-page section has zero children where `c` is required;
on the fix it passes. The original upstream test is additionally run at its
original path on the fixed tree and passes. Renderer source files are unchanged.
The regression uses upstream's small page geometry and test font; it is an
independent layout assertion, not a PrintWitness result.

## PrintWitness result and uncertainty

`parent-adapted.json` reports three **manual** findings. The precise reason is:
“Section boundaries are missing, repeated, or out of order. A match elsewhere
cannot establish preservation.” The bug removes the end-context heading along
with the expected continuation. Even the surviving heading and `B` cannot be
accepted as section-scoped findings without an established end. Page 3 also
has no text layer. Restricting empty-page uncertainty to section pages would
not resolve the missing boundary in this input.

`fix-adapted.json` reports three **found** findings. This is correct text-layer
handling of the restored content against the original manifest. Visibility was
checked separately in the page renders; `found` alone would not establish it.

Six explicitly synthetic extraction-index probes isolate the current uncertainty
policy using this same manifest. They do not alter a renderer PDF and are not
evidence of the upstream defect:
- With established boundaries and no textless pages, absent continuation gives
  `mismatch`; the two surviving expectations give `found`.
- A textless page **outside** the established section changes the missing
  expectation to `manual`; the surviving expectations remain `found`.
- A textless page **inside** the section likewise gives `manual` for the missing
  expectation.
- Repeated, ambiguous boundaries give `manual` for all expectations.
- An entirely textless index gives `unverifiable` for all expectations.
- If every expectation is found, an additional textless page does not prevent
  `found`, as in the fixed PDF's legitimate first page.

The global empty-page guard is conservative even outside an established section.
This limitation is recorded rather than weakened to obtain a desired failure.
An empty text layer does not prove a blank page: the upstream first page and its
buggy third page visibly contain graphics. Independent human observation of
missing `C` does not remove the checker's uncertainty about arbitrary PDFs.
This milestone demonstrates reproduction and correct conservative handling,
not a confirmed automated `mismatch` for this renderer defect.

## Reproduce

Use the project's installed npm dependencies and Chromium, Node.js 24.13+,
Docker with Linux arm64 support, and `tar`. This run used Node.js 24.22.1,
Playwright 1.64.1 and PDF.js 6.4.299 on macOS arm64. The isolated renderer uses
CPython 3.12.12, the digest-pinned Python image in the
[Dockerfile](../../scripts/labs/weasyprint-2469/Dockerfile), a Debian snapshot
dated March 17, 2026 and a dedicated `/opt/lab` venv. No user Python environment
is used to install dependencies. The validated target is Linux arm64; other
architectures are not claimed as tested.

Native dependencies include Pango 1.50.12, HarfBuzz 6.0.0, FreeType 2.12.1,
Fontconfig 2.14.1 and DejaVu 2.37. Every Python dependency is pinned in
[requirements.txt](../../scripts/labs/weasyprint-2469/requirements.txt).
`environment.json` contains full Debian package versions, Python version,
font inventory and file hashes, font resolution, renderer source hashes and
generation options. Generation uses print media, zoom 1, no presentational
hints and otherwise the pinned renderer's defaults. The adapted input specifies
A4/20mm margins; the issue example retains its original CSS and renderer defaults.

Run from the repository root, stopping if any command fails. On the **first** run
the lab directory must have no previous manifest or PDFs:

```sh
node scripts/labs/weasyprint-2469/prepare.ts
node scripts/labs/weasyprint-2469/check.ts freeze
BUILDX_CONFIG="$PWD/artifacts/weasyprint-2469/work/buildx" \
  docker build --platform linux/arm64 -t printwitness-weasyprint-2469 \
  scripts/labs/weasyprint-2469
docker run --rm --network none \
  --mount "type=bind,src=$PWD,dst=/repo,readonly" \
  --mount "type=bind,src=$PWD/artifacts/weasyprint-2469,dst=/repo/artifacts/weasyprint-2469" \
  printwitness-weasyprint-2469 \
  python /repo/scripts/labs/weasyprint-2469/render.py
node scripts/labs/weasyprint-2469/check.ts compare
node scripts/labs/weasyprint-2469/verify.ts
node scripts/labs/weasyprint-2469/package.ts
```

On a subsequent run, reuse `manifest.json` and skip `freeze`; do not edit it to
accommodate output. `prepare.ts` verifies both source archive hashes and the
late reproducer's hash, failing on drift. Network access is used only for the
explicit fetch and image build. Rendering, regression tests and comparison run
locally, with renderer networking disabled. No Chromium rendering backend was
added to the product; the existing imported-PDF path is used.

Outputs stay under ignored `artifacts/weasyprint-2469/`: the manifest and its
hash, both input variants' parent/fix PDFs, control PDFs, per-page Poppler text
and PNGs, independent layout/extraction observations, upstream test logs,
environment metadata, JSON/standalone HTML reports, uncertainty probes and
checksums. The HTML reports embed PDF.js page previews and work offline.
`verify.ts` fails if the observed revision/control difference, test results,
manifest identity or recorded PrintWitness behavior diverges. No new product
correction was needed, so no product regression or patch release is introduced.

Verification and packaging both check each report's frozen manifest, PDF name
and PDF SHA-256 before writing any output. Replaced or swapped PDFs are rejected
without overwriting checksums or a previous export. These guards have regressions
in `npm test`, including both command entry points; they do not change product
matching behavior.

## Public command re-check

On November 8, 2026 the lab PDFs were regenerated from the same pinned revisions, because the earlier outputs were not stored. The earlier frozen manifest was therefore not available either; the lab's `freeze` step created a new one from the same source and selector (SHA-256 `9c41ab92969f782c583094b82ff56c05b6c529e7edf7be8a6a390eb23e8c3b72`, which differs from the hash recorded above). That one manifest was used for both PDFs.

`node src/node/cli.ts check` was run from outside the checkout. The parent PDF exits `2` with three **manual** findings and the same boundary reason as above; the fixed PDF exits `0` with three **found** findings. Their reports are semantically identical to the lab's `check.ts compare` output, apart from the creation time. This confirms that the public command applies the same contract. It is not a new external case, a confirmed automatic mismatch or evidence of adoption.

## Licenses and scope

The [lab notice](../../scripts/labs/weasyprint-2469/NOTICE.md) records attribution
and export rules. The adapted document derives from the BSD-3-Clause repository
test, with its full notice retained. Embedded DejaVu subsets retain the Bitstream
Vera/DejaVu notice. `share.tar.gz` is an explicit allowlist of adapted PDFs,
reports, previews, metadata and license notices. It excludes the issue example
and its derivative outputs because no explicit license for that comment was
found. The unchanged reproducer remains available locally for inspection.
Downloaded source trees, fonts, tools and the Docker image are not redistributed.

No commit, push, release, upstream message or claim of WeasyPrint adoption is
part of this milestone.
