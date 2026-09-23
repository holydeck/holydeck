// The content-language catalogue as it is administered (spec v1c-09, ADMN-05): list, archive, restore.
// Creating and editing a language is out of this screen's scope (content-language-routes.ts's `/catalogue`
// route serves that to editors instead). Archiving a language is never refused for being in use — a
// language block keyed to an archived language keeps resolving — so the dependents count in the confirm
// dialog is shown as information, not as a gate the administrator must clear first.

import { parseEntityStamp } from '@holydeck/contracts/entities';
import { useEffect, useState } from 'preact/hooks';

import { can, csrf } from '../app-state.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { fieldErrors } from '../form-errors.js';
import { t } from '../i18n.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';
import { say } from '../status.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { JSX } from 'preact';

export const LANGUAGES_PATH = '/api/v1/content-languages';

interface LanguageRow {
  readonly stamp: EntityStamp;
  readonly displayName: string;
  readonly script: string;
  readonly fallbackFont: string;
}

interface Dependents {
  readonly count: number;
  readonly approximate: boolean;
}

interface Confirming {
  readonly key: string;
  readonly name: string;
  readonly action: 'archive' | 'restore';
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const parsedLanguage = (value: unknown): LanguageRow | undefined => {
  if (!isRecord(value)) return undefined;
  const stamp = parseEntityStamp(value['stamp']);
  if (
    !stamp.ok ||
    typeof value['displayName'] !== 'string' ||
    typeof value['script'] !== 'string' ||
    typeof value['fallbackFont'] !== 'string'
  ) {
    return undefined;
  }
  return { stamp: stamp.value, displayName: value['displayName'], script: value['script'], fallbackFont: value['fallbackFont'] };
};

const parsedLanguages = (value: unknown): { readonly languages: readonly LanguageRow[]; readonly failed: boolean } => {
  if (!Array.isArray(value)) return { languages: [], failed: true };
  let failed = false;
  const languages = value.flatMap((row) => {
    const parsed = parsedLanguage(row);
    if (parsed === undefined) failed = true;
    return parsed === undefined ? [] : [parsed];
  });
  return { languages, failed };
};

const parsedDependents = (value: unknown): Dependents | undefined => {
  if (!isRecord(value) || typeof value['count'] !== 'number' || typeof value['approximate'] !== 'boolean') return undefined;
  return { count: value['count'], approximate: value['approximate'] };
};

/** Every administered content language, its archived state, and an archive/restore action per row. */
export function AdminLanguagesPage(): JSX.Element {
  const permitted = can('catalogue.manage');
  const [languages, setLanguages] = useState<readonly LanguageRow[]>([]);
  const [loading, setLoading] = useState(permitted);
  const [loadFailed, setLoadFailed] = useState(false);
  const [other, setOther] = useState<string>();
  const [confirming, setConfirming] = useState<Confirming>();
  const [dependents, setDependents] = useState<Dependents>();
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    setLoadFailed(false);
    const result = await request(LANGUAGES_PATH);
    const parsed = result.ok ? parsedLanguages(result.data) : undefined;
    setLanguages(parsed?.languages ?? []);
    setLoadFailed(parsed === undefined || parsed.failed);
    setLoading(false);
  };

  useEffect(() => {
    if (permitted) void load();
  }, [permitted]);

  if (!permitted) return <NotFoundPage />;

  const open = async (row: LanguageRow): Promise<void> => {
    const archived = row.stamp.archivedAt !== undefined;
    setOther(undefined);
    setDependents(undefined);
    setConfirming({ key: row.stamp.id, name: row.displayName, action: archived ? 'restore' : 'archive' });
    if (!archived) {
      const result = await request(`${LANGUAGES_PATH}/${encodeURIComponent(row.stamp.id)}/dependents`);
      setDependents(result.ok ? parsedDependents(result.data) : undefined);
    }
  };

  const close = (): void => {
    setConfirming(undefined);
    setDependents(undefined);
  };

  const confirm = async (): Promise<void> => {
    if (confirming === undefined) return;
    setBusy(true);
    try {
      const archived = confirming.action === 'archive';
      const result = await request(`${LANGUAGES_PATH}/${encodeURIComponent(confirming.key)}/status`, {
        method: 'PATCH',
        csrf: csrf() ?? '',
        body: { archived },
      });
      if (!result.ok) {
        const message = fieldErrors(result, []).other ?? result.message;
        const text = t('languages.refused', { message });
        setOther(text);
        say('assertive', text);
        return;
      }
      const name = confirming.name;
      close();
      await load();
      say('polite', t(archived ? 'languages.announce.archived' : 'languages.announce.restored', { name }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>{t('languages.heading')}</h1>
      {loadFailed ? <p role="alert">{t('languages.loadFailed')}</p> : null}
      {other === undefined ? null : <p role="alert">{other}</p>}
      {loading ? <p role="status">{t('app.loading')}</p> : (
        <div class="table-scroll">
          <table class="languages-table">
            <caption>{t('languages.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('languages.column.name')}</th>
                <th scope="col">{t('languages.column.script')}</th>
                <th scope="col">{t('languages.column.fallbackFont')}</th>
                <th scope="col">{t('languages.column.status')}</th>
                <th scope="col">{t('languages.column.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {languages.map((row) => {
                const archived = row.stamp.archivedAt !== undefined;
                return (
                  <tr key={row.stamp.id}>
                    <th scope="row">{row.displayName}</th>
                    <td>{row.script}</td>
                    <td>{row.fallbackFont}</td>
                    <td>{t(archived ? 'languages.status.archived' : 'languages.status.active')}</td>
                    <td>
                      <button type="button" onClick={() => void open(row)}>
                        {t(archived ? 'languages.action.restore' : 'languages.action.archive', { name: row.displayName })}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {confirming === undefined ? null : (
        <ConfirmDialog
          id="languages-confirm"
          title={t(confirming.action === 'archive' ? 'languages.archiveConfirmTitle' : 'languages.restoreConfirmTitle', { name: confirming.name })}
          body={t(confirming.action === 'archive' ? 'languages.archiveConfirmBody' : 'languages.restoreConfirmBody', { name: confirming.name })}
          confirmLabel={t('languages.confirm')}
          cancelLabel={t('languages.cancel')}
          busy={busy}
          onConfirm={() => void confirm()}
          onCancel={close}
        >
          {confirming.action === 'archive' && dependents !== undefined && dependents.count > 0 ? (
            <p>{t('languages.dependentsWarning', { count: dependents.count })}</p>
          ) : null}
        </ConfirmDialog>
      )}
    </>
  );
}
