import type { Report } from '../core/types.ts';
import {
  defaultLocale,
  destinationLabel,
  diagnostic,
  findingSection,
  kindLabel,
  type Locale,
  paginationLabels,
  statusLabel,
  translator,
} from '../i18n/index.ts';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
export function reportHtml(
  report: Report,
  images: string[],
  locale: Locale = defaultLocale,
): string {
  const t = translator(locale);
  const total = report.pdf.pageCount ?? (report.pdf.pages.length || '—');
  const findings = report.findings
    .map((f) => {
      const pagination = paginationLabels(locale, f);
      const expected = f.kind === 'page-count' ? '' : `<p>${escapeHtml(f.expected)}</p>`;
      const target = pagination
        ? `<p>${escapeHtml(pagination.expected)}<br>${escapeHtml(pagination.actual)}</p>`
        : f.internalTarget
          ? `<p>${escapeHtml(t('expectedHeading'))}: ${escapeHtml(f.internalTarget.heading ?? t('unresolved'))} <code>${escapeHtml(f.href ?? '')}</code><br>${escapeHtml(t('actualDestination'))}: ${escapeHtml(destinationLabel(locale, f.actualDestination, f.actualHref))}</p>`
          : f.href
            ? `<p>${escapeHtml(t('expectedUrl'))}: <code>${escapeHtml(f.href)}</code><br>${escapeHtml(t('actualUrl'))}: <code>${escapeHtml(f.actualHref ?? t('unresolved'))}</code></p>`
            : '';
      return `<li class="${f.status}"><a href="#${f.evidence.length ? `page-${f.evidence[0].page}` : 'pages'}" data-finding="${escapeHtml(f.id)}"><strong>${escapeHtml(f.excluded ? t('excluded') : statusLabel(locale, f.status, f.kind === 'page-count'))}</strong> · ${escapeHtml(findingSection(locale, f))} · ${escapeHtml(kindLabel(locale, f.kind))}</a>${expected}${target}<small>${escapeHtml(diagnostic(locale, f.reason))}</small></li>`;
    })
    .join('');
  const pages = report.pdf.pages
    .map(
      (p, i) =>
        `<figure id="page-${p.number}"><figcaption>${escapeHtml(t('pageOf', { page: p.number, total }))}</figcaption><div class="page" style="aspect-ratio:${p.width}/${p.height}">${images[i] ? `<img alt="${escapeHtml(t('pdfPage', { page: p.number }))}" src="${images[i]}">` : `<p>${escapeHtml(t('previewUnavailable'))}</p>`}<svg viewBox="0 0 ${p.width} ${p.height}" role="img" aria-label="${escapeHtml(t('evidenceLabel'))}">${report.findings.flatMap((f) => f.evidence.filter((e) => e.page === p.number).map((e) => `<rect data-evidence="${escapeHtml(f.id)}" x="${e.box.x}" y="${e.box.y}" width="${e.box.width}" height="${e.box.height}"/>`)).join('')}</svg></div></figure>`,
    )
    .join('');
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(report.createdAt),
  );
  const status = statusLabel(
    locale,
    report.status,
    report.manifest.pagination?.pageCount !== undefined,
  );
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(t('reportTitle'))}</title><style>
  *{box-sizing:border-box}body{font:15px/1.5 system-ui;margin:0;color:#262626;background:#e6e4e0}header{padding:40px;background:#e6e4e0;border-bottom:1px solid #c8c4bc;overflow-wrap:anywhere}h1{font:400 48px/1.1 Georgia,serif;letter-spacing:-.035em;margin:0 0 20px}h1 small{font:12px system-ui}main{display:grid;grid-template-columns:minmax(300px,420px) minmax(0,1fr);gap:32px;padding:32px}ul{list-style:none;padding:0;margin:0;min-width:0}li{background:white;border:1px solid #d8d5cf;border-left:3px solid #99958e;border-radius:10px;padding:20px;margin-bottom:10px;overflow-wrap:anywhere}.mismatch{border-color:#9c3930}.found{border-color:#43634e}.manual{border-color:#80601f}a{color:inherit}small{color:#686660}figure{margin:0 auto 24px;max-width:850px}figcaption{margin-bottom:8px}.page{background:white;position:relative;border:1px solid #c5c1b9}.page img,.page svg{position:absolute;inset:0;width:100%;height:100%}.page svg{pointer-events:none}rect{display:none;fill:#dbc77c;fill-opacity:.35;stroke:#80601f;stroke-width:.6}rect.active{display:block}p{white-space:pre-wrap}@media(max-width:750px){main{grid-template-columns:1fr;padding:12px}}@media print{main{display:block}figure{break-before:page}rect{display:none}}
  </style></head><body><header><h1>PrintWitness <small>v0.1</small></h1><strong>${escapeHtml(status)}</strong><p>${escapeHtml(report.pdf.name)} · ${escapeHtml(t('pageCount', { count: total }))} · ${escapeHtml(date)}<br>${escapeHtml(t('pdfHash'))}: ${escapeHtml(report.pdf.sha256)}<br>${escapeHtml(t('sourceHash'))}: ${escapeHtml(report.manifest.source.sha256)}</p>${report.warnings.map((w) => `<p>${escapeHtml(diagnostic(locale, w))}</p>`).join('')}</header><main><ul>${findings}</ul><section id="pages" aria-label="${escapeHtml(t('pdfViewer'))}">${pages || `<p>${escapeHtml(t('noReadablePages'))}</p>`}</section></main><script>document.querySelectorAll('[data-finding]').forEach(a=>a.addEventListener('click',()=>{document.querySelectorAll('[data-evidence]').forEach(r=>r.classList.toggle('active',r.dataset.evidence===a.dataset.finding))}));</script></body></html>`;
}
