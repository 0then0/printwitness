import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { paginationFindings } from '../core/pagination.ts';
import type { Finding, Manifest, Report, Status } from '../core/types.ts';
import type { MessageKey } from '../i18n/en.ts';
import {
  defaultLocale,
  destinationLabel,
  diagnostic,
  findingSection,
  isLocale,
  kindLabel,
  type Locale,
  localeNames,
  locales,
  paginationLabels,
  statusLabel,
  translator,
} from '../i18n/index.ts';
import './style.css';

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(
    `/api/${path}`,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-PrintWitness': '1' },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? 'Operation failed');
  return data as T;
}
function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function savedLocale(): Locale {
  try {
    const value = localStorage.getItem('printwitness.locale');
    return isLocale(value) ? value : defaultLocale;
  } catch {
    return defaultLocale;
  }
}
type Theme = 'system' | 'light' | 'dark';
const isTheme = (value: unknown): value is Theme =>
  value === 'system' || value === 'light' || value === 'dark';
function savedTheme(): Theme {
  try {
    const value = localStorage.getItem('printwitness.theme');
    return isTheme(value) ? value : 'system';
  } catch {
    return 'system';
  }
}
function App() {
  const [locale, setLocale] = useState<Locale>(savedLocale);
  const t = translator(locale);
  const [theme, setTheme] = useState<Theme>(savedTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('printwitness.theme', theme);
    } catch {
      /* Theme remains usable when storage is unavailable. */
    }
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = translator(locale)('appTitle');
    try {
      localStorage.setItem('printwitness.locale', locale);
    } catch {
      /* Language remains usable when storage is unavailable. */
    }
  }, [locale]);
  const [desktop, setDesktop] = useState(false);
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/runtime', { signal: controller.signal })
      .then((r) => r.json())
      .then((runtime) => {
        if (!controller.signal.aborted) setDesktop(runtime.desktop === true);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const [source, setSource] = useState('');
  const [selectors, setSelectors] = useState('#summary\n#register\n#terms');
  const [exclusions, setExclusions] = useState('');
  const [mode, setMode] = useState<'dom' | 'selector' | 'signal'>('dom');
  const [readyValue, setReadyValue] = useState('');
  const [timeout, setTimeoutValue] = useState(10000);
  const [manifest, setManifest] = useState<Manifest>();
  const [report, setReport] = useState<Report>();
  const [resultId, setResultId] = useState('');
  const [busy, setBusy] = useState<MessageKey | ''>('');
  const [error, setError] = useState('');
  const [setup, setSetup] = useState(true);
  const [selected, setSelected] = useState('');
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [excludeReason, setExcludeReason] = useState('');
  const lines = (s: string) =>
    s
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  const options = () => ({
    source,
    selectors: lines(selectors),
    exclusions: lines(exclusions),
    ready: { mode, value: readyValue, timeout },
  });
  async function run(label: MessageKey, job: () => Promise<void>) {
    setBusy(label);
    setError('');
    try {
      await job();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed');
    } finally {
      setBusy('');
    }
  }
  function clearReport() {
    setReport(undefined);
    setResultId('');
    setPage(1);
  }
  function acceptManifest(m: Manifest) {
    setManifest(m);
    clearReport();
    setSelected(m.sections[0]?.expectations[0]?.id ?? paginationFindings(m)[0]?.id ?? '');
    setFilter('all');
    setSetup(false);
  }
  function acceptResult(value: { id: string; report: Report }) {
    setReport(value.report);
    setResultId(value.id);
    setFilter('all');
    const first =
      value.report.findings.find((f) => f.status === 'mismatch') ?? value.report.findings[0];
    if (first) {
      setSelected(first.id);
      setPage(first.evidence[0]?.page ?? 1);
    }
    setSetup(false);
  }
  const expected =
    manifest?.sections.flatMap((s) =>
      s.expectations.map((e) => ({ ...e, section: s.title, sectionId: s.id })),
    ) ?? [];
  const frozenPagination = manifest ? paginationFindings(manifest) : [];
  const findings: Finding[] = report?.findings ?? [
    ...expected.map((e) => ({
      ...e,
      expected: e.text,
      status: 'unverifiable' as Status,
      reason: '',
      evidence: [],
    })),
    ...frozenPagination,
  ];
  const current = findings.find((f) => f.id === selected);
  const pagination = current && paginationLabels(locale, current);
  const hasPageCount = manifest?.pagination?.pageCount !== undefined;
  const pageCount = report?.pdf.pageCount ?? '—';
  const visible = findings.filter(
    (f) =>
      (filter === 'all' ||
        (filter === 'issues' ? !f.excluded && f.status !== 'found' : f.status === filter)) &&
      `${f.expected} ${f.section} ${f.href ?? ''} ${f.internalTarget?.heading ?? ''}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  const pageInfo = report?.pdf.pages[page - 1];
  const evidence = current?.evidence.filter((e) => e.page === page) ?? [];
  const excludedCount = expected.filter((e) => e.excluded).length;
  if (stopped)
    return (
      <main className="app stopped" role="status">
        <h1>PrintWitness</h1>
        <p>{t('appStopped')}</p>
      </main>
    );
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/icon.svg" alt="" />
          <strong>PrintWitness</strong>
          <span className="version">v0.1</span>
        </div>
        <span className="local">
          <span /> {t('local')}
        </span>
        <label className="language-switch">
          <span>{t('language')}</span>
          <select
            data-testid="language"
            value={locale}
            onChange={(e) => {
              if (isLocale(e.target.value)) setLocale(e.target.value);
            }}
          >
            {locales.map((value) => (
              <option key={value} value={value}>
                {localeNames[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="theme-switch">
          <span id="theme-label">{t('theme')}</span>
          <select
            aria-labelledby="theme-label"
            data-testid="theme"
            value={theme}
            onChange={(e) => {
              if (isTheme(e.target.value)) setTheme(e.target.value);
            }}
          >
            <option value="system">{t('themeSystem')}</option>
            <option value="light">{t('themeLight')}</option>
            <option value="dark">{t('themeDark')}</option>
          </select>
        </label>
        <button
          type="button"
          className="source-toggle"
          onClick={() => setSetup((s) => !s)}
          aria-expanded={setup}
        >
          {t('sourceManifest')}
        </button>
      </header>
      <div className="intro">
        <div>
          <p className="eyebrow">{t('eyebrow')}</p>
          <h1>{t('headline')}</h1>
          <p>{t('intro')}</p>
        </div>
        <button
          type="button"
          className="demo"
          disabled={!!busy}
          onClick={() =>
            void run('openingExample', async () => {
              const d = await api<{ source: string; selectors: string[] }>('demo');
              setSource(d.source);
              setSelectors(d.selectors.join('\n'));
              setExclusions('');
              setMode('signal');
              setReadyValue('PRINTWITNESS_READY');
              setSetup(true);
            })
          }
        >
          {t('openExample')} <span aria-hidden="true">↗</span>
        </button>
      </div>
      {setup && (
        <section className="setup" aria-label={t('sourceRegion')}>
          <div className="source-fields">
            <div className="step">
              <b>01</b>
              <h2>{t('sourceDocument')}</h2>
            </div>
            <label>
              {t('sourcePath')}
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder={t('sourcePlaceholder')}
              />
            </label>
            <p className="hint">{t('sourceHint')}</p>
            <div className="readiness">
              <label>
                {t('readiness')}
                <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                  <option value="dom">{t('domReady')}</option>
                  <option value="selector">{t('selectorReady')}</option>
                  <option value="signal">{t('signalReady')}</option>
                </select>
              </label>
              <label>
                {t('timeout')}
                <input
                  type="number"
                  min="100"
                  max="60000"
                  value={timeout}
                  onChange={(e) => setTimeoutValue(Number(e.target.value))}
                />
              </label>
            </div>
            {mode !== 'dom' && (
              <label>
                {t(mode === 'signal' ? 'signalName' : 'readySelector')}
                <input
                  value={readyValue}
                  onChange={(e) => setReadyValue(e.target.value)}
                  placeholder={mode === 'signal' ? 'PRINTWITNESS_READY' : '[data-ready="true"]'}
                />
              </label>
            )}
          </div>
          <div className="selection-fields">
            <div className="step">
              <b>02</b>
              <h2>{t('requiredContent')}</h2>
            </div>
            <label>
              {t('selectors')}
              <textarea
                value={selectors}
                onChange={(e) => setSelectors(e.target.value)}
                rows={3}
                spellCheck={false}
              />
            </label>
            <label>
              {t('exclusions')}
              <textarea
                value={exclusions}
                onChange={(e) => setExclusions(e.target.value)}
                placeholder=".draft-note"
                rows={2}
                spellCheck={false}
              />
            </label>
            <p className="hint">{t('selectionHint')}</p>
            <div className="actions">
              <button
                type="button"
                className="primary"
                disabled={!!busy || !source.trim()}
                onClick={() =>
                  void run('capturing', async () =>
                    acceptManifest(await api<Manifest>('capture', options())),
                  )
                }
              >
                {t('capture')}
              </button>
              <label className={`file-button ${busy ? 'disabled' : ''}`}>
                {t('importManifest')}
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={!!busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f)
                      void run('readingManifest', async () =>
                        acceptManifest(await api<Manifest>('manifest', JSON.parse(await f.text()))),
                      );
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          </div>
        </section>
      )}
      {error && (
        <div role="alert" className="error">
          <strong>{t('errorHeading')}</strong>
          <p>{diagnostic(locale, error)}</p>
          <details>
            <summary>{t('technicalDetails')}</summary>
            <pre>{error}</pre>
          </details>
        </div>
      )}
      <div className="document-bar">
        <div>
          <span className={`status-dot ${report?.status ?? ''}`} />
          <strong>{report?.pdf.name ?? manifest?.source.name ?? t('noDocument')}</strong>
          <span>
            {report
              ? t('pageCount', { count: pageCount })
              : manifest
                ? t('expectationCount', {
                    count: expected.length + frozenPagination.length,
                    sections: manifest.sections.length,
                  })
                : t('startHtml')}
          </span>
        </div>
        <div className="actions">
          <button
            type="button"
            disabled={!manifest || !!busy}
            onClick={() => download('printwitness.manifest.json', manifest)}
          >
            {t('manifestDownload')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!manifest || !!busy || !source}
            onClick={() =>
              void run('printing', async () =>
                acceptResult(await api('print', { options: options(), manifest })),
              )
            }
          >
            {t('createPdf')}
          </button>
          <label className={`file-button ${!manifest || busy ? 'disabled' : ''}`}>
            {t('checkPdf')}
            <input
              type="file"
              accept=".pdf,application/pdf"
              disabled={!manifest || !!busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f)
                  void run('checking', async () => {
                    if (f.size > 25 * 1024 * 1024) throw new Error('PDF exceeds 25 MiB.');
                    const bytes = new Uint8Array(await f.arrayBuffer());
                    let binary = '';
                    for (let i = 0; i < bytes.length; i += 8192)
                      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
                    acceptResult(await api('check', { manifest, name: f.name, pdf: btoa(binary) }));
                  });
                e.target.value = '';
              }}
            />
          </label>
        </div>
      </div>
      {busy && (
        <div className="progress" role="status">
          <span />
          {t(busy)}
        </div>
      )}
      <main className="workbench" aria-busy={!!busy}>
        <aside className="checks">
          <div className="pane-title">
            <h2>{t('checks')}</h2>
            <span>{findings.length}</span>
          </div>
          {report && (
            <p className={`report-state ${report.status}`} data-testid="report-status">
              {statusLabel(locale, report.status, hasPageCount)}
            </p>
          )}
          <div className="check-tools">
            <input
              aria-label={t('searchChecks')}
              placeholder={t('searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label={t('filterChecks')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">{t('allChecks')}</option>
              <option value="issues">{t('needsAttention')}</option>
              {(['found', 'mismatch', 'manual', 'unverifiable'] as const).map((key) => (
                <option key={key} value={key}>
                  {statusLabel(locale, key, hasPageCount)}
                </option>
              ))}
            </select>
          </div>
          <div className="check-list">
            {visible.length ? (
              visible.map((f) => (
                <button
                  type="button"
                  key={f.id}
                  className={`check ${selected === f.id ? 'selected' : ''}`}
                  onClick={() => {
                    setSelected(f.id);
                    setExcludeReason('');
                    if (f.evidence.length) setPage(f.evidence[0].page);
                  }}
                  aria-pressed={selected === f.id}
                >
                  <div>
                    <span className={`status-dot ${report ? f.status : 'pending'}`} />
                    <span>
                      {f.excluded
                        ? t('excluded')
                        : report
                          ? statusLabel(locale, f.status, f.kind === 'page-count')
                          : t('frozen')}
                    </span>
                    <small>{kindLabel(locale, f.kind)}</small>
                  </div>
                  <strong>{f.expected}</strong>
                  <small>
                    {findingSection(locale, f)}
                    {f.evidence.length ? ` · ${t('pageShort', { page: f.evidence[0].page })}` : ''}
                  </small>
                </button>
              ))
            ) : (
              <div className="empty-small">{t(manifest ? 'noChecks' : 'checksPlaceholder')}</div>
            )}
          </div>
          {manifest && (
            <div className="check-footer">
              {excludedCount ? t('excludedCount', { count: excludedCount }) : t('allRequired')}
              {report && (
                <span>
                  {t('resultsCount', {
                    found: report.findings.filter((f) => f.status === 'found' && !f.excluded)
                      .length,
                    missing: report.findings.filter((f) => f.status === 'mismatch').length,
                  })}
                </span>
              )}
            </div>
          )}
        </aside>
        <section className="viewer" aria-label={t('pdfViewer')}>
          <div className="viewer-toolbar">
            <h2>{t('document')}</h2>
            <div>
              <button
                type="button"
                aria-label={t('previousPage')}
                disabled={!report || page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ←
              </button>
              <span>{t('pageOf', { page: report ? page : '—', total: pageCount })}</span>
              <button
                type="button"
                aria-label={t('nextPage')}
                disabled={!report || page >= report.pdf.pages.length}
                onClick={() => setPage((p) => p + 1)}
              >
                →
              </button>
            </div>
          </div>
          <div className="paper-area">
            {pageInfo ? (
              <div
                className="paper"
                style={{ aspectRatio: `${pageInfo.width}/${pageInfo.height}` }}
              >
                <img
                  src={`/api/results/${resultId}/page-${page}.png`}
                  alt={t('pdfPage', { page })}
                  onError={(e) => {
                    e.currentTarget.alt = t('previewFailed');
                  }}
                />
                <svg
                  role="img"
                  viewBox={`0 0 ${pageInfo.width} ${pageInfo.height}`}
                  aria-label={t('evidenceLabel')}
                >
                  {evidence.map((e) => (
                    <rect
                      key={`${e.page}:${e.box.x}:${e.box.y}:${e.text}`}
                      x={e.box.x}
                      y={e.box.y}
                      width={e.box.width}
                      height={e.box.height}
                    />
                  ))}
                </svg>
              </div>
            ) : (
              <div className="empty-document">
                <img src="/icon.svg" alt="" />
                <h3>{t(manifest ? 'savedHeading' : 'emptyHeading')}</h3>
                <p>{t(manifest ? 'savedHint' : 'emptyHint')}</p>
                <span>{t('steps')}</span>
              </div>
            )}
          </div>
          <p className="visibility-note">{t('visibilityNote')}</p>
        </section>
        <aside className="details">
          <div className="pane-title">
            <h2>{t('findingDetails')}</h2>
          </div>
          {current ? (
            <div className="detail-content">
              <span className="eyebrow">{kindLabel(locale, current.kind)}</span>
              <h3>{findingSection(locale, current)}</h3>
              <p className={`detail-status ${report ? current.status : ''}`}>
                {current.excluded
                  ? t('explicitlyExcluded')
                  : report
                    ? statusLabel(locale, current.status, current.kind === 'page-count')
                    : t('frozen')}
              </p>
              {current.kind !== 'page-count' && (
                <>
                  <h4>
                    {t(current.kind === 'heading-page' ? 'expectedHeading' : 'expectedContent')}
                  </h4>
                  <blockquote>{current.expected}</blockquote>
                </>
              )}
              {pagination && (
                <>
                  <p>{pagination.expected}</p>
                  {report && <p>{pagination.actual}</p>}
                </>
              )}
              {current.internalTarget ? (
                <>
                  <h4>{t('expectedHeading')}</h4>
                  <p>{current.internalTarget.heading ?? t('unresolved')}</p>
                  <code>{current.href}</code>
                  {report && (
                    <>
                      <h4>{t('actualDestination')}</h4>
                      <p>
                        {destinationLabel(locale, current.actualDestination, current.actualHref)}
                      </p>
                    </>
                  )}
                </>
              ) : (
                current.href && (
                  <>
                    <h4>{t('expectedUrl')}</h4>
                    <code>{current.href}</code>
                    {current.actualHref && (
                      <>
                        <h4>{t('actualUrl')}</h4>
                        <code>{current.actualHref}</code>
                      </>
                    )}
                  </>
                )
              )}
              <h4>{t('reason')}</h4>
              <p>{report ? diagnostic(locale, current.reason) : t('pendingReason')}</p>
              {current.evidence.length > 0 && (
                <>
                  <h4>{t('foundOnPages')}</h4>
                  <div className="actions">
                    {[...new Set(current.evidence.map((e) => e.page))].map((p) => (
                      <button type="button" key={p} onClick={() => setPage(p)}>
                        {t('pageShort', { page: p })}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {!report && !pagination && (
                <div className="exclusion">
                  <h4>{t('intentionalExclusion')}</h4>
                  {current.excluded ? (
                    <>
                      <p>{current.excluded}</p>
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => {
                          setManifest(
                            (m) =>
                              m && {
                                ...m,
                                sections: m.sections.map((s) => ({
                                  ...s,
                                  expectations: s.expectations.map((e) =>
                                    e.id === selected ? { ...e, excluded: undefined } : e,
                                  ),
                                })),
                              },
                          );
                        }}
                      >
                        {t('makeRequired')}
                      </button>
                    </>
                  ) : (
                    <>
                      <label>
                        {t('exclusionReason')}
                        <input
                          value={excludeReason}
                          onChange={(e) => setExcludeReason(e.target.value)}
                          placeholder={t('exclusionPlaceholder')}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={!excludeReason.trim() || !!busy}
                        onClick={() => {
                          setManifest(
                            (m) =>
                              m && {
                                ...m,
                                sections: m.sections.map((s) => ({
                                  ...s,
                                  expectations: s.expectations.map((e) =>
                                    e.id === selected
                                      ? { ...e, excluded: excludeReason.trim() }
                                      : e,
                                  ),
                                })),
                              },
                          );
                          setExcludeReason('');
                        }}
                      >
                        {t('excludeWithReason')}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="empty-small">{t('detailsPlaceholder')}</div>
          )}
          {report && (
            <div className="exports">
              <h4>{t('saveResult')}</h4>
              <a href={`/api/results/${resultId}/report.json`} download>
                {t('jsonReport')}
              </a>
              <a href={`/api/results/${resultId}/report.html?lang=${locale}`} download>
                {t('htmlReport')}
              </a>
              <a href={`/api/results/${resultId}/document.pdf`} download>
                {t('checkedPdf')}
              </a>
              <details>
                <summary>{t('limitations')}</summary>
                {[...new Set(report.warnings)].map((w) => (
                  <p key={w}>{diagnostic(locale, w)}</p>
                ))}
              </details>
            </div>
          )}
        </aside>
      </main>
      <footer>
        {desktop && (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => {
              if (window.confirm(t('quitConfirm')))
                void run('stopping', async () => {
                  await api('desktop/quit', {});
                  setStopped(true);
                });
            }}
          >
            {t('quitApp')}
          </button>
        )}
        PrintWitness v0.1 <span>{t('footer')}</span>
      </footer>
    </div>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing app root');
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
