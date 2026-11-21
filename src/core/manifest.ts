import { normalize } from './normalize.ts';
import type { Manifest } from './types.ts';

const maxExpectations = 10_000;
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === 'string' && x.length <= 100_000;
const pageNumber = (x: unknown): x is number =>
  typeof x === 'number' && Number.isSafeInteger(x) && x > 0;

function invalidPagination(): never {
  throw new Error(
    'Invalid manifest: pagination needs a page count or non-conflicting heading expectations with positive integer page numbers.',
  );
}

function paginationSize(value: unknown): number {
  if (value === undefined) return 0;
  if (!object(value)) invalidPagination();
  const { pageCount, headings = [] } = value;
  if (
    (pageCount !== undefined && !pageNumber(pageCount)) ||
    !Array.isArray(headings) ||
    (pageCount === undefined && !headings.length) ||
    headings.length > maxExpectations
  )
    invalidPagination();
  const pagesByHeading = new Map<string, number>();
  for (const heading of headings) {
    if (
      !object(heading) ||
      !str(heading.text) ||
      !pageNumber(heading.page) ||
      (pageCount !== undefined && heading.page > pageCount)
    )
      invalidPagination();
    const text = normalize(heading.text);
    const previous = pagesByHeading.get(text);
    if (!text || (previous !== undefined && previous !== heading.page)) invalidPagination();
    pagesByHeading.set(text, heading.page);
  }
  return headings.length + (pageCount === undefined ? 0 : 1);
}

// Validate imported portable manifests at the trust boundary, including resource limits.
export function parseManifest(value: unknown): Manifest {
  function fail(): never {
    throw new Error(
      'Invalid manifest: expected printwitness/1 with valid expectations and unique IDs.',
    );
  }
  const nonempty = (x: unknown): x is string => str(x) && !!x.trim();
  const nullable = (x: unknown) => x === null || str(x);
  const strings = (x: unknown): x is string[] =>
    Array.isArray(x) && x.length <= 2000 && x.every(str);
  const targetIssues = new Set([
    'missing-fragment',
    'duplicate-id',
    'not-heading',
    'heading-text-unavailable',
    'ambiguous-heading-text',
  ]);
  const internalTarget = (x: unknown) =>
    object(x) &&
    str(x.fragment) &&
    (x.heading === undefined || nonempty(x.heading)) &&
    (x.labelInHeading === undefined || (x.labelInHeading === true && nonempty(x.heading))) &&
    (x.issue === undefined
      ? !!x.fragment && nonempty(x.heading)
      : str(x.issue) &&
        targetIssues.has(x.issue) &&
        (!!x.fragment || x.issue === 'missing-fragment'));
  if (
    !object(value) ||
    value.schema !== 'printwitness/1' ||
    !str(value.createdAt) ||
    !object(value.source) ||
    !str(value.source.name) ||
    !str(value.source.sha256) ||
    !str(value.source.readiness) ||
    !strings(value.exclusions) ||
    (value.headingTexts !== undefined &&
      (!Array.isArray(value.headingTexts) || !value.headingTexts.every(nonempty))) ||
    !Array.isArray(value.sections) ||
    value.sections.length > 100
  )
    fail();
  const ids = new Set<string>();
  let count = paginationSize(value.pagination);
  if (count > maxExpectations || (!count && !value.sections.length)) fail();
  for (const s of value.sections) {
    if (
      !object(s) ||
      !str(s.id) ||
      !s.id.trim() ||
      ids.has(s.id) ||
      !str(s.selector) ||
      !str(s.title) ||
      !str(s.anchor) ||
      !s.anchor.trim() ||
      !nullable(s.before) ||
      !nullable(s.after) ||
      (s.endContext !== undefined && !nullable(s.endContext)) ||
      (s.endContextNext !== undefined &&
        (!nonempty(s.endContext) || (s.endContextNext !== null && !nonempty(s.endContextNext)))) ||
      (s.startContext !== undefined && !nullable(s.startContext)) ||
      (s.anchorInside !== undefined && typeof s.anchorInside !== 'boolean') ||
      !strings(s.headers) ||
      !Array.isArray(s.expectations) ||
      !s.expectations.length
    )
      fail();
    ids.add(s.id);
    for (const e of s.expectations) {
      if (
        ++count > maxExpectations ||
        !object(e) ||
        !str(e.id) ||
        !e.id.trim() ||
        ids.has(e.id) ||
        (e.kind !== 'text' && e.kind !== 'row' && e.kind !== 'link') ||
        !str(e.text) ||
        !e.text.trim() ||
        (e.excluded !== undefined && (!str(e.excluded) || !e.excluded.trim())) ||
        (e.role !== undefined && (e.role !== 'table-header' || e.kind !== 'text')) ||
        (e.cells !== undefined && (!strings(e.cells) || e.kind !== 'row')) ||
        (e.href !== undefined && (!str(e.href) || e.kind !== 'link')) ||
        (e.internalTarget !== undefined &&
          (e.kind !== 'link' ||
            !str(e.href) ||
            !e.href.startsWith('#') ||
            !internalTarget(e.internalTarget))) ||
        (e.kind === 'row' && (!strings(e.cells) || !e.cells.length)) ||
        (e.kind === 'link' && (!str(e.href) || !e.href))
      )
        fail();
      ids.add(e.id);
    }
  }
  return structuredClone(value) as unknown as Manifest;
}
