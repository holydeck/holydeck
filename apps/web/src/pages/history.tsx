// The history behind a piece of content (spec v1c-09, COLAB-02): the revisions the server kept, one
// revision compared with another, and an earlier one brought back. The server is the only place that
// judges whether a restore is safe (revision-routes.ts); this page reads its answers and shows them.

import { parseRevisionRecord, type RevisionRecord } from '@holydeck/contracts/revisions';
import { useEffect, useState } from 'preact/hooks';

import { can, csrf } from '../app-state.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { fieldErrors } from '../form-errors.js';
import { t } from '../i18n.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';

import type { JSX } from 'preact';

type DiffKind = 'added' | 'removed' | 'changed';

const DIFF_KINDS: readonly DiffKind[] = ['added', 'removed', 'changed'];

interface FieldDiff {
  readonly path: string;
  readonly kind: DiffKind;
  readonly before?: unknown;
  readonly after?: unknown;
}

interface CompareResult {
  readonly from: RevisionRecord;
  readonly to: RevisionRecord;
  readonly diff: readonly FieldDiff[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isFieldDiff = (value: unknown): value is FieldDiff =>
  isRecord(value) && typeof value['path'] === 'string' && DIFF_KINDS.includes(value['kind'] as DiffKind);

const parsedDiff = (value: unknown): readonly FieldDiff[] => (Array.isArray(value) ? value.filter(isFieldDiff) : []);

const parsedRevisions = (value: readonly unknown[]): readonly RevisionRecord[] =>
  value.flatMap((row) => {
    const parsed = parseRevisionRecord(row);
    return parsed.ok ? [parsed.value] : [];
  });

const parsedCompare = (value: unknown): CompareResult | undefined => {
  if (!isRecord(value)) return undefined;
  const from = parseRevisionRecord(value['from']);
  const to = parseRevisionRecord(value['to']);
  if (!from.ok || !to.ok) return undefined;
  return { from: from.value, to: to.value, diff: parsedDiff(value['diff']) };
};

const parsedRestore = (value: unknown): RevisionRecord | undefined => {
  if (!isRecord(value)) return undefined;
  const parsed = parseRevisionRecord(value['revision']);
  return parsed.ok ? parsed.value : undefined;
};

const revisionsPath = (contentId: string): string => `/api/v1/content/${encodeURIComponent(contentId)}/revisions`;

/** The revisions kept for one piece of content, with a two-way compare and a confirmed restore. */
export function HistoryPage({ contentId }: { readonly contentId: string }): JSX.Element {
  const permitted = can('contentHistory.manage');
  const [revisions, setRevisions] = useState<readonly RevisionRecord[]>([]);
  const [loading, setLoading] = useState(permitted);
  const [selected, setSelected] = useState<readonly number[]>([]);
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState<CompareResult>();
  const [compareError, setCompareError] = useState<string>();
  const [confirming, setConfirming] = useState<number>();
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string>();

  const load = async (): Promise<void> => {
    setLoading(true);
    const result = await request(revisionsPath(contentId));
    setRevisions(result.ok && Array.isArray(result.data) ? parsedRevisions(result.data) : []);
    setLoading(false);
  };

  useEffect(() => {
    if (permitted) void load();
  }, [contentId, permitted]);

  const toggle = (revision: number): void => {
    setCompareResult(undefined);
    setCompareError(undefined);
    setSelected((current) => {
      if (current.includes(revision)) return current.filter((value) => value !== revision);
      return current.length >= 2 ? current : [...current, revision];
    });
  };

  const compare = async (): Promise<void> => {
    if (selected.length !== 2) return;
    const from = Math.min(...selected);
    const to = Math.max(...selected);
    setComparing(true);
    setCompareError(undefined);
    try {
      const result = await request(`${revisionsPath(contentId)}/compare?from=${from}&to=${to}`);
      if (!result.ok) {
        setCompareError(fieldErrors(result, []).other ?? result.message);
        return;
      }
      const parsed = parsedCompare(result.data);
      if (parsed === undefined) {
        setCompareError(t('form.error.unexpected', { code: 'client.unreadable_response' }));
        return;
      }
      setCompareResult(parsed);
    } finally {
      setComparing(false);
    }
  };

  const restore = async (revision: number): Promise<void> => {
    setRestoring(true);
    setRestoreError(undefined);
    try {
      const result = await request(`${revisionsPath(contentId)}/${revision}/restore`, { method: 'POST', csrf: csrf() ?? '' });
      if (!result.ok) {
        setRestoreError(fieldErrors(result, []).other ?? result.message);
        return;
      }
      const restored = parsedRestore(result.data);
      if (restored !== undefined) setRevisions((current) => [restored, ...current]);
      setConfirming(undefined);
      setSelected([]);
      setCompareResult(undefined);
    } finally {
      setRestoring(false);
    }
  };

  if (!permitted) return <NotFoundPage />;

  return (
    <>
      <h1>{t('history.heading')}</h1>
      {loading ? <p role="status">{t('app.loading')}</p> : (
        <ul>
          {revisions.map((revision) => (
            <li key={revision.revision}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(revision.revision)}
                  disabled={!selected.includes(revision.revision) && selected.length >= 2}
                  onChange={() => toggle(revision.revision)}
                />
                {t('history.revisionLabel', { revision: revision.revision, at: revision.at })}
              </label>
              <button type="button" onClick={() => setConfirming(revision.revision)}>{t('history.restore')}</button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" disabled={selected.length !== 2 || comparing} onClick={() => void compare()}>
        {t('history.compare')}
      </button>
      {compareError === undefined ? null : <p role="alert">{compareError}</p>}
      {compareResult === undefined ? null : (
        <section aria-label={t('history.diffLabel')}>
          <h2>{t('history.diffLabel')}</h2>
          <ul>
            {compareResult.diff.map((row) => (
              <li key={row.path}>
                {row.path}: {row.kind} ({JSON.stringify(row.before)} → {JSON.stringify(row.after)})
              </li>
            ))}
          </ul>
        </section>
      )}
      {restoreError === undefined ? null : <p role="alert">{restoreError}</p>}
      {confirming === undefined ? null : (
        <ConfirmDialog
          id="history-restore"
          title={t('history.restoreConfirmLabel')}
          body={t('history.restoreConfirmBody', { revision: confirming })}
          confirmLabel={t('history.confirm')}
          cancelLabel={t('history.cancel')}
          busy={restoring}
          onConfirm={() => void restore(confirming)}
          onCancel={() => setConfirming(undefined)}
        />
      )}
    </>
  );
}
