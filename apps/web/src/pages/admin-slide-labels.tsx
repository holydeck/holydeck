// The slide-label catalogue as it is administered (spec v1c-09, ADMN-05): list, archive, restore.
// Creating and editing a label is out of this screen's scope (slide-label-routes.ts's `/catalogue`
// route serves that to editors instead). The dependents endpoint is hardcoded to always answer zero
// today (nothing references a label by id yet), but the confirm dialog still asks it, the same way the
// content-language page does, so both pages stay tied to the real contract rather than to today's answer.

import { parseEntityStamp } from '@holydeck/contracts/entities';
import { SHORTCUT_KEYS } from '@holydeck/contracts/slide-labels';
import { useEffect, useState } from 'preact/hooks';

import { can, csrf } from '../app-state.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { fieldErrors } from '../form-errors.js';
import { t } from '../i18n.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';
import { say } from '../status.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { ShortcutKey } from '@holydeck/contracts/slide-labels';
import type { JSX } from 'preact';

export const SLIDE_LABELS_PATH = '/api/v1/slide-labels';

interface LabelRow {
  readonly stamp: EntityStamp;
  readonly name: string;
  readonly shortcut?: ShortcutKey;
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

const isShortcutKey = (value: unknown): value is ShortcutKey =>
  typeof value === 'string' && (SHORTCUT_KEYS as readonly string[]).includes(value);

const parsedLabel = (value: unknown): LabelRow | undefined => {
  if (!isRecord(value)) return undefined;
  const stamp = parseEntityStamp(value['stamp']);
  if (!stamp.ok || typeof value['name'] !== 'string') return undefined;
  if (value['shortcut'] !== undefined && !isShortcutKey(value['shortcut'])) return undefined;
  return { stamp: stamp.value, name: value['name'], shortcut: value['shortcut'] as ShortcutKey | undefined };
};

const parsedLabels = (value: unknown): { readonly labels: readonly LabelRow[]; readonly failed: boolean } => {
  if (!Array.isArray(value)) return { labels: [], failed: true };
  let failed = false;
  const labels = value.flatMap((row) => {
    const parsed = parsedLabel(row);
    if (parsed === undefined) failed = true;
    return parsed === undefined ? [] : [parsed];
  });
  return { labels, failed };
};

const parsedDependents = (value: unknown): Dependents | undefined => {
  if (!isRecord(value) || typeof value['count'] !== 'number' || typeof value['approximate'] !== 'boolean') return undefined;
  return { count: value['count'], approximate: value['approximate'] };
};

/** Every administered slide label, its archived state, and an archive/restore action per row. */
export function AdminSlideLabelsPage(): JSX.Element {
  const permitted = can('catalogue.manage');
  const [labels, setLabels] = useState<readonly LabelRow[]>([]);
  const [loading, setLoading] = useState(permitted);
  const [loadFailed, setLoadFailed] = useState(false);
  const [other, setOther] = useState<string>();
  const [confirming, setConfirming] = useState<Confirming>();
  const [dependents, setDependents] = useState<Dependents>();
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    setLoadFailed(false);
    const result = await request(SLIDE_LABELS_PATH);
    const parsed = result.ok ? parsedLabels(result.data) : undefined;
    setLabels(parsed?.labels ?? []);
    setLoadFailed(parsed === undefined || parsed.failed);
    setLoading(false);
  };

  useEffect(() => {
    if (permitted) void load();
  }, [permitted]);

  if (!permitted) return <NotFoundPage />;

  const open = async (row: LabelRow): Promise<void> => {
    const archived = row.stamp.archivedAt !== undefined;
    setOther(undefined);
    setDependents(undefined);
    setConfirming({ key: row.stamp.id, name: row.name, action: archived ? 'restore' : 'archive' });
    if (!archived) {
      const result = await request(`${SLIDE_LABELS_PATH}/${encodeURIComponent(row.stamp.id)}/dependents`);
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
      const result = await request(`${SLIDE_LABELS_PATH}/${encodeURIComponent(confirming.key)}/status`, {
        method: 'PATCH',
        csrf: csrf() ?? '',
        body: { archived },
      });
      if (!result.ok) {
        const message = fieldErrors(result, []).other ?? result.message;
        const text = t('slideLabels.refused', { message });
        setOther(text);
        say('assertive', text);
        return;
      }
      const name = confirming.name;
      close();
      await load();
      say('polite', t(archived ? 'slideLabels.announce.archived' : 'slideLabels.announce.restored', { name }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>{t('slideLabels.heading')}</h1>
      {loadFailed ? <p role="alert">{t('slideLabels.loadFailed')}</p> : null}
      {other === undefined ? null : <p role="alert">{other}</p>}
      {loading ? <p role="status">{t('app.loading')}</p> : (
        <div class="table-scroll">
          <table class="slide-labels-table">
            <caption>{t('slideLabels.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('slideLabels.column.name')}</th>
                <th scope="col">{t('slideLabels.column.shortcut')}</th>
                <th scope="col">{t('slideLabels.column.status')}</th>
                <th scope="col">{t('slideLabels.column.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {labels.map((row) => {
                const archived = row.stamp.archivedAt !== undefined;
                return (
                  <tr key={row.stamp.id}>
                    <th scope="row">{row.name}</th>
                    <td>{row.shortcut ?? t('slideLabels.noShortcut')}</td>
                    <td>{t(archived ? 'slideLabels.status.archived' : 'slideLabels.status.active')}</td>
                    <td>
                      <button type="button" onClick={() => void open(row)}>
                        {t(archived ? 'slideLabels.action.restore' : 'slideLabels.action.archive', { name: row.name })}
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
          id="slide-labels-confirm"
          title={t(confirming.action === 'archive' ? 'slideLabels.archiveConfirmTitle' : 'slideLabels.restoreConfirmTitle', { name: confirming.name })}
          body={t(confirming.action === 'archive' ? 'slideLabels.archiveConfirmBody' : 'slideLabels.restoreConfirmBody', { name: confirming.name })}
          confirmLabel={t('slideLabels.confirm')}
          cancelLabel={t('slideLabels.cancel')}
          busy={busy}
          onConfirm={() => void confirm()}
          onCancel={close}
        >
          {confirming.action === 'archive' && dependents !== undefined && dependents.count > 0 ? (
            <p>{t('slideLabels.dependentsWarning', { count: dependents.count })}</p>
          ) : null}
        </ConfirmDialog>
      )}
    </>
  );
}
