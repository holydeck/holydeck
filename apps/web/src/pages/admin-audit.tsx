// Reading the administrative trail the server keeps (spec v1c-09, ADMN-03/ADMN-04, task 09-6's route).
// A read-only, cursor-paginated view: newest first, narrowed by category, outcome and a from/to date,
// exactly what `audit-routes.ts` accepts and nothing it does not, and exportable as CSV (COLAB-11). Gated on `audit.read`, kept in sync by hand with
// `apps/app/src/audit.ts`'s `AUDIT_CATEGORIES` the same way `admin-settings.tsx` repeats `Settings`'s
// field list — the web client has no package boundary into `apps/app`.

import { useEffect, useState } from 'preact/hooks';

import { can } from '../app-state.js';
import { t } from '../i18n.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';

import type { JSX } from 'preact';

export const AUDIT_PATH = '/api/v1/audit';

const CATEGORIES = [
  'authentication',
  'authorization',
  'settings',
  'content',
  'presentation',
  'backup',
  'restore',
  'integration',
] as const;

const OUTCOMES = ['allowed', 'refused'] as const;

interface AuditEntryView {
  readonly id: string;
  readonly at: string;
  readonly category: string;
  readonly action: string;
  readonly actor: string;
  readonly subject: string;
  readonly outcome: string;
  readonly detail: string | undefined;
}

interface Cursor {
  readonly at: string;
  readonly id: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isCursor = (value: unknown): value is Cursor =>
  isRecord(value) && typeof value['at'] === 'string' && typeof value['id'] === 'string';

const parsedEntry = (value: unknown): AuditEntryView | undefined => {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['at'] !== 'string' ||
    typeof value['category'] !== 'string' ||
    typeof value['action'] !== 'string' ||
    typeof value['actor'] !== 'string' ||
    typeof value['subject'] !== 'string' ||
    typeof value['outcome'] !== 'string'
  ) {
    return undefined;
  }
  return {
    id: value['id'],
    at: value['at'],
    category: value['category'],
    action: value['action'],
    actor: value['actor'],
    subject: value['subject'],
    outcome: value['outcome'],
    detail: typeof value['detail'] === 'string' ? value['detail'] : undefined,
  };
};

interface AuditPageView {
  readonly entries: readonly AuditEntryView[];
  readonly nextCursor: Cursor | undefined;
}

const parsedPage = (value: unknown): AuditPageView => {
  if (!isRecord(value) || !Array.isArray(value['entries'])) return { entries: [], nextCursor: undefined };
  const entries = value['entries'].flatMap((row) => {
    const parsed = parsedEntry(row);
    return parsed === undefined ? [] : [parsed];
  });
  return { entries, nextCursor: isCursor(value['nextCursor']) ? value['nextCursor'] : undefined };
};

interface AuditFilter {
  readonly category: string;
  readonly outcome: string;
  /** Plain `YYYY-MM-DD` dates: `parseAuditQuery` reads `from` as that day's start and `to` as its end. */
  readonly from: string;
  readonly to: string;
}

const queryFor = (filter: AuditFilter, cursor: Cursor | undefined, limit?: number): string => {
  const params = new URLSearchParams();
  for (const name of ['category', 'outcome', 'from', 'to'] as const) {
    if (filter[name] !== '') params.set(name, filter[name]);
  }
  if (cursor !== undefined) {
    params.set('cursorAt', cursor.at);
    params.set('cursorId', cursor.id);
  }
  if (limit !== undefined) params.set('limit', String(limit));
  const query = params.toString();
  return query === '' ? AUDIT_PATH : `${AUDIT_PATH}?${query}`;
};

/** The most `audit-routes.ts` answers in one page, which an export asks for to need the fewest requests. */
const EXPORT_PAGE = 100;

const CSV_COLUMNS = ['at', 'category', 'action', 'actor', 'subject', 'outcome', 'detail'] as const;

/**
 * One CSV cell. A value a spreadsheet would read as a formula (`=`, `+`, `-`, `@`) is led with an
 * apostrophe first: `subject` and `detail` are prose some caller wrote, and an export opened in a
 * spreadsheet must not run any of it.
 */
const csvCell = (value: string): string => {
  const safe = /^[=+\-@]/u.test(value) ? `'${value}` : value;
  return /[",\r\n']/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

const csvOf = (entries: readonly AuditEntryView[]): string =>
  [CSV_COLUMNS.join(','), ...entries.map((entry) => CSV_COLUMNS.map((column) => csvCell(entry[column] ?? '')).join(','))]
    .map((line) => `${line}\r\n`)
    .join('');

/** The administrative trail, newest first, narrowed by category, outcome and date, one page at a time. */
export function AdminAuditPage(): JSX.Element {
  const permitted = can('audit.read');
  const [category, setCategory] = useState('');
  const [outcome, setOutcome] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const [cursor, setCursor] = useState<Cursor | undefined>(undefined);
  const [entries, setEntries] = useState<readonly AuditEntryView[]>([]);
  const [nextCursor, setNextCursor] = useState<Cursor | undefined>(undefined);
  const [loading, setLoading] = useState(permitted);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!permitted) return;
    let current = true;
    setLoading(true);
    setLoadFailed(false);
    void (async () => {
      const result = await request(queryFor({ category, outcome, from, to }, cursor));
      if (!current) return;
      if (!result.ok) {
        setLoadFailed(true);
        if (cursor === undefined) setEntries([]);
        setNextCursor(undefined);
      } else {
        const page = parsedPage(result.data);
        setEntries((existing) => (cursor === undefined ? page.entries : [...existing, ...page.entries]));
        setNextCursor(page.nextCursor);
      }
      setLoading(false);
    })();
    return () => {
      current = false;
    };
  }, [permitted, category, outcome, from, to, cursor]);

  if (!permitted) return <NotFoundPage />;

  const changeCategory = (value: string): void => {
    setCategory(value);
    setCursor(undefined);
  };

  const changeOutcome = (value: string): void => {
    setOutcome(value);
    setCursor(undefined);
  };

  const changeFrom = (value: string): void => {
    setFrom(value);
    setCursor(undefined);
  };

  const changeTo = (value: string): void => {
    setTo(value);
    setCursor(undefined);
  };

  // Every page of the filter on screen, not only the pages scrolled to so far, read the same way the
  // table reads them: the server has already redacted each entry, and the file is made here from that.
  const exportCsv = async (): Promise<void> => {
    setExporting(true);
    setExportFailed(false);
    try {
      const all: AuditEntryView[] = [];
      let next: Cursor | undefined;
      do {
        const result = await request(queryFor({ category, outcome, from, to }, next, EXPORT_PAGE));
        if (!result.ok) {
          setExportFailed(true);
          return;
        }
        const page = parsedPage(result.data);
        all.push(...page.entries);
        next = page.nextCursor;
      } while (next !== undefined);
      const address = URL.createObjectURL(new Blob([csvOf(all)], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = address;
      link.download = 'holydeck-audit.csv';
      link.click();
      URL.revokeObjectURL(address);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <h1>{t('audit.heading')}</h1>
      <div class="form-field">
        <label for="audit-category">{t('audit.categoryLabel')}</label>
        <select id="audit-category" value={category} onChange={(event) => changeCategory(event.currentTarget.value)}>
          <option value="">{t('audit.allCategories')}</option>
          {CATEGORIES.map((value) => (
            <option key={value} value={value}>{t(`audit.category.${value}`)}</option>
          ))}
        </select>
      </div>
      <div class="form-field">
        <label for="audit-outcome">{t('audit.outcomeLabel')}</label>
        <select id="audit-outcome" value={outcome} onChange={(event) => changeOutcome(event.currentTarget.value)}>
          <option value="">{t('audit.allOutcomes')}</option>
          {OUTCOMES.map((value) => (
            <option key={value} value={value}>{t(`audit.outcome.${value}`)}</option>
          ))}
        </select>
      </div>
      <div class="form-field">
        <label for="audit-from">{t('audit.fromLabel')}</label>
        <input id="audit-from" type="date" value={from} max={to === '' ? undefined : to} onChange={(event) => changeFrom(event.currentTarget.value)} />
      </div>
      <div class="form-field">
        <label for="audit-to">{t('audit.toLabel')}</label>
        <input id="audit-to" type="date" value={to} min={from === '' ? undefined : from} onChange={(event) => changeTo(event.currentTarget.value)} />
      </div>
      <button type="button" disabled={exporting} onClick={() => void exportCsv()}>{t('audit.export')}</button>
      {exportFailed ? <p role="alert">{t('audit.exportFailed')}</p> : null}
      {loadFailed ? <p role="alert">{t('audit.loadFailed')}</p> : null}
      {loading && entries.length === 0 && !loadFailed ? <p role="status">{t('app.loading')}</p> : (
        <div class="table-scroll">
          <table class="audit-table">
            <caption>{t('audit.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('audit.column.at')}</th>
                <th scope="col">{t('audit.column.action')}</th>
                <th scope="col">{t('audit.column.category')}</th>
                <th scope="col">{t('audit.column.actor')}</th>
                <th scope="col">{t('audit.column.subject')}</th>
                <th scope="col">{t('audit.column.outcome')}</th>
                <th scope="col">{t('audit.column.detail')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <th scope="row">{entry.at}</th>
                  <td>{entry.action}</td>
                  <td>{entry.category}</td>
                  <td>{entry.actor}</td>
                  <td>{entry.subject}</td>
                  <td>{entry.outcome === 'allowed' ? t('audit.outcome.allowed') : t('audit.outcome.refused')}</td>
                  <td>{entry.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" disabled={nextCursor === undefined || loading} onClick={() => setCursor(nextCursor)}>
        {t('audit.loadMore')}
      </button>
    </>
  );
}
