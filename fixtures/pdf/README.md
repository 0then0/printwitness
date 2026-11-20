# Synthetic PDF resource regressions

These original, non-personal test documents and the frozen manifest are licensed under the repository's Apache-2.0 license. Regenerate the PDFs with `node scripts/generate-pdf-fixtures.ts`. The generator uses only Node's standard library and writes deterministic PDF objects and byte offsets.

- `predefined-cmap.pdf`: one horizontal Type0 text item, expected Unicode **日本語**. The content bytes are `65E5 672C 8A9E`, interpreted through `/Encoding /UniJIS-UCS2-H`, with an Adobe/Japan1 CIDFontType2 descendant. There is no `/ToUnicode`, Identity-H encoding or embedded mapping. PDF.js must read its external predefined `UniJIS-UCS2-H.bcmap` and dependent CMaps, including the Japan1 Unicode mapping. The static `cmap-manifest.json` independently expects 日本語; it is not derived from extracted output.
- `link-actions.pdf`: named and direct destinations, a neighboring heading, a different page, a page-only fit, a null coordinate, an unresolved name, an external URI and a label without a link. Both pages have an offset crop box and nondefault user unit. Page 2 is rotated 90 degrees.
- `plain.pdf`: Helvetica text **Required Plain control End**, a positive control using PDF.js's bundled Liberation Sans standard-font data with system-font fallback disabled.
- `textless.pdf`: a gray vector rectangle, no text operators. This tests absence of a text layer without requiring an image decoder or OCR.
- `corrupt.pdf`: deliberately truncated synthetic PDF header and text, no catalog or page tree.

`tests/pdf.test.ts` copies only CMaps and standard fonts into a disposable directory containing spaces and Japanese characters. It first checks the CMap document with PDF.js's default Node reader, then deletes **only** `UniJIS-UCS2-H.bcmap` in that copy and verifies empty extraction with `stopAtErrors: true`. The application must instead report a runtime resource failure and `unverifiable`. Removing the standard font also tests that surviving text cannot produce a successful comparison. Absent, unused WASM and CMaps do not fail the controls. The checkout's dependency is never renamed or removed.

This is an extraction fixture, not a CJK typography or font-embedding conformance fixture. Its synthetic Japanese font has no embedded glyph outlines; previews can substitute glyphs. Assertions about Unicode text and comparison do not depend on those previews or system fonts. It does not cover vertical text, rotated text, all CJK encodings, OCR, clipping, overlap, accessibility, or arbitrary decoder errors.

The desktop smoke test supplies the fixture from outside the application payload, checks it through `/api/check`, then repeats packaged extraction/comparison using the bundled Node with outgoing TCP and `fetch` blocked. Test fixtures are not shipped to users.
