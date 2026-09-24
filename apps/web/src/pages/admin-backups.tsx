// The recorded backups an administrator manages, and "Back up now" (spec v1c-14, OUI-03, T5). One
// permission, `backup.manage`, gates both the list and the action — `backup-routes.ts`'s own split,
// unlike Jobs, has no separate viewing permission. A `RecordedBackup` only ever exists once
// `finalizeBackup` has written it (`backups.ts:346-400`), after grading its manifest against the
// contract and auditing it `allowed`; there is no partial or failed row this route can return, so every
// listed backup is shown as Completed, not derived from a status field the record does not carry.
// `production.manifest.contents` never enumerates a "mongo" entry directly — the Mongo half is many
// individual record classes (`MONGO_CONTENTS` in `backups.ts`), while `settings`/`media` are each their
// own single Restic-backed entry (`backup-producer.ts`); a content whose class is neither `settings` nor
// `media` is therefore Mongo's own, which is how the three checkbox/column labels are derived from the
// manifest without importing `apps/app`'s server-only class list.
//
// "Last rehearsal" has no column and "Rehearse" has no button here — D-PLAN-3, no server route exists to
// read or trigger either. The restore wizard below (OUI-03, T6) is gated by its own permission,
// `restore.manage`, apart from `backup.manage`: a password re-check and the typed backup id are sent in
// the same request as the restore itself (`restore-routes.ts`), a 401 re-prompts for the password rather
// than failing hard, and a 409 means the backup has no passing rehearsal — the one place this page shows
// "last rehearsal" without a route that reads rehearsal history (D-PLAN-3 again). Success has no status
// route either, so progress is watched by polling `GET /api/v1/jobs?kind=restore-apply` for the enqueued
// job's id (D-PLAN-4); a failed `restore-apply` job is never requeued (`job-routes.ts`'s
// `REQUEUE_REFUSED_KINDS`, mirrored in `admin-jobs.tsx`), so a failed restore says to start over here
// instead of pointing at Requeue.

import { useEffect, useState } from 'preact/hooks';

import { RESTORE_CLASSES, type RestoreClass } from '@holydeck/contracts/backups';
import { ENTITY_CONFLICT } from '@holydeck/contracts/http';
import { JOB_STATES, type JobState } from '@holydeck/contracts/jobs';
import { SIGN_IN_REFUSED } from '@holydeck/contracts/sessions';

import { can, csrf } from '../app-state.js';
import { t } from '../i18n.js';
import { formatBytes } from '../library/upload.js';
import { JOBS_PATH } from './admin-jobs.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';

import type { JSX } from 'preact';

export const BACKUPS_PATH = '/api/v1/backups';
export const RESTORES_PATH = '/api/v1/restores';

// Watched, not ambient: an operator is looking at this page waiting for their own restore, unlike the
// notification bell's 30s background poll (T7). A few seconds keeps the wait visible without hammering
// the jobs route.
export const RESTORE_POLL_MS = 3000;

interface BackupContentView {
  readonly class: string;
  readonly bytes: number;
}

interface BackupView {
  readonly backupId: string;
  readonly at: string;
  readonly contents: readonly BackupContentView[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const parsedContent = (value: unknown): BackupContentView | undefined => {
  if (!isRecord(value) || typeof value['class'] !== 'string' || typeof value['bytes'] !== 'number') return undefined;
  return { class: value['class'], bytes: value['bytes'] };
};

const parsedContents = (value: unknown): readonly BackupContentView[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const contents: BackupContentView[] = [];
  for (const entry of value) {
    const parsed = parsedContent(entry);
    if (parsed === undefined) return undefined;
    contents.push(parsed);
  }
  return contents;
};

/** Parses one row exactly to `RecordedBackup`'s own shape (`backups.ts:405`), defensively field by field. */
const parsedBackup = (value: unknown): BackupView | undefined => {
  if (!isRecord(value) || typeof value['backupId'] !== 'string' || typeof value['at'] !== 'string') return undefined;
  const production = value['production'];
  if (!isRecord(production)) return undefined;
  const manifest = production['manifest'];
  if (!isRecord(manifest)) return undefined;
  const contents = parsedContents(manifest['contents']);
  if (contents === undefined) return undefined;
  return { backupId: value['backupId'], at: value['at'], contents };
};

const parsedBackups = (value: unknown): readonly BackupView[] => {
  if (!isRecord(value) || !Array.isArray(value['backups'])) return [];
  return value['backups'].flatMap((row) => {
    const parsed = parsedBackup(row);
    return parsed === undefined ? [] : [parsed];
  });
};

const componentsOf = (contents: readonly BackupContentView[]): readonly RestoreClass[] =>
  RESTORE_CLASSES.filter((restoreClass) => (
    restoreClass === 'mongo'
      ? contents.some((entry) => entry.class !== 'settings' && entry.class !== 'media')
      : contents.some((entry) => entry.class === restoreClass)
  ));

const sizeOf = (contents: readonly BackupContentView[]): number => contents.reduce((total, entry) => total + entry.bytes, 0);

const isJobState = (value: unknown): value is JobState => typeof value === 'string' && (JOB_STATES as readonly string[]).includes(value);

/** Reads only what polling a restore needs from a `GET /api/v1/jobs` answer: one job's state, by id. */
const restoreStateOf = (value: unknown, jobId: string): JobState | undefined => {
  if (!isRecord(value) || !Array.isArray(value['jobs'])) return undefined;
  for (const row of value['jobs']) {
    if (isRecord(row) && row['id'] === jobId && isJobState(row['state'])) return row['state'];
  }
  return undefined;
};

/** The backups this deployment has recorded, and a way to trigger one on demand. */
export function AdminBackupsPage(): JSX.Element {
  const permitted = can('backup.manage');
  const canRestore = can('restore.manage');
  const [backups, setBackups] = useState<readonly BackupView[]>([]);
  const [loading, setLoading] = useState(permitted);
  const [loadFailed, setLoadFailed] = useState(false);
  const [checked, setChecked] = useState<ReadonlySet<RestoreClass>>(new Set(RESTORE_CLASSES));
  const [backingUp, setBackingUp] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | undefined>(undefined);

  const [restoreBackupId, setRestoreBackupId] = useState('');
  const [restoreChecked, setRestoreChecked] = useState<ReadonlySet<RestoreClass>>(new Set(RESTORE_CLASSES));
  const [restoreConfirm, setRestoreConfirm] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  const [restoreSubmitting, setRestoreSubmitting] = useState(false);
  const [restoreError, setRestoreError] = useState<string | undefined>(undefined);
  const [restoreNoRehearsal, setRestoreNoRehearsal] = useState(false);
  const [restoreJobId, setRestoreJobId] = useState<string | undefined>(undefined);
  const [restoreJobState, setRestoreJobState] = useState<JobState | undefined>(undefined);

  const load = async (): Promise<void> => {
    const result = await request(BACKUPS_PATH);
    if (result.ok) {
      setBackups(parsedBackups(result.data));
      setLoadFailed(false);
    } else {
      setBackups([]);
      setLoadFailed(true);
    }
  };

  useEffect(() => {
    if (!permitted) return;
    let current = true;
    setLoading(true);
    void (async () => {
      await load();
      if (current) setLoading(false);
    })();
    return () => {
      current = false;
    };
  }, [permitted]);

  useEffect(() => {
    if (restoreJobId === undefined) return;
    let cancelled = false;

    const poll = async (): Promise<void> => {
      const result = await request(`${JOBS_PATH}?kind=restore-apply`);
      if (cancelled || !result.ok) return;
      const state = restoreStateOf(result.data, restoreJobId);
      if (state === 'succeeded' || state === 'failed') {
        setRestoreJobState(state);
        setRestoreJobId(undefined);
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), RESTORE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [restoreJobId]);

  if (!permitted) return <NotFoundPage />;

  const toggleComponent = (component: RestoreClass, on: boolean): void => {
    setChecked((current) => {
      const next = new Set(current);
      if (on) next.add(component);
      else next.delete(component);
      return next;
    });
  };

  const backUpNow = async (event: JSX.TargetedEvent<HTMLFormElement, SubmitEvent>): Promise<void> => {
    event.preventDefault();
    setBackingUp(true);
    setActionMessage(undefined);
    try {
      const components = RESTORE_CLASSES.filter((restoreClass) => checked.has(restoreClass));
      const result = await request(BACKUPS_PATH, { method: 'POST', csrf: csrf() ?? '', body: { components } });
      if (!result.ok) {
        setActionMessage(result.message);
        return;
      }
      await load();
    } finally {
      setBackingUp(false);
    }
  };

  const toggleRestoreComponent = (component: RestoreClass, on: boolean): void => {
    setRestoreChecked((current) => {
      const next = new Set(current);
      if (on) next.add(component);
      else next.delete(component);
      return next;
    });
  };

  const resetRestore = (): void => {
    setRestoreBackupId('');
    setRestoreChecked(new Set(RESTORE_CLASSES));
    setRestoreConfirm('');
    setRestorePassword('');
    setRestoreError(undefined);
    setRestoreNoRehearsal(false);
    setRestoreJobState(undefined);
  };

  const startRestore = async (event: JSX.TargetedEvent<HTMLFormElement, SubmitEvent>): Promise<void> => {
    event.preventDefault();
    setRestoreSubmitting(true);
    setRestoreError(undefined);
    setRestoreNoRehearsal(false);
    try {
      const components = RESTORE_CLASSES.filter((restoreClass) => restoreChecked.has(restoreClass));
      const result = await request(RESTORES_PATH, {
        method: 'POST',
        csrf: csrf() ?? '',
        body: { backupId: restoreBackupId, confirm: restoreConfirm, components, password: restorePassword },
      });
      if (!result.ok) {
        if (result.code === SIGN_IN_REFUSED) {
          setRestoreError(t('backups.restore.wrongPassword'));
          setRestorePassword('');
          return;
        }
        if (result.code === ENTITY_CONFLICT) setRestoreNoRehearsal(true);
        setRestoreError(result.message);
        return;
      }
      const data = result.data as { readonly id: string };
      setRestoreJobId(data.id);
    } finally {
      setRestoreSubmitting(false);
    }
  };

  const restoreDisabled =
    restoreSubmitting || restoreBackupId === '' || restoreConfirm !== restoreBackupId || restoreChecked.size === 0;

  return (
    <>
      <h1>{t('backups.heading')}</h1>
      {actionMessage === undefined ? null : <p role="alert">{actionMessage}</p>}
      {loadFailed ? <p role="alert">{t('backups.loadFailed')}</p> : null}
      <form onSubmit={(event) => void backUpNow(event)}>
        <fieldset>
          <legend>{t('backups.backUpNowHeading')}</legend>
          {RESTORE_CLASSES.map((restoreClass) => (
            <label key={restoreClass}>
              <input
                type="checkbox"
                checked={checked.has(restoreClass)}
                onChange={(event) => toggleComponent(restoreClass, event.currentTarget.checked)}
              />
              {t(`backups.component.${restoreClass}`)}
            </label>
          ))}
        </fieldset>
        <button type="submit" disabled={backingUp}>{t('backups.backUpNow')}</button>
      </form>
      {loading && backups.length === 0 && !loadFailed ? <p role="status">{t('app.loading')}</p> : null}
      {!loading && backups.length === 0 && !loadFailed ? <p>{t('backups.empty')}</p> : null}
      {backups.length === 0 ? null : (
        <div class="table-scroll">
          <table class="backups-table">
            <caption>{t('backups.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('backups.column.backupId')}</th>
                <th scope="col">{t('backups.column.at')}</th>
                <th scope="col">{t('backups.column.status')}</th>
                <th scope="col">{t('backups.column.components')}</th>
                <th scope="col">{t('backups.column.size')}</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((row) => (
                <tr key={row.backupId}>
                  <th scope="row">{row.backupId}</th>
                  <td>{row.at}</td>
                  <td>{t('backups.status.completed')}</td>
                  <td>{componentsOf(row.contents).map((component) => t(`backups.component.${component}`)).join(', ')}</td>
                  <td>{formatBytes(sizeOf(row.contents))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canRestore ? (
        <section aria-labelledby="backups-restore-heading">
          <h2 id="backups-restore-heading">{t('backups.restore.heading')}</h2>
          {restoreJobId !== undefined ? (
            <p role="status">{t('backups.restore.polling')}</p>
          ) : restoreJobState === 'succeeded' ? (
            <>
              <p role="status">{t('backups.restore.succeeded')}</p>
              <button type="button" onClick={resetRestore}>{t('backups.restore.startOver')}</button>
            </>
          ) : restoreJobState === 'failed' ? (
            <>
              <p role="alert">{t('backups.restore.failed')}</p>
              <button type="button" onClick={resetRestore}>{t('backups.restore.startOver')}</button>
            </>
          ) : (
            <form onSubmit={(event) => void startRestore(event)}>
              {restoreNoRehearsal ? (
                <p role="alert">
                  <strong>{t('backups.restore.noRehearsalHeading')}</strong> {restoreError}
                </p>
              ) : restoreError === undefined ? null : (
                <p role="alert">{restoreError}</p>
              )}
              <fieldset>
                <legend>{t('backups.restore.selectBackupLegend')}</legend>
                {backups.map((row) => (
                  <label key={row.backupId}>
                    <input
                      type="radio"
                      name="restore-backup"
                      checked={restoreBackupId === row.backupId}
                      onChange={() => setRestoreBackupId(row.backupId)}
                    />
                    {row.backupId}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>{t('backups.restore.componentsLegend')}</legend>
                {RESTORE_CLASSES.map((restoreClass) => (
                  <label key={restoreClass}>
                    <input
                      type="checkbox"
                      checked={restoreChecked.has(restoreClass)}
                      onChange={(event) => toggleRestoreComponent(restoreClass, event.currentTarget.checked)}
                    />
                    {t(`backups.component.${restoreClass}`)}
                  </label>
                ))}
              </fieldset>
              <div class="form-field">
                <label for="restore-confirm">{t('backups.restore.confirmLabel')}</label>
                <input
                  id="restore-confirm"
                  type="text"
                  value={restoreConfirm}
                  onInput={(event) => setRestoreConfirm(event.currentTarget.value)}
                />
              </div>
              <div class="form-field">
                <label for="restore-password">{t('welcome.password')}</label>
                <input
                  id="restore-password"
                  type="password"
                  autocomplete="current-password"
                  value={restorePassword}
                  onInput={(event) => setRestorePassword(event.currentTarget.value)}
                />
              </div>
              <button type="submit" disabled={restoreDisabled}>{t('backups.restore.submit')}</button>
            </form>
          )}
        </section>
      ) : null}
    </>
  );
}
