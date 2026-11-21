import type { Manifest, PaginationFinding } from './types.ts';

/** Build the same entries for a frozen checklist and for the report. */
export function paginationFindings(manifest: Manifest): PaginationFinding[] {
  if (!manifest.pagination) return [];
  const ids = new Set(manifest.sections.flatMap((s) => [s.id, ...s.expectations.map((e) => e.id)]));
  const uniqueId = (base: string) => {
    let id = base;
    for (let suffix = 2; ids.has(id); suffix++) id = `${base}-${suffix}`;
    ids.add(id);
    return id;
  };
  const sectionId = uniqueId('pagination');
  const entry = (key: string, expected: string) => ({
    id: uniqueId(`${sectionId}-${key}`),
    sectionId,
    section: 'Pagination',
    expected,
    status: 'unverifiable' as const,
    reason: '',
    evidence: [],
  });
  const { pageCount, headings = [] } = manifest.pagination;
  const findings: PaginationFinding[] = [];
  if (pageCount !== undefined)
    findings.push({
      ...entry('count', String(pageCount)),
      kind: 'page-count',
      expectedPageCount: pageCount,
      actualPageCount: null,
    });
  for (const [i, { text, page }] of headings.entries())
    findings.push({
      ...entry(`heading-${i + 1}`, text),
      kind: 'heading-page',
      expectedPage: page,
      actualPages: [],
    });
  return findings;
}
