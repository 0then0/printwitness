import { normalize } from './normalize.ts';
import type {
  Box,
  Evidence,
  Finding,
  InternalTarget,
  InternalTargetIssue,
  Manifest,
  PdfIndex,
  PdfLink,
  Report,
  Status,
} from './types.ts';

interface Span {
  start: number;
  end: number;
  token: number;
}
interface Match {
  start: number;
  end: number;
}
interface HeadingHit {
  first: Evidence;
  evidence: Evidence[];
}

const targetIssues: Record<InternalTargetIssue, string> = {
  'missing-fragment': 'The source fragment has no matching element ID.',
  'duplicate-id': 'The source fragment matches more than one element ID.',
  'not-heading': 'The source fragment targets an element other than an HTML heading.',
  'heading-text-unavailable': 'The source heading has no usable text for matching.',
  'ambiguous-heading-text': 'The expected heading text also occurs elsewhere in the source.',
};
const labelPadding = 2;
// Scale-1 viewport points between the PDF target and the top of the first text line.
const headingTolerance = 4;
const coversLabel = (link: PdfLink, evidence: Evidence[], boxes = [link.box]) =>
  evidence.every(
    ({ page, box }) =>
      page === link.page &&
      boxes.some(
        (area) =>
          box.x >= area.x - labelPadding &&
          box.x + box.width <= area.x + area.width + labelPadding &&
          box.y >= area.y - labelPadding &&
          box.y + box.height <= area.y + area.height + labelPadding,
      ),
  );
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const isSingleLabel = (items: Evidence[]) =>
  items.every((item, i) => {
    const { box } = item;
    const previous = items[i - 1]?.box;
    return (
      box.width > 0 &&
      box.height > 0 &&
      item.page === items[0].page &&
      Math.abs(box.y - items[0].box.y) < labelPadding &&
      (!previous ||
        Math.max(box.x - previous.x - previous.width, previous.x - box.x - box.width) <=
          Math.max(labelPadding, 0.5 * Math.max(box.height, previous.height)))
    );
  });

export function compare(
  manifest: Manifest,
  pdf: PdfIndex,
  identity: { name: string; sha256: string },
): Report {
  let text = '';
  const spans: Span[] = [];
  const pageRanges = new Map<number, Match>();
  pdf.tokens.forEach((token, i) => {
    const previous = pdf.tokens[i - 1];
    const sameLine =
      previous && previous.page === token.page && Math.abs(previous.box.y - token.box.y) < 2;
    const adjacent =
      sameLine &&
      token.box.x - previous.box.x - previous.box.width < Math.max(1, token.box.height * 0.12);
    if (text && (!adjacent || /\s$/u.test(previous.text) || /^\s/u.test(token.text)))
      text += sameLine ? ' ' : '\n';
    const start = text.length;
    text += normalize(token.text);
    spans.push({ start, end: text.length, token: i });
    const range = pageRanges.get(token.page);
    if (range) range.end = text.length;
    else pageRanges.set(token.page, { start, end: text.length });
  });
  // Keep an offset map back to the original stream when removing line-end hyphenation.
  const cjk =
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
  const variants = ['normal', 'dehyphenate', 'cjk'].map((mode) => {
    let value = '';
    const offsets: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (
        mode === 'dehyphenate' &&
        text[i] === '-' &&
        text[i + 1] === '\n' &&
        /\p{L}/u.test(text[i - 1] ?? '') &&
        /\p{Ll}/u.test(text[i + 2] ?? '')
      ) {
        i++;
        continue;
      }
      if (
        mode === 'cjk' &&
        text[i] === '\n' &&
        cjk.test(text[i - 1] ?? '') &&
        cjk.test(text[i + 1] ?? '')
      )
        continue;
      const char = /\s/u.test(text[i]) ? ' ' : text[i];
      if (char === ' ' && value.endsWith(' ')) continue;
      value += char;
      offsets.push(i);
    }
    return { value, offsets };
  });
  const cache = new Map<string, Match[]>();
  const find = (expected: string): Match[] => {
    const needle = normalize(expected);
    if (!needle) return [];
    const cached = cache.get(needle);
    if (cached) return cached;
    const matches = new Map<string, Match>();
    for (const { value, offsets } of variants) {
      let from = 0;
      while (from < value.length) {
        const at = value.indexOf(needle, from);
        if (at < 0) break;
        const end = at + needle.length;
        // A number/word must not be satisfied by a substring of a different record.
        const word = (s: string | undefined) => !!s && !cjk.test(s) && /[\p{L}\p{N}_]/u.test(s);
        if (
          !(word(needle[0]) && word(value[at - 1])) &&
          !(word(needle.at(-1)) && word(value[end]))
        ) {
          const m = { start: offsets[at], end: offsets[end - 1] + 1 };
          matches.set(`${m.start}:${m.end}`, m);
        }
        from = at + Math.max(1, needle.length);
      }
    }
    const found = [...matches.values()].sort((a, b) => a.start - b.start);
    cache.set(needle, found);
    return found;
  };
  const evidence = (m: Match): Evidence[] =>
    spans
      .filter((s) => s.end > m.start && s.start < m.end)
      .map((s) => {
        const t = pdf.tokens[s.token];
        return { page: t.page, box: t.box, text: t.text };
      });
  const wholeItems = (m: Match) =>
    !spans.some(
      (s) => (s.start < m.start && s.end > m.start) || (s.start < m.end && s.end > m.end),
    );
  const findAnchor = (label: string) =>
    find(label).filter((m) => {
      const start = text.lastIndexOf('\n', m.start - 1) + 1;
      const newline = text.indexOf('\n', m.end);
      return normalize(text.slice(start, newline < 0 ? text.length : newline)) === normalize(label);
    });
  const findings: Finding[] = [];
  const usedLinks = new Set<number>();
  const knownHeadings = new Set(manifest.headingTexts?.map(normalize));
  const headingsOnPage = new Map<number, string[]>();
  const possibleHeadings = (page: number) => {
    const cached = headingsOnPage.get(page);
    if (cached) return cached;
    const range = pageRanges.get(page);
    const pageText = range ? normalize(text.slice(range.start, range.end)) : '';
    const candidates = [...knownHeadings].filter((heading) => pageText.includes(heading));
    headingsOnPage.set(page, candidates);
    return candidates;
  };
  const pendingLinks: { f: Finding; target: InternalTarget; localized: boolean }[] = [];
  const tocLabels = new Map<number, number>();
  const locatedHeadings = new Map<string, HeadingHit[]>();
  const locateHeading = (heading: string): HeadingHit[] => {
    const key = normalize(heading);
    const cached = locatedHeadings.get(key);
    if (cached) return cached;
    const hits: HeadingHit[] = [];
    for (const match of findAnchor(key)) {
      // A uniquely located TOC label cannot also stand in for a separate heading.
      if (tocLabels.get(match.start) === match.end) continue;
      const items = evidence(match);
      const first = items[0];
      if (!first || !wholeItems(match)) continue;
      if (
        items.every((e, i) => {
          if (e.page !== first.page || e.box.height <= 0 || e.box.width <= 0) return false;
          const previous = items[i - 1];
          if (!previous) return true;
          const offset = e.box.y - previous.box.y;
          return offset >= -2 && offset <= 1.5 * Math.max(e.box.height, previous.box.height);
        })
      )
        hits.push({ first, evidence: items });
    }
    locatedHeadings.set(key, hits);
    return hits;
  };
  const checkInternalLink = (f: Finding, target: InternalTarget, localized: boolean) => {
    f.status = 'manual';
    if (!localized) {
      f.reason = target.issue
        ? targetIssues[target.issue]
        : 'The internal link label cannot be located unambiguously.';
      return;
    }
    const page = f.evidence[0].page;
    const candidates = pdf.links
      .map((link, i) => ({ link, i }))
      .filter(
        ({ link }) =>
          coversLabel(link, f.evidence) ||
          f.evidence.some((e) => e.page === link.page && overlaps(e.box, link.box)),
      );
    const only = candidates.length === 1 ? candidates[0] : undefined;
    const associated =
      only && !usedLinks.has(only.i) && coversLabel(only.link, f.evidence, only.link.hitBoxes)
        ? only
        : undefined;
    if (associated) {
      usedLinks.add(associated.i);
      f.actualHref = associated.link.href;
      f.actualDestination = associated.link.destination;
    }
    if (target.issue) {
      f.reason = targetIssues[target.issue];
      return;
    }
    if (!associated) {
      if (!candidates.length && pdf.linkAnnotationPages?.includes(page)) {
        f.status = 'mismatch';
        f.reason = 'No PDF link annotation covers the uniquely located internal link label.';
      } else {
        f.reason =
          'A unique PDF link annotation could not be associated with the internal link label.';
      }
      return;
    }
    const destination = f.actualDestination;
    if (!destination?.page) {
      f.reason = 'The link annotation has no resolvable internal PDF destination.';
      return;
    }
    const heading = normalize(target.heading ?? '');
    const expected = locateHeading(heading);
    if (expected.length !== 1) {
      f.reason = 'The expected heading could not be uniquely located in the PDF text layer.';
      return;
    }
    const [hit] = expected;
    f.evidence.push(
      ...hit.evidence.filter(
        (item) => !f.evidence.some((e) => e.page === item.page && e.box === item.box),
      ),
    );
    if (destination.page !== hit.first.page) {
      f.status = 'mismatch';
      f.reason = 'The internal link points to a different page from the expected heading.';
      return;
    }
    const y = destination.y;
    if (y === undefined) {
      f.reason = 'The internal destination gives no usable vertical position on the expected page.';
      return;
    }
    const aligns = ({ first }: HeadingHit) =>
      first.page === destination.page && Math.abs(first.box.y - y) <= headingTolerance;
    const others = possibleHeadings(destination.page)
      .filter((title) => title !== heading)
      .flatMap((title) => {
        const hits = locateHeading(title);
        return hits.filter(aligns).map((hit) => ({ hit, unique: hits.length === 1 }));
      });
    if (aligns(hit) && others.length === 0) {
      f.status = 'found';
      f.reason = 'The internal link destination aligns with the expected heading.';
    } else if (!aligns(hit) && others.length === 1 && others[0].unique) {
      f.status = 'mismatch';
      f.evidence.push(...others[0].hit.evidence);
      f.reason = 'The internal link points to a different heading on the same page.';
    } else {
      f.reason = 'The vertical destination could not be associated with a unique heading.';
    }
  };
  const boundaryHits = (label: string, next?: string | null): Match[] => {
    const hits = findAnchor(label);
    if (next === undefined) return hits;
    // One surviving copy could be the label inside the section or the boundary outside it.
    if (hits.length < 2) return [];
    if (next === null) return hits.filter((hit) => hit.end === text.length);
    const starts = new Set(findAnchor(`${label} ${next}`).map((hit) => hit.start));
    return hits.filter((hit) => starts.has(hit.start));
  };
  // A hidden selected section may remove the preceding section's end anchor too.
  // Skip that boundary only if none of that section's expected content survives
  // before the next established boundary. Otherwise widening would mix contexts.
  const endBoundary = (
    label: string | null,
    from: number,
    next?: string | null,
    visited = new Set<string>(),
  ): number | undefined => {
    if (!label) return text.length;
    const hits = boundaryHits(label, next);
    if (hits.length === 1) return hits[0].start;
    if (findAnchor(label).length || visited.has(label)) return undefined;
    visited.add(label);
    const missing = manifest.sections.find((s) => s.anchor === label);
    if (!missing) return undefined;
    const end = endBoundary(
      missing.endContext ?? missing.after,
      from,
      missing.endContextNext,
      visited,
    );
    if (
      end === undefined ||
      missing.expectations.some(
        (e) => !e.excluded && find(e.text).some((m) => m.start >= from && m.end <= end),
      )
    )
      return undefined;
    return end;
  };
  for (const section of manifest.sections) {
    const anchors = findAnchor(section.anchor);
    const before = section.before ? findAnchor(section.before) : [];
    const after = section.endContext
      ? boundaryHits(section.endContext, section.endContextNext)
      : [];
    let low = 0,
      high = text.length,
      certain = false;
    const end =
      anchors.length === 1 && section.endContext !== undefined
        ? endBoundary(section.endContext, anchors[0].end, section.endContextNext)
        : undefined;
    if (anchors.length === 1 && end !== undefined) {
      low = anchors[0].start;
      high = end;
      certain = low < high && (!before.length || before[0].end <= low);
    } else if (
      !anchors.length &&
      before.length === 1 &&
      after.length === 1 &&
      before[0].end < after[0].start
    ) {
      low = before[0].end;
      high = after[0].start;
      certain = section.startContext !== undefined;
    }
    if (certain && section.startContext) {
      const starts = find(section.startContext);
      const established = starts.length === 1 && starts[0].end <= high;
      if (established) low = Math.max(low, starts[0].end);
      else if (!anchors.length || !section.anchorInside) certain = false;
    }
    const used: Match[] = [];
    const usedLinkLabels: Match[] = [];
    for (const expected of section.expectations) {
      const f: Finding = {
        id: expected.id,
        sectionId: section.id,
        section: section.title,
        kind: expected.kind,
        expected: expected.text,
        href: expected.href,
        internalTarget: expected.internalTarget,
        status: 'unverifiable',
        reason: '',
        evidence: [],
        excluded: expected.excluded,
      };
      findings.push(f);
      if (expected.excluded) {
        f.reason = `Explicitly excluded: ${expected.excluded}`;
        continue;
      }
      if (pdf.error || !normalize(text)) {
        f.reason = pdf.error ?? 'No usable text layer. OCR is outside v0.1.';
        continue;
      }
      if (
        manifest.sections.filter((s) => normalize(s.anchor) === normalize(section.anchor)).length >
        1
      ) {
        f.status = 'manual';
        f.reason =
          'Multiple selected sections share the same anchor. One PDF occurrence cannot establish which section survived.';
        continue;
      }
      if (!certain) {
        f.status = 'manual';
        f.reason =
          'Section boundaries are missing, repeated, or out of order. A match elsewhere cannot establish preservation.';
        continue;
      }
      const headers = section.headers.filter((h) => normalize(h) === normalize(expected.text));
      if (headers.length && (expected.role !== 'table-header' || headers.length > 1)) {
        f.status = 'manual';
        f.reason =
          'This expectation is indistinguishable from a repeating table header. Header copies cannot establish preservation of a separate record or text.';
        continue;
      }
      const candidates = find(expected.text).filter((m) => m.start >= low && m.end <= high);
      // Link labels may overlap text/rows; each link annotation is consumed separately.
      const consumed = expected.kind === 'link' ? usedLinkLabels : used;
      const m = candidates.find((m) => !consumed.some((u) => m.start < u.end && m.end > u.start));
      if (!m) {
        if (expected.internalTarget?.issue) {
          f.status = 'manual';
          f.reason = targetIssues[expected.internalTarget.issue];
          continue;
        }
        if (
          !candidates.length &&
          expected.kind === 'row' &&
          expected.cells?.every((cell) =>
            find(cell).some((hit) => hit.start >= low && hit.end <= high),
          )
        ) {
          f.status = 'manual';
          f.reason =
            'Cell values exist in this section, but do not form a complete ordered row. Reading order or row association requires manual inspection.';
          f.evidence = expected.cells.flatMap((cell) => {
            const hit = find(cell).find((hit) => hit.start >= low && hit.end <= high);
            return hit ? evidence(hit) : [];
          });
          continue;
        }
        const emptyPage = pdf.pages.some((p) => !normalize(p.text));
        f.status = emptyPage ? 'manual' : 'mismatch';
        f.reason = emptyPage
          ? 'Expected text is absent, but a page has no text layer. Inspect that page manually.'
          : candidates.length
            ? 'Not enough independent occurrences inside this section.'
            : 'Expected text/row is absent inside the established section boundaries.';
        continue;
      }
      f.evidence = evidence(m);
      if (expected.kind !== 'link') used.push(m);
      if (expected.kind === 'row') {
        // Cell boundaries must coincide with complete extraction items. Flattening
        // cells would accept ["A B", "C"] in place of ["A", "B C"].
        let offset = m.start;
        let cellsCertain = true;
        let previousCell: Evidence | undefined;
        for (const cell of expected.cells ?? []) {
          const value = normalize(cell);
          if (!value) {
            cellsCertain = false;
            break;
          }
          const hit = find(cell).find((h) => h.start >= offset && h.end <= m.end);
          if (
            !hit ||
            spans.some(
              (s) =>
                (s.start < hit.start && s.end > hit.start) ||
                (s.start < hit.end && s.end > hit.end),
            )
          ) {
            cellsCertain = false;
            break;
          }
          const items = evidence(hit);
          const first = items[0];
          const last = items.at(-1);
          const gapLimit = Math.max(3, (first?.box.height ?? 10) * 0.5);
          if (
            !first ||
            !last ||
            (previousCell &&
              (previousCell.page !== first.page ||
                first.box.x - previousCell.box.x - previousCell.box.width <= gapLimit)) ||
            items.some(
              (item, i) =>
                i > 0 && item.box.x - items[i - 1].box.x - items[i - 1].box.width > gapLimit,
            )
          ) {
            cellsCertain = false;
            break;
          }
          previousCell = last;
          offset = hit.end;
        }
        if (!cellsCertain) {
          f.status = 'manual';
          f.reason =
            'Cell values exist in this section, but do not form a complete ordered row. Reading order or row association requires manual inspection.';
          continue;
        }
        // Adjacent rows must not combine into an invented record. Require a single baseline,
        // or a contiguous wrapped row with no unusually large vertical/page jump.
        const ev = f.evidence;
        const lines = [...new Set(ev.map((e) => `${e.page}:${Math.round(e.box.y / 3)}`))];
        if (lines.length > 1) {
          f.status = 'manual';
          f.reason =
            'Row text matches, but spans multiple baselines/pages. Cell-to-row geometry requires visual confirmation.';
          continue;
        }
      }
      if (expected.kind === 'link') {
        usedLinkLabels.push(m);
        if (expected.internalTarget) {
          const localized =
            candidates.length === 1 &&
            wholeItems(m) &&
            !!f.evidence.length &&
            isSingleLabel(f.evidence);
          if (localized && !expected.internalTarget.labelInHeading) tocLabels.set(m.start, m.end);
          pendingLinks.push({ f, target: expected.internalTarget, localized });
          continue;
        }
        const completeLabel = wholeItems(m);
        const nearby = pdf.links
          .map((l, i) => ({ l, i }))
          .filter(
            ({ l, i }) =>
              completeLabel &&
              l.href !== undefined &&
              !usedLinks.has(i) &&
              coversLabel(l, f.evidence),
          );
        const exact =
          nearby.length === 1 && nearby[0].l.href === expected.href ? nearby[0] : undefined;
        if (exact) {
          usedLinks.add(exact.i);
          f.actualHref = exact.l.href;
        } else if (nearby.length === 1) {
          usedLinks.add(nearby[0].i);
          f.actualHref = nearby[0].l.href;
          f.status = 'mismatch';
          f.reason = 'The PDF link annotation at this label has a different destination.';
          continue;
        } else {
          f.status = 'manual';
          f.reason =
            'Link label is present, but a unique URL annotation could not be associated with it.';
          continue;
        }
      }
      f.status = 'found';
      f.reason =
        expected.kind === 'link'
          ? 'Label and URL annotation found in this section. Visibility still requires visual inspection.'
          : 'Independent occurrence found in this section’s text layer. This does not prove visibility.';
    }
  }
  for (const { f, target, localized } of pendingLinks) checkInternalLink(f, target, localized);
  const active = findings.filter((f) => !f.excluded);
  const status: Status = active.some((f) => f.status === 'mismatch')
    ? 'mismatch'
    : active.some((f) => f.status === 'unverifiable')
      ? 'unverifiable'
      : active.some((f) => f.status === 'manual')
        ? 'manual'
        : active.length
          ? 'found'
          : 'unverifiable';
  return {
    schema: 'printwitness-report/1',
    createdAt: new Date().toISOString(),
    manifest,
    pdf: { ...identity, pages: pdf.pages },
    status,
    findings,
    warnings: [
      'Text-layer presence does not prove visibility. Clipping, overlays and transparency are not universally detected.',
      ...pdf.warnings,
    ],
  };
}
