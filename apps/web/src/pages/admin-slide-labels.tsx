// The slide-label catalogue as it is administered (spec v1c-09, ADMN-05, COLAB-13): list with each
// label's usage count, create, edit with a shortcut key, archive, restore. Slides name a label by its
// name, so the usage count and the dependents answer are both counted by name on the server.
//
// The store refuses a second live label with the same name or the same shortcut key. The form warns
// about both while it is being filled in, reading the list it already has (archived labels hold
// nothing), so the administrator learns of a collision before saving; the server's 409 is still the
// authority, and its field problems are shown beside the name or shortcut field they are about.

import { parseEntityStamp } from '@holydeck/contracts/entities';
import { SHORTCUT_KEYS } from '@holydeck/contracts/slide-labels';
import { useEffect, useState } from 'preact/hooks';

import { can, csrf } from '../app-state.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { FormField } from '../components/form-field.js';
import { fieldErrors } from '../form-errors.js';
import { t } from '../i18n.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';
import { say } from '../status.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { ShortcutKey } from '@holydeck/contracts/slide-labels';
import type { Refused } from '../api.js';
import type { JSX } from 'preact';

export const SLIDE_LABELS_PATH = '/api/v1/slide-labels';

interface LabelRow {
  readonly stamp: EntityStamp;
  readonly name: string;
  readonly shortcut?: ShortcutKey;
  /** How many current slides carry this label; absent when the server did not count. */
  readonly usage?: number;
}

interface Draft {
  readonly name: string;
  /** '' is "no shortcut", which the request says by leaving the field out. */
  readonly shortcut: ShortcutKey | '';
}

const FORM_FIELDS = ['name', 'shortcut'] as const;

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
  const usage = typeof value['usage'] === 'number' ? value['usage'] : undefined;
  return {
    stamp: stamp.value,
    name: value['name'],
    shortcut: value['shortcut'] as ShortcutKey | undefined,
    ...(usage === undefined ? {} : { usage }),
  };
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

/** A refusal's field messages, and its page-level message said as the refusal it is. */
const refusalOf = (result: Refused): { readonly byField: Record<string, string>; readonly other: string | undefined } => {
  const split = fieldErrors(result, FORM_FIELDS);
  const other = result.fields.length === 0 ? result.message : split.other;
  return { byField: split.byField, other: other === undefined ? undefined : t('slideLabels.refused', { message: other }) };
};

/** The create or edit form: `editing` names the label being edited, absent when creating one. */
function LabelForm({ editing, labels, onSaved, onCancel }: {
  readonly editing: LabelRow | undefined;
  /** Every label the page lists, for the collision warnings. */
  readonly labels: readonly LabelRow[];
  readonly onSaved: (name: string) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<Draft>({ name: editing?.name ?? '', shortcut: editing?.shortcut ?? '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [other, setOther] = useState<string>();
  const [busy, setBusy] = useState(false);

  const others = labels.filter((row) => row.stamp.archivedAt === undefined && row.stamp.id !== editing?.stamp.id);
  const nameHolder = others.find((row) => row.name === draft.name.trim());
  const keyHolder = draft.shortcut === '' ? undefined : others.find((row) => row.shortcut === draft.shortcut);

  const save = async (event: Event): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      const body = { name: draft.name, ...(draft.shortcut === '' ? {} : { shortcut: draft.shortcut }) };
      const result = editing === undefined
        ? await request(SLIDE_LABELS_PATH, { method: 'POST', csrf: csrf() ?? '', body })
        : await request(`${SLIDE_LABELS_PATH}/${encodeURIComponent(editing.stamp.id)}`, { method: 'PUT', csrf: csrf() ?? '', body });
      if (!result.ok) {
        const refusal = refusalOf(result);
        setErrors(refusal.byField);
        setOther(refusal.other);
        if (refusal.other !== undefined) say('assertive', refusal.other);
        return;
      }
      onSaved(draft.name);
    } finally {
      setBusy(false);
    }
  };

  const shortcutError = errors['shortcut'];
  const shortcutWarning = keyHolder === undefined ? undefined : t('slideLabels.form.shortcutTaken', { key: draft.shortcut, name: keyHolder.name });
  const describedBy = [shortcutWarning === undefined ? undefined : 'label-shortcut-warning', shortcutError === undefined ? undefined : 'label-shortcut-error']
    .filter((id): id is string => id !== undefined)
    .join(' ');

  return (
    <section aria-labelledby="label-form-heading">
      <h2 id="label-form-heading">
        {editing === undefined ? t('slideLabels.form.createHeading') : t('slideLabels.form.editHeading', { name: editing.name })}
      </h2>
      {other === undefined ? null : <p role="alert">{other}</p>}
      <form onSubmit={(event) => void save(event)} noValidate>
        <FormField
          id="label-name"
          label={t('slideLabels.form.name')}
          value={draft.name}
          onInput={(name) => setDraft({ ...draft, name })}
          hint={nameHolder === undefined ? undefined : t('slideLabels.form.nameTaken', { name: nameHolder.name })}
          error={errors['name']}
          required
        />
        <div class="form-field">
          <label for="label-shortcut">{t('slideLabels.form.shortcut')}</label>
          <select
            id="label-shortcut"
            value={draft.shortcut}
            onChange={(event) => setDraft({ ...draft, shortcut: event.currentTarget.value as ShortcutKey | '' })}
            aria-invalid={shortcutError === undefined ? undefined : 'true'}
            aria-describedby={describedBy === '' ? undefined : describedBy}
          >
            <option value="">{t('slideLabels.noShortcut')}</option>
            {SHORTCUT_KEYS.map((key) => <option key={key} value={key}>{key}</option>)}
          </select>
          {shortcutWarning === undefined ? null : <p id="label-shortcut-warning" class="form-hint">{shortcutWarning}</p>}
          {shortcutError === undefined ? null : <p id="label-shortcut-error" class="form-error">{shortcutError}</p>}
        </div>
        <button type="submit" disabled={busy}>{t('slideLabels.form.save')}</button>
        <button type="button" disabled={busy} onClick={onCancel}>{t('slideLabels.cancel')}</button>
      </form>
    </section>
  );
}

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
  /** The form, when open: `{ editing: undefined }` is a new label. */
  const [form, setForm] = useState<{ readonly editing: LabelRow | undefined }>();

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

  const saved = async (name: string): Promise<void> => {
    const created = form?.editing === undefined;
    setForm(undefined);
    await load();
    say('polite', t(created ? 'slideLabels.announce.created' : 'slideLabels.announce.edited', { name }));
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
      {form === undefined ? (
        <button type="button" onClick={() => setForm({ editing: undefined })}>{t('slideLabels.add')}</button>
      ) : (
        <LabelForm
          key={form.editing?.stamp.id ?? ''}
          editing={form.editing}
          labels={labels}
          onSaved={(name) => void saved(name)}
          onCancel={() => setForm(undefined)}
        />
      )}
      {loading ? <p role="status">{t('app.loading')}</p> : (
        <div class="table-scroll">
          <table class="slide-labels-table">
            <caption>{t('slideLabels.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('slideLabels.column.name')}</th>
                <th scope="col">{t('slideLabels.column.shortcut')}</th>
                <th scope="col">{t('slideLabels.column.usage')}</th>
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
                    <td>{row.usage ?? ''}</td>
                    <td>{t(archived ? 'slideLabels.status.archived' : 'slideLabels.status.active')}</td>
                    <td>
                      <button type="button" onClick={() => setForm({ editing: row })}>
                        {t('slideLabels.action.edit', { name: row.name })}
                      </button>
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
