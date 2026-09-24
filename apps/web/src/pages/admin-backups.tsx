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
// manifest without importing `apps/app`'s server-only class list. "Last rehearsal" has no column and
// "Rehearse" has no button here — D-PLAN-3, no server route exists yet to read or trigger either; the
// restore wizard (T6) is a separate pass onto this same page.

import { useEffect, useState } from 'preact/hooks';

import { RESTORE_CLASSES, type RestoreClass } from '@holydeck/contracts/backups';

import { can, csrf } from '../app-state.js';
import { t } from '../i18n.js';
import { formatBytes } from '../library/upload.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';

import type { JSX } from 'preact';

export const BACKUPS_PATH = '/api/v1/backups';

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

/** The backups this deployment has recorded, and a way to trigger one on demand. */
export function AdminBackupsPage(): JSX.Element {
  const permitted = can('backup.manage');
  const [backups, setBackups] = useState<readonly BackupView[]>([]);
  const [loading, setLoading] = useState(permitted);
  const [loadFailed, setLoadFailed] = useState(false);
  const [checked, setChecked] = useState<ReadonlySet<RestoreClass>>(new Set(RESTORE_CLASSES));
  const [backingUp, setBackingUp] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | undefined>(undefined);

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
    </>
  );
}
