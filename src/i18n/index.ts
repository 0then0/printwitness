import type { Expectation, PdfDestination, Status } from '../core/types.ts';
import { messages as de } from './de.ts';
import { en, type MessageKey, type Messages } from './en.ts';
import { messages as es } from './es.ts';
import { messages as fr } from './fr.ts';
import { messages as ja } from './ja.ts';
import { messages as ptBR } from './pt-BR.ts';
import { messages as ru } from './ru.ts';

export const locales = ['en', 'es', 'de', 'fr', 'ja', 'pt-BR', 'ru'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';
export const localeNames: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  de: 'Deutsch',
  fr: 'Français',
  ja: '日本語',
  'pt-BR': 'Português (Brasil)',
  ru: 'Русский',
};
export const catalogs: Record<Locale, Messages> = { en, es, de, fr, ja, 'pt-BR': ptBR, ru };
export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && locales.some((locale) => locale === value);
export function translator(locale: Locale) {
  let numbers: Intl.NumberFormat | undefined;
  return (key: MessageKey, params: Record<string, string | number> = {}): string =>
    catalogs[locale][key].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
      const value = params[name];
      if (value === undefined) return placeholder;
      if (typeof value !== 'number') return value;
      numbers ??= new Intl.NumberFormat(locale);
      return numbers.format(value);
    });
}
const statusKeys: Record<Status, MessageKey> = {
  found: 'statusFound',
  mismatch: 'statusMismatch',
  manual: 'statusManual',
  unverifiable: 'statusUnverifiable',
};
const kindKeys: Record<Expectation['kind'], MessageKey> = {
  text: 'kindText',
  row: 'kindRow',
  link: 'kindLink',
};
export const statusLabel = (locale: Locale, status: Status) =>
  translator(locale)(statusKeys[status]);
export const kindLabel = (locale: Locale, kind: Expectation['kind']) =>
  translator(locale)(kindKeys[kind]);
export function destinationLabel(locale: Locale, destination?: PdfDestination, href?: string) {
  const t = translator(locale);
  if (destination?.page === undefined) return href ?? t('unresolved');
  const page = t('pageShort', { page: destination.page });
  return destination.y === undefined
    ? page
    : `${page} · ${t('destinationY', { y: destination.y })}`;
}

// Core/JSON diagnostics stay stable across locales. Only presentation is translated.
// Known messages are centralized here so the UI and standalone reports cannot drift.
export const diagnosticKeys: Record<string, MessageKey> = {
  'No usable text layer. OCR is outside v0.1.': 'reasonNoText',
  'Multiple selected sections share the same anchor. One PDF occurrence cannot establish which section survived.':
    'reasonSharedAnchor',
  'Section boundaries are missing, repeated, or out of order. A match elsewhere cannot establish preservation.':
    'reasonBoundaries',
  'This expectation is indistinguishable from a repeating table header. Header copies cannot establish preservation of a separate record or text.':
    'reasonHeader',
  'Cell values exist in this section, but do not form a complete ordered row. Reading order or row association requires manual inspection.':
    'reasonCells',
  'Expected text is absent, but a page has no text layer. Inspect that page manually.':
    'reasonEmptyPage',
  'Not enough independent occurrences inside this section.': 'reasonOccurrences',
  'Expected text/row is absent inside the established section boundaries.': 'reasonMissing',
  'Row text matches, but spans multiple baselines/pages. Cell-to-row geometry requires visual confirmation.':
    'reasonWrappedRow',
  'The PDF link annotation at this label has a different destination.': 'reasonChangedUrl',
  'Link label is present, but a unique URL annotation could not be associated with it.':
    'reasonLinkManual',
  'Link label is present, but a unique URL annotation could not be associated with it. Internal PDF destinations are not resolved in v0.1.':
    'reasonLinkManual',
  'Label and URL annotation found in this section. Visibility still requires visual inspection.':
    'reasonLinkFound',
  'The source fragment has no matching element ID.': 'reasonFragmentMissing',
  'The source fragment matches more than one element ID.': 'reasonFragmentDuplicate',
  'The source fragment targets an element other than an HTML heading.': 'reasonFragmentNotHeading',
  'The source heading has no usable text for matching.': 'reasonSourceHeadingText',
  'The expected heading text also occurs elsewhere in the source.': 'reasonSourceHeadingRepeated',
  'The internal link label cannot be located unambiguously.': 'reasonInternalLabel',
  'No PDF link annotation covers the uniquely located internal link label.':
    'reasonInternalAnnotationMissing',
  'A unique PDF link annotation could not be associated with the internal link label.':
    'reasonInternalAnnotationManual',
  'The link annotation has no resolvable internal PDF destination.': 'reasonInternalUnresolved',
  'The expected heading could not be uniquely located in the PDF text layer.':
    'reasonPdfHeadingManual',
  'The internal link points to a different page from the expected heading.':
    'reasonInternalWrongPage',
  'The internal destination gives no usable vertical position on the expected page.':
    'reasonInternalPageOnly',
  'The vertical destination could not be associated with a unique heading.':
    'reasonInternalPosition',
  'The internal link destination aligns with the expected heading.': 'reasonInternalFound',
  'The internal link points to a different heading on the same page.': 'reasonInternalWrongHeading',
  'Independent occurrence found in this section’s text layer. This does not prove visibility.':
    'reasonFound',
  'Text-layer presence does not prove visibility. Clipping, overlays and transparency are not universally detected.':
    'warningVisibility',
  'Rotated or vertical text is not reliably mapped by v0.1. Inspect this PDF manually.':
    'reasonRotated',
  'Invalid source options. Timeout must be 100–60000 ms.': 'errorOptions',
  'Only local HTML files and loopback HTTP(S) URLs are supported.': 'errorLocalOnly',
  'Choose an .html or .htm file.': 'errorHtmlFile',
  'Selected elements overlap. Choose disjoint sections or tables.': 'errorOverlap',
  'Maximum 100 selected sections.': 'errorSections',
  'PDF export timed out': 'errorPrintTimeout',
  'PDF exceeds 25 MiB.': 'errorPdfSize',
  'Invalid base64 PDF': 'errorPdfRead',
  'Invalid manifest: expected printwitness/1 with non-empty sections and unique IDs.':
    'errorManifest',
  'Another operation is running. Wait for it to finish.': 'errorBusy',
  'Report expired or server restarted. Run the check again.': 'errorExpired',
  'v0.1 supports up to 100 PDF pages.': 'errorPageLimit',
  'Request exceeds 40 MiB. PDF limit is 25 MiB.': 'errorRequestSize',
  'Operation failed': 'operationFailed',
};
export function diagnostic(locale: Locale, message: string): string {
  const t = translator(locale);
  if (message.startsWith('Explicitly excluded: '))
    return t('reasonExcluded', { reason: message.slice('Explicitly excluded: '.length) });
  message = message.split('\n')[0];
  const exact = Object.hasOwn(diagnosticKeys, message) ? diagnosticKeys[message] : undefined;
  if (exact) return t(exact);
  const patterns: [RegExp, MessageKey, string][] = [
    [
      /^PDF runtime resource unavailable: (.*)\. Processing is incomplete\.$/,
      'errorPdfResource',
      'resource',
    ],
    [/^Explicitly excluded: (.*)$/s, 'reasonExcluded', 'reason'],
    [
      /^(?:page\.evaluate: (?:Error: )?)?Selector matches no elements: (.+)$/s,
      'errorNoSelector',
      'selector',
    ],
    [
      /^(?:page\.evaluate: (?:Error: )?)?Selected element is excluded: (.+)$/s,
      'errorExcluded',
      'selector',
    ],
    [/^(?:page\.evaluate: (?:Error: )?)?No expected content: (.+)$/s, 'errorNoContent', 'selector'],
    [
      /^(?:page\.evaluate: (?:Error: )?)?Section (.+) needs a heading \(h1–h6\), inside it or preceding it\.$/s,
      'errorHeadingRequired',
      'selector',
    ],
    [
      /^(?:page\.evaluate: (?:Error: )?)?Table (.+) shares a heading with other tables\..*$/s,
      'errorSharedTables',
      'selector',
    ],
    [/^Page (\d+): rotated\/vertical text needs manual inspection\.$/, 'warningRotated', 'page'],
    [/^Page (\d+): preview could not be rendered\.$/, 'warningPreview', 'page'],
  ];
  for (const [pattern, key, parameter] of patterns) {
    const match = message.match(pattern);
    if (match) return t(key, { [parameter]: parameter === 'page' ? Number(match[1]) : match[1] });
  }
  const stripped = message.replace(/^page\.evaluate: (?:Error: )?/, '');
  if (Object.hasOwn(diagnosticKeys, stripped)) return t(diagnosticKeys[stripped]);
  if (message.startsWith('Cannot read PDF:'))
    return t(message.includes('100 PDF pages') ? 'errorPageLimit' : 'errorPdfRead');
  if (/Timeout.*exceeded|TimeoutError/is.test(message)) return t('errorTimeout');
  if (/ENOENT|EACCES|EPERM/.test(message)) return t('errorFile');
  if (/not a valid selector|invalid selector|querySelector.*SyntaxError/is.test(message))
    return t('errorSelectorSyntax');
  if (/JSON|Unexpected token|Unexpected end|Expected property name/i.test(message))
    return t('errorJson');
  if (/browserType\.launch|Executable doesn't exist/.test(message)) return t('errorBrowser');
  return t('operationFailed');
}
