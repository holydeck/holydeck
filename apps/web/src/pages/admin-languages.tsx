// The content-language catalogue as it is administered (spec v1c-09, ADMN-05, COLAB-13): list with each
// language's usage count, create, edit, archive, restore. A language's key is its identity (content
// names it by key), so the key is asked for only when creating; editing sends the other three fields to
// the key's own route. A refusal naming a field is shown beside that field, anything else above the form.
// Archiving a language is never refused for being in use — a
// language block keyed to an archived language keeps resolving — so the dependents count in the confirm
// dialog is shown as information, not as a gate the administrator must clear first.

import { parseEntityStamp } from '@holydeck/contracts/entities';
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
import type { Refused } from '../api.js';
import type { JSX } from 'preact';

export const LANGUAGES_PATH = '/api/v1/content-languages';

interface LanguageRow {
  readonly stamp: EntityStamp;
  readonly displayName: string;
  readonly script: string;
  readonly fallbackFont: string;
  /** How many current items name this language; absent when the server did not count. */
  readonly usage?: number;
}

/** What the form edits: every field the create route takes, `key` ignored when editing. */
interface Draft {
  readonly key: string;
  readonly displayName: string;
  readonly script: string;
  readonly fallbackFont: string;
}

const FORM_FIELDS = ['key', 'displayName', 'script', 'fallbackFont'] as const;

const EMPTY_DRAFT: Draft = { key: '', displayName: '', script: '', fallbackFont: '' };

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
  const usage = typeof value['usage'] === 'number' ? value['usage'] : undefined;
  return {
    stamp: stamp.value,
    displayName: value['displayName'],
    script: value['script'],
    fallbackFont: value['fallbackFont'],
    ...(usage === undefined ? {} : { usage }),
  };
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

/** A refusal's field messages, and its page-level message said as the refusal it is. */
const refusalOf = (result: Refused): { readonly byField: Record<string, string>; readonly other: string | undefined } => {
  const split = fieldErrors(result, FORM_FIELDS);
  const other = result.fields.length === 0 ? result.message : split.other;
  return { byField: split.byField, other: other === undefined ? undefined : t('languages.refused', { message: other }) };
};

/** The create or edit form: `editing` names the language being edited, absent when creating one. */
function LanguageForm({ editing, onSaved, onCancel }: {
  readonly editing: LanguageRow | undefined;
  readonly onSaved: (name: string) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<Draft>(
    editing === undefined
      ? EMPTY_DRAFT
      : { key: editing.stamp.id, displayName: editing.displayName, script: editing.script, fallbackFont: editing.fallbackFont },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [other, setOther] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (field: keyof Draft) => (value: string): void => setDraft({ ...draft, [field]: value });

  const save = async (event: Event): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      const { key, ...fields } = draft;
      const result = editing === undefined
        ? await request(LANGUAGES_PATH, { method: 'POST', csrf: csrf() ?? '', body: draft })
        : await request(`${LANGUAGES_PATH}/${encodeURIComponent(key)}`, { method: 'PUT', csrf: csrf() ?? '', body: fields });
      if (!result.ok) {
        const refusal = refusalOf(result);
        setErrors(refusal.byField);
        setOther(refusal.other);
        if (refusal.other !== undefined) say('assertive', refusal.other);
        return;
      }
      onSaved(draft.displayName);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="language-form-heading">
      <h2 id="language-form-heading">
        {editing === undefined ? t('languages.form.createHeading') : t('languages.form.editHeading', { name: editing.displayName })}
      </h2>
      {other === undefined ? null : <p role="alert">{other}</p>}
      <form onSubmit={(event) => void save(event)} noValidate>
        {editing === undefined ? (
          <FormField id="language-key" label={t('languages.form.key')} hint={t('languages.form.keyHint')} value={draft.key} onInput={set('key')} error={errors['key']} required />
        ) : null}
        <FormField id="language-name" label={t('languages.form.displayName')} value={draft.displayName} onInput={set('displayName')} error={errors['displayName']} required />
        <FormField id="language-script" label={t('languages.form.script')} value={draft.script} onInput={set('script')} error={errors['script']} required />
        <FormField id="language-font" label={t('languages.form.fallbackFont')} value={draft.fallbackFont} onInput={set('fallbackFont')} error={errors['fallbackFont']} required />
        <button type="submit" disabled={busy}>{t('languages.form.save')}</button>
        <button type="button" disabled={busy} onClick={onCancel}>{t('languages.cancel')}</button>
      </form>
    </section>
  );
}

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
  /** The form, when open: `{ editing: undefined }` is a new language. */
  const [form, setForm] = useState<{ readonly editing: LanguageRow | undefined }>();

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

  const saved = async (name: string): Promise<void> => {
    const created = form?.editing === undefined;
    setForm(undefined);
    await load();
    say('polite', t(created ? 'languages.announce.created' : 'languages.announce.edited', { name }));
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
      {form === undefined ? (
        <button type="button" onClick={() => setForm({ editing: undefined })}>{t('languages.add')}</button>
      ) : (
        <LanguageForm
          key={form.editing?.stamp.id ?? ''}
          editing={form.editing}
          onSaved={(name) => void saved(name)}
          onCancel={() => setForm(undefined)}
        />
      )}
      {loading ? <p role="status">{t('app.loading')}</p> : (
        <div class="table-scroll">
          <table class="languages-table">
            <caption>{t('languages.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('languages.column.name')}</th>
                <th scope="col">{t('languages.column.script')}</th>
                <th scope="col">{t('languages.column.fallbackFont')}</th>
                <th scope="col">{t('languages.column.usage')}</th>
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
                    <td>{row.usage ?? ''}</td>
                    <td>{t(archived ? 'languages.status.archived' : 'languages.status.active')}</td>
                    <td>
                      <button type="button" onClick={() => setForm({ editing: row })}>
                        {t('languages.action.edit', { name: row.displayName })}
                      </button>
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
