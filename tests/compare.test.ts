import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare } from '../src/core/compare.ts';
import { parseManifest } from '../src/core/manifest.ts';
import { normalize } from '../src/core/normalize.ts';
import type { Expectation, Manifest, PdfIndex, PdfToken } from '../src/core/types.ts';

const exp = (text: string, extra: Partial<Expectation> = {}): Expectation => ({
  id: text,
  text,
  kind: 'text',
  ...extra,
});
const manifest = (entries: Expectation[]): Manifest => ({
  schema: 'printwitness/1',
  createdAt: '2026-10-23',
  source: { name: 'test', sha256: 'test', readiness: 'dom' },
  exclusions: [],
  sections: [
    {
      id: 's1',
      title: 'Required',
      selector: '#required',
      anchor: 'Required',
      before: 'Title',
      after: 'Appendix',
      endContext: 'Appendix',
      startContext: 'Title',
      anchorInside: true,
      headers: [],
      expectations: entries,
    },
  ],
});
function index(lines: string[]): PdfIndex {
  const tokens = lines.map(
    (text, i): PdfToken => ({
      text,
      page: 1,
      lineEnd: true,
      box: { x: 10, y: 20 + i * 20, width: text.length * 6, height: 10 },
    }),
  );
  return {
    pages: [{ number: 1, width: 600, height: 800, text: lines.join(' ') }],
    tokens,
    links: [],
    warnings: [],
  };
}
const check = (m: Manifest, p: PdfIndex) => compare(m, p, { name: 'test.pdf', sha256: 'test' });
test('duplicate in a different section never covers a loss', () => {
  const r = check(
    manifest([exp('Must survive')]),
    index(['Title', 'Required', 'Appendix', 'Must survive']),
  );
  assert.equal(r.findings[0].status, 'mismatch');
});
test('occurrences are consumed; repeating headings cannot replenish paragraphs', () => {
  const m = manifest([exp('Approval', { id: 'a1' }), exp('Approval', { id: 'a2' })]);
  const r = check(m, index(['Title', 'Required', 'Approval', 'Appendix', 'Approval']));
  assert.deepEqual(
    r.findings.map((f) => f.status),
    ['found', 'mismatch'],
  );
});
test('separately selected sections sharing one anchor cannot reuse a PDF occurrence', () => {
  const m = manifest([exp('Approval', { id: 'one' })]);
  m.sections.push({
    ...m.sections[0],
    id: 's2',
    selector: '#second',
    expectations: [exp('Approval', { id: 'two' })],
  });
  assert.deepEqual(
    check(m, index(['Title', 'Required', 'Approval', 'Appendix'])).findings.map((f) => f.status),
    ['manual', 'manual'],
  );
});
test('complete hidden section is missing within surviving neighbour anchors', () => {
  const r = check(
    manifest([exp('Required'), exp('Secret terms')]),
    index(['Title', 'Appendix', 'Secret terms']),
  );
  assert.deepEqual(
    r.findings.map((f) => f.status),
    ['mismatch', 'mismatch'],
  );
});
test('missing and ambiguous context require manual review', () => {
  const m = manifest([exp('Terms')]);
  for (const lines of [['Terms'], ['Title', 'Required', 'Terms', 'Required', 'Appendix']])
    assert.equal(check(m, index(lines)).status, 'manual');
});
test('a wholly absent selected section does not invalidate the previous table boundary', () => {
  const m = manifest([exp('Row A', { kind: 'row', cells: ['Row A'] })]);
  m.sections[0].after = 'Hidden';
  m.sections[0].endContext = 'Hidden';
  m.sections.push({
    ...m.sections[0],
    id: 's2',
    title: 'Hidden',
    anchor: 'Hidden',
    before: 'Required',
    after: 'Appendix',
    endContext: 'Appendix',
    expectations: [exp('Hidden terms')],
  });
  const r = check(m, index(['Title', 'Required', 'Row A', 'Appendix', 'Hidden terms']));
  assert.deepEqual(
    r.findings.map((f) => f.status),
    ['found', 'mismatch'],
  );
  // When the heading alone is missing, surviving content cannot leak into the table.
  assert.equal(
    check(m, index(['Title', 'Required', 'Row A', 'Hidden terms', 'Appendix'])).findings[0].status,
    'manual',
  );
});
test('Unicode composition, compatibility ligatures, NBSP and soft hyphens', () => {
  assert.equal(normalize('café\u00a0ﬁnal\u00ad'), 'café final');
  assert.equal(
    check(
      manifest([exp('café final Москва')]),
      index(['Title', 'Required', 'café ﬁnal\u00a0Москва', 'Appendix']),
    ).status,
    'found',
  );
});
test('line breaks and discretionary line-end hyphens preserve word matching', () => {
  const m = manifest([exp('A mandatory confirmation')]);
  assert.equal(
    check(m, index(['Title', 'Required', 'A mandatory con-', 'firmation', 'Appendix'])).status,
    'found',
  );
});
test('substrings of record numbers and words cannot satisfy a record', () => {
  assert.equal(
    check(manifest([exp('PW-042')]), index(['Title', 'Required', 'PW-0420', 'Appendix'])).status,
    'mismatch',
  );
});
test('cell values scattered across rows do not establish a body record', () => {
  const r = check(
    manifest([exp('ID-1 Alice 100', { kind: 'row', cells: ['ID-1', 'Alice', '100'] })]),
    index(['Title', 'Required', 'ID-1', 'Alice', '100', 'Appendix']),
  );
  assert.equal(r.status, 'manual');
});
test('merged row items need review and repeating headers do not mask a lost record', () => {
  const m = manifest([
    exp('ID-1 Alice 100', { kind: 'row', cells: ['ID-1', 'Alice', '100'] }),
    exp('ID-2 Bob 200', { kind: 'row', cells: ['ID-2', 'Bob', '200'] }),
  ]);
  m.sections[0].headers = ['ID Name Amount'];
  assert.deepEqual(
    check(
      m,
      index([
        'Title',
        'Required',
        'ID Name Amount',
        'ID-1 Alice 100',
        'ID Name Amount',
        'Appendix',
      ]),
    ).findings.map((f) => f.status),
    ['manual', 'mismatch'],
  );
});
test('body row identical to a header remains ambiguous', () => {
  const m = manifest([exp('ID Name', { kind: 'row', cells: ['ID', 'Name'] })]);
  m.sections[0].headers = ['ID Name'];
  assert.equal(check(m, index(['Title', 'Required', 'ID Name', 'Appendix'])).status, 'manual');
});
test('repeated table headers cannot replenish an identical missing paragraph', () => {
  const m = manifest([
    exp('ID Name', { id: 'paragraph' }),
    exp('ID Name', { id: 'header', role: 'table-header' }),
  ]);
  m.sections[0].headers = ['ID Name'];
  assert.deepEqual(
    check(m, index(['Title', 'Required', 'ID Name', 'ID Name', 'Appendix'])).findings.map(
      (f) => f.status,
    ),
    ['manual', 'found'],
  );
});
test('reordered cell extraction cannot become a confirmed missing-row claim', () => {
  const m = manifest([exp('ID-1 Alice 100', { kind: 'row', cells: ['ID-1', 'Alice', '100'] })]);
  assert.equal(
    check(m, index(['Title', 'Required', 'Alice', '100', 'ID-1', 'Appendix'])).status,
    'manual',
  );
});
test('changed URL is detected at its label, unrelated correct URL cannot satisfy it', () => {
  const m = manifest([exp('Read guide', { kind: 'link', href: 'https://example.org/good' })]);
  const p = index(['Title', 'Required', 'Read guide', 'Other guide', 'Appendix']);
  p.links = [
    { page: 1, box: p.tokens[2].box, href: 'https://example.org/bad' },
    { page: 1, box: p.tokens[3].box, href: 'https://example.org/good' },
  ];
  assert.equal(check(m, p).status, 'mismatch');
});
test('repeated link labels each need an independent annotation', () => {
  const m = manifest([
    exp('guide', { id: 'a1', kind: 'link', href: 'https://example.org/' }),
    exp('guide', { id: 'a2', kind: 'link', href: 'https://example.org/' }),
  ]);
  const p = index(['Title', 'Required', 'guide', 'guide', 'Appendix']);
  p.links = [2, 3].map((i) => ({ page: 1, box: p.tokens[i].box, href: 'https://example.org/' }));
  assert.equal(check(m, p).status, 'found');
});
test('no annotation is manual, unreadable or image-only PDFs are unverifiable', () => {
  assert.equal(
    check(
      manifest([exp('guide', { kind: 'link', href: 'https://example.org/' })]),
      index(['Title', 'Required', 'guide', 'Appendix']),
    ).status,
    'manual',
  );
  assert.equal(check(manifest([exp('Required')]), index([])).status, 'unverifiable');
  const p = index(['Title', 'Required', 'Appendix']);
  p.error = 'Encrypted document';
  assert.equal(check(manifest([exp('Required')]), p).status, 'unverifiable');
});
test('an empty-text page prevents confident absence claims for mixed PDFs', () => {
  const p = index(['Title', 'Required', 'Appendix']);
  p.pages.push({ number: 2, width: 600, height: 800, text: '' });
  assert.equal(check(manifest([exp('Missing')]), p).status, 'manual');
});
test('explicit exclusions are retained and never produce an all-excluded pass', () => {
  const m = manifest([exp('Missing', { excluded: 'Screen only' })]);
  assert.equal(check(m, index(['Title', 'Required', 'Appendix'])).status, 'unverifiable');
  assert.equal(check(m, index([])).findings[0].excluded, 'Screen only');
});
test('portable manifest validation rejects duplicate IDs and malformed records', () => {
  const m = manifest([exp('hello')]);
  assert.deepEqual(parseManifest(JSON.parse(JSON.stringify(m))), m);
  for (const bad of [
    null,
    {},
    { ...m, schema: 'future' },
    manifest([exp('hello'), exp('hello')]),
    manifest([exp('row', { kind: 'row' })]),
    manifest([exp('link', { kind: 'link' })]),
  ])
    assert.throws(() => parseManifest(bad), /Invalid manifest/);
});

test('unbounded legacy manifests cannot accept foreign text after the selected element', () => {
  const m = manifest([exp('Approval')]);
  delete m.sections[0].endContext;
  m.sections[0].after = null;
  assert.equal(check(m, index(['Title', 'Required', 'Approval'])).status, 'manual');
  m.sections[0].endContext = 'Approval';
  assert.notEqual(check(m, index(['Title', 'Required', 'Approval'])).status, 'found');
});
test('table cell partitions cannot be established by flattened text', () => {
  const m = manifest([exp('A B C', { kind: 'row', cells: ['A B', 'C'] })]);
  const p = index(['Title', 'Required', 'A', 'B C', 'Appendix']);
  p.tokens[3].box = { x: 50, y: p.tokens[2].box.y, width: 40, height: 10 };
  assert.equal(check(m, p).status, 'manual');
  m.sections[0].expectations[0].cells = ['A', 'B C'];
  assert.equal(check(m, p).status, 'found');
});
test('merged text items cannot lend unrelated URL annotations to individual labels', () => {
  const m = manifest([exp('alpha', { kind: 'link', href: 'https://example.org/alpha' })]);
  const p = index(['Title', 'Required', 'alpha beta', 'Appendix']);
  p.links = [{ page: 1, box: p.tokens[2].box, href: 'https://example.org/alpha' }];
  assert.equal(check(m, p).status, 'manual');
});
test('Japanese line wraps preserve continuous text', () => {
  assert.equal(
    check(
      manifest([exp('この文書には重要な情報があります。確認してください。')]),
      index([
        'Title',
        'Required',
        'この文書には重要な',
        '情報があります。確認してください。',
        'Appendix',
      ]),
    ).status,
    'found',
  );
});
test('manifest validation rejects coerced discriminators and malformed optional values', () => {
  for (const extra of [
    { kind: ['link'] },
    { href: {} },
    { cells: {} },
    { role: 'table-header', kind: 'row', cells: ['hello'] },
  ]) {
    const m = manifest([exp('hello')]);
    Object.assign(m.sections[0].expectations[0], extra);
    assert.throws(() => parseManifest(m), /Invalid manifest/);
  }
});

test('partial or overlapping URL rectangles do not establish a unique label destination', () => {
  const m = manifest([exp('Read guide', { kind: 'link', href: 'https://example.org/good' })]);
  const p = index(['Title', 'Required', 'Read guide', 'Appendix']);
  p.links = [{ page: 1, box: { ...p.tokens[2].box, width: 12 }, href: 'https://example.org/good' }];
  assert.equal(check(m, p).status, 'manual');
  p.links = ['good', 'bad'].map((value) => ({
    page: 1,
    box: p.tokens[2].box,
    href: `https://example.org/${value}`,
  }));
  assert.equal(check(m, p).status, 'manual');
});

const contentsLink = () =>
  manifest([
    exp('Read guide', {
      kind: 'link',
      href: '#appendix',
      internalTarget: { fragment: 'appendix', heading: 'Appendix' },
    }),
  ]);

test('a lone copy of a repeated end marker cannot distinguish the label from the boundary', () => {
  const m = contentsLink();
  [m.sections[0].expectations[0].text, m.sections[0].endContextNext] = ['Appendix', 'Terms'];
  const only = index(['Title', 'Required', 'Appendix', 'Terms']);
  only.linkAnnotationPages = [1];
  assert.equal(check(m, only).status, 'manual');
});

test('an internal label must be unique and fully localized before a missing annotation is a mismatch', () => {
  const m = contentsLink();
  const make = (...labels: string[]) => index(['Title', 'Required', ...labels, 'Appendix']);
  const plain = make('Read guide');
  assert.equal(check(m, plain).status, 'manual', 'the annotation scan did not complete');
  plain.linkAnnotationPages = [1];
  assert.equal(check(m, plain).status, 'mismatch');

  const repeated = make('Read guide', 'Read guide');
  repeated.linkAnnotationPages = [1];
  repeated.links = [{ page: 1, box: repeated.tokens[2].box, destination: { page: 1, y: 100 } }];
  assert.match(check(m, repeated).findings[0].reason, /label cannot be located unambiguously/);

  const columns = make('Read', 'guide');
  columns.linkAnnotationPages = [1];
  columns.tokens[3].box = { ...columns.tokens[3].box, x: 400, y: columns.tokens[2].box.y };
  assert.equal(check(m, columns).status, 'manual', 'two columns cannot form one link label');

  plain.links = [{ page: 1, box: { ...plain.tokens[2].box, width: 12 } }];
  assert.equal(check(m, plain).status, 'manual', 'a partial annotation makes absence uncertain');
});

test('a destination needs independent, unambiguous heading geometry', () => {
  const m = contentsLink();
  m.headingTexts = ['Appendix', 'Nearby heading'];
  const p = index(['Title', 'Required', 'Read guide', 'Appendix', 'Nearby heading']);
  const y = p.tokens[3].box.y;
  p.tokens[4].box.y = y + 6;
  const dest = { page: 1, y: y + 3 };
  p.links = [{ page: 1, box: p.tokens[2].box, destination: dest }];
  assert.match(check(m, p).findings[0].reason, /could not be associated with a unique heading/);
  dest.y = y - 10;
  assert.equal(check(m, p).status, 'manual', 'whitespace above the heading is insufficient');
  dest.y = y;
  assert.equal(check(m, p).status, 'found');

  // Keep the section boundary usable while adding a second copy of the target text.
  m.sections[0].endContext = 'Nearby heading';
  p.tokens.push({ ...p.tokens[3], box: { ...p.tokens[3].box, y: 180 } });
  m.sections[0].after = 'Nearby heading';
  assert.match(check(m, p).findings[0].reason, /expected heading could not be uniquely located/);
});

test('new optional manifest fields are validated before use', () => {
  const valid = contentsLink();
  assert.deepEqual(parseManifest(valid), valid);
  for (const internalTarget of [
    {},
    { fragment: 'appendix' },
    { fragment: '', heading: 'Appendix' },
    { fragment: 'appendix', issue: 'unknown' },
    { fragment: 'appendix', heading: 'Appendix', labelInHeading: 'true' },
  ]) {
    const malformed = structuredClone(valid);
    Object.assign(malformed.sections[0].expectations[0], { internalTarget });
    assert.throws(() => parseManifest(malformed), /Invalid manifest/);
  }
});
