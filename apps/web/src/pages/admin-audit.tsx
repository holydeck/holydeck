// Reading the administrative trail the server keeps (spec v1c-09, ADMN-03/ADMN-04, task 09-6's route).
// A read-only, cursor-paginated view: newest first, narrowed by category and outcome, exactly what
// `audit-routes.ts` accepts and nothing it does not. Gated on `audit.read`, kept in sync by hand with
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

const queryFor = (category: string, outcome: string, cursor: Cursor | undefined): string => {
  const params = new URLSearchParams();
  if (category !== '') params.set('category', category);
  if (outcome !== '') params.set('outcome', outcome);
  if (cursor !== undefined) {
    params.set('cursorAt', cursor.at);
    params.set('cursorId', cursor.id);
  }
  const query = params.toString();
  return query === '' ? AUDIT_PATH : `${AUDIT_PATH}?${query}`;
};

/** The administrative trail, newest first, narrowed by category and outcome, one page at a time. */
export function AdminAuditPage(): JSX.Element {
  const permitted = can('audit.read');
  const [category, setCategory] = useState('');
  const [outcome, setOutcome] = useState('');
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
      const result = await request(queryFor(category, outcome, cursor));
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
  }, [permitted, category, outcome, cursor]);

  if (!permitted) return <NotFoundPage />;

  const changeCategory = (value: string): void => {
    setCategory(value);
    setCursor(undefined);
  };

  const changeOutcome = (value: string): void => {
    setOutcome(value);
    setCursor(undefined);
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
