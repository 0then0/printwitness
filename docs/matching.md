# Manifest and matching reference

## Portable manifest

`printwitness/1` records expectations before export. It contains no executable source copy. Import validation enforces supported kinds, field types, unique IDs and resource bounds.

A minimal captured section has this shape:

```json
{
  "schema": "printwitness/1",
  "createdAt": "2026-10-24T10:00:00.000Z",
  "source": {
    "name": "document.html",
    "sha256": "<SHA-256 of the serialized ready DOM>",
    "readiness": "signal:PRINTWITNESS_READY; timeout=10000ms"
  },
  "exclusions": [],
  "sections": [
    {
      "id": "s1",
      "selector": "#required",
      "title": "Required",
      "anchor": "Required",
      "before": "Title",
      "after": "Appendix",
      "endContext": "Appendix",
      "startContext": "Title",
      "anchorInside": true,
      "headers": [],
      "expectations": [
        {
          "id": "s1-e1",
          "kind": "text",
          "text": "Approval recorded."
        }
      ]
    }
  ]
}
```

The source hash covers Chromium's serialized DOM after readiness, rather than the original file bytes. Capture time and readiness are provenance, not proof of a source's authenticity. IDs are stable within a captured manifest; recapturing can produce different IDs.

Expectation kinds are `text`, `row` and `link`. A row has a nonempty `cells` array in source order; a link has a nonempty `href`. A table header uses `kind: "text"` and `role: "table-header"`. An optional nonempty `excluded` string records a user-supplied exclusion reason. Source selector exclusions are stored separately in `exclusions`.

An internal link also records `internalTarget` with its decoded `fragment` and the source `heading` text when available. An `issue` records a missing fragment, duplicate element ID, non-heading element, unavailable text or ambiguous heading text. `labelInHeading` preserves a link label that is itself part of a heading. The optional manifest-level `headingTexts` list supplies other heading labels for same-page comparison, including headings outside the selected sections. These fields are additive in `printwitness/1`. Older manifests are still readable and can be recaptured to acquire internal-link expectations.

## Pagination expectations

Add the optional top-level `pagination` object to a saved `printwitness/1` manifest before checking the PDF. Enter the expected values yourself and keep any existing section expectations you want to check. For a pagination-only manifest, set `sections` to `[]`. The [pagination fixture manifest](../fixtures/pagination/manifest.json) is a complete example.

- `pageCount` is the exact number of physical PDF pages. Omit `headings` for a count-only check.
- `headings` is an array of `{ "text": "Release approval", "page": 2 }` entries. Each `text` must be nonempty after normalization. The same normalized text cannot name different pages. Omit `pageCount` to check only heading locations.

Supply at least one pagination expectation if you include the object. Counts and page numbers must be positive safe integers, and a heading page cannot exceed `pageCount` when that field is present. Page 1 means the first physical PDF page, regardless of printed numbers or PDF page labels. The parser rejects invalid expectations before PDF analysis. Manifests without `pagination` use the existing section checks.

The count comes from PDF.js `numPages` as soon as the PDF opens. Pages with missing or unavailable text still count. Heading checks search the entire PDF for standalone heading text. They share the text and geometry analysis used for internal links, preserve normalized line wraps, and reject matches assembled from separate columns on the same line. One match on the expected page passes. One match elsewhere is a mismatch when extraction supports a confident result. Repeated text, an unlocated heading or incomplete extraction requires manual review. Even one match can be inconclusive when another page has no usable text. An unopened PDF leaves pagination unverifiable.

Use the same [`check` command](usage.md#check-a-finished-pdf-from-the-command-line) with the edited manifest. Pagination checks use the existing status priority and exit codes.

## Section context

`anchor`, `before` and `after` record the selected section's heading and neighboring headings. `endContext` records the first following DOM text block, including unselected content before the next heading. `null` means no following DOM content existed at capture. `startContext` records the last preceding DOM text block, or `null` at the document start. `anchorInside` records whether the heading belongs to the selected element. When its heading disappears, a section also needs its preceding DOM boundary; text before the original element cannot replace a lost record.

Matching requires established, ordered boundaries. A repeated, missing or ambiguous boundary produces manual review instead of borrowing text from elsewhere. A missing selected section's end marker can be skipped only if none of that section's active expectations survives before the next established marker. Surviving neighboring boundaries can establish a completely hidden section's absence.

When an internal link label repeats the first block after its selected section, `endContextNext` also records the next block. The pair can distinguish the section boundary from the label. `null` records that the repeated boundary was the last block in the source.

Legacy manifests without `endContext` are accepted for inspection, but do not establish positive matches. Capture again to obtain DOM boundary context. Do not edit boundaries to make a failed check pass.

## Text and multiplicity

NFKC normalization handles composed accents and compatibility ligatures. Whitespace, NBSP, zero-width characters and soft hyphens are normalized. HTML line breaks and whitespace between inline elements are preserved as separators. PDF line wraps are normalized; continuous CJK text can span extraction lines without acquiring spaces. A second search form removes discretionary line-end hyphenation while retaining offsets into the original stream.

Matching preserves case, punctuation and numbers. Word/record boundaries prevent `PW-042` from matching `PW-0420`. Repeated expectations consume separate occurrences within their section. Matches are never counted as evidence of actual visibility.

## Tables and links

A row must match as an ordered record on one baseline and page. Cell boundaries must align with complete extraction items and distinguishable horizontal gaps. A flattened string such as `A B C` cannot establish whether the cells were `["A B", "C"]` or `["A", "B C"]`. Missing cell geometry, empty/merged cells, wrapping, reordering and page splits require manual review. A body record indistinguishable from a repeating header is also ambiguous.

A URL link requires a label and an independently consumed, spatially associated URL annotation. When a label occupies only part of a combined extraction item, its whole-item bounding box cannot establish the correct annotation. An unrelated correct URL cannot satisfy an altered link.

### Internal links

Capture covers ordinary same-document `href="#fragment"` links to a unique HTML `h1`–`h6` element with an `id`. Capture records a source issue when the heading cannot be identified by its text, for example when a different block repeats it. A uniquely located label in the table of contents can repeat the target heading's text. The comparator identifies that label inside its selected section and searches the PDF text layer independently for the heading. PDF bookmarks, actions in other files and JavaScript are outside this check.

PDF.js resolves named destinations to explicit arrays and also reads explicit arrays directly from link annotations. It uses the target page viewport at scale 1 to transform coordinates, including page rotation, crop origin and user unit. Supported destination evidence is:

- `XYZ` supplies vertical position when the explicit left or top operand required by the page transform is present.
- `FitH` and `FitBH` supply vertical position when an explicit usable top operand determines the viewport's vertical coordinate.
- `Fit`, `FitB`, `FitV`, `FitBV` and `FitR` are used as page-only evidence. Missing operands, out-of-page positions and unresolved destinations cannot confirm a position. The name alone carries no location evidence.

The destination must lie within 4 viewport points of the first extracted line's top and agree with just one heading. A missing or repeated PDF heading, a position that cannot identify a unique heading or a destination that establishes only the correct page requires manual review. A different page or a position that identifies a different heading on the same page is a mismatch. A missing annotation is a mismatch only for a unique, contiguous label made of complete text items on a page with a completed annotation scan. Partial or competing annotations require manual review.

## Report contract and limits

`printwitness-report/1` includes the frozen manifest, PDF hash and page metadata, overall status, findings, evidence coordinates and warnings. Evidence uses PDF page coordinates at scale 1 with a top-left origin. The standalone HTML export embeds page images separately; JSON contains page text and evidence, not raster images.

Internal link findings include the label, expected heading, reason and any observed destination in `actualDestination`. The page is one-based and `y` is measured down from the top of the destination page's viewport. The report can retain the raw destination name and fit type even when the location is unresolved. The interface and offline HTML display the observed page and position when available.

The report's `pdf.pageCount` is present when the PDF opens. `pdf.pages` describes the pages that were indexed. A `page-count` finding has `expectedPageCount` and `actualPageCount`, which is `null` when the count is unknown. A `heading-page` finding has the heading text in `expected`, a one-based `expectedPage` and a sorted `actualPages` list of distinct pages detected in the text layer. The list can include candidate pages on a manual result, or be empty when no match could be located. Both findings show the status and reason in JSON and the standalone HTML.

The core has no filesystem, browser, React or PDF.js dependency. It operates on a typed extraction index, so extraction confidence remains separate from presentation.

PDF extraction order is not a semantic document tree. Multi-column layouts, repeated headings, rotated/vertical text, nested tables and unusual encodings can prevent reliable verification. Rotated/vertical extraction currently makes the index unverifiable. An empty-text page prevents confident missing-text claims even if that page is legitimately blank.

Capture covers ordinary light-DOM text. CSS pseudo-elements, canvas text, shadow DOM, form control values and text in images are outside the capture model. There is no OCR. No result certifies accessibility, legal compliance, PDF/A conformance or an intact visual layout.
