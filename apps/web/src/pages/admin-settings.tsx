// The deployment's one settings file, read back with which layer supplied each value (default, the
// settings file, or its environment) and changed through the same PATCH the server validates and audits.
// Gated on `settings.manage`, the permission `app-shell.tsx` already checks to decide whether Administration
// is shown at all. The field list below is kept in sync by hand with `apps/app/src/settings.ts`'s `Settings`
// interface: the web client has no package boundary into `apps/app`, so this is the one place that shape
// is repeated.

import { useEffect, useState } from 'preact/hooks';

import { can, csrf } from '../app-state.js';
import { FormField } from '../components/form-field.js';
import { fieldErrors } from '../form-errors.js';
import { t } from '../i18n.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';
import { say } from '../status.js';

import type { MessageKey } from '@holydeck/localization/messages';
import type { JSX } from 'preact';

export const SETTINGS_PATH = '/api/v1/settings';

type FieldKind = 'text' | 'number' | 'boolean' | 'secret' | 'timezone';

interface FieldSpec {
  readonly key: string;
  readonly label: MessageKey;
  readonly kind: FieldKind;
}

interface FieldGroup {
  readonly legend: MessageKey;
  readonly fields: readonly FieldSpec[];
}

// The five groups COLAB-09 names, in its order. `mongoUrl` is a secret here for the same reason it is in
// `settings.ts`'s `SETTINGS_SECRET_FIELDS`: it can carry the database password, the server answers it
// redacted, and a text field would send that redaction marker straight back as the new password.
const GROUPS: readonly FieldGroup[] = [
  {
    legend: 'settings.group.general',
    fields: [
      { key: 'port', label: 'settings.field.port', kind: 'number' },
      { key: 'dataDir', label: 'settings.field.dataDir', kind: 'text' },
      { key: 'mediaRoot', label: 'settings.field.mediaRoot', kind: 'text' },
      { key: 'locale', label: 'settings.field.locale', kind: 'text' },
      { key: 'developmentDiagnostics', label: 'settings.field.developmentDiagnostics', kind: 'boolean' },
    ],
  },
  {
    legend: 'settings.group.timezone',
    fields: [{ key: 'timezone', label: 'settings.field.timezone', kind: 'timezone' }],
  },
  {
    legend: 'settings.group.security',
    fields: [
      { key: 'tlsCertFile', label: 'settings.field.tlsCertFile', kind: 'text' },
      { key: 'tlsKeyFile', label: 'settings.field.tlsKeyFile', kind: 'text' },
      { key: 'mongoUrl', label: 'settings.field.mongoUrl', kind: 'secret' },
      { key: 'resticRepository', label: 'settings.field.resticRepository', kind: 'text' },
      { key: 'resticPassword', label: 'settings.field.resticPassword', kind: 'secret' },
    ],
  },
  {
    legend: 'settings.group.retention',
    fields: [
      { key: 'auditRetentionDays', label: 'settings.field.auditRetentionDays', kind: 'number' },
      { key: 'autosaveRetentionDays', label: 'settings.field.autosaveRetentionDays', kind: 'number' },
    ],
  },
  {
    legend: 'settings.group.integrations',
    fields: [
      { key: 'corpusUrl', label: 'settings.field.corpusUrl', kind: 'text' },
      { key: 'corpusToken', label: 'settings.field.corpusToken', kind: 'secret' },
      { key: 'sermonAiEnabled', label: 'settings.field.sermonAiEnabled', kind: 'boolean' },
      { key: 'anthropicApiKey', label: 'settings.field.anthropicApiKey', kind: 'secret' },
    ],
  },
];

const FIELDS: readonly FieldSpec[] = GROUPS.flatMap((group) => group.fields);
const FIELD_KEYS: readonly string[] = FIELDS.map((field) => field.key);

// Refused by the server regardless of who asks (`settings.ts`'s `PROTECTED_SETTINGS`): only the
// deployment's own environment sets this. Disabled here rather than let every edit round-trip into a
// guaranteed refusal.
const PROTECTED = new Set(['developmentDiagnostics']);

/**
 * Every IANA zone this browser knows, with the one already chosen kept even when it does not know it —
 * a select that cannot show its own value would quietly offer to change it. `UTC` is listed first: some
 * engines leave it out of `supportedValuesOf`, and it is the default `settings.ts` starts from.
 */
const timeZones = (current: string): readonly string[] => {
  const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return [...new Set(['UTC', current, ...known].filter((zone) => zone !== ''))];
};

const SOURCE_LABEL: Readonly<Record<string, MessageKey>> = {
  default: 'settings.source.default',
  file: 'settings.source.file',
  env: 'settings.source.env',
};

interface SettingsView {
  readonly values: Record<string, unknown>;
  readonly sources: Record<string, string>;
  readonly lastReloadError?: string;
}

const asSettingsView = (data: unknown): SettingsView | undefined => {
  const record = data as { readonly values?: unknown; readonly sources?: unknown; readonly lastReloadError?: unknown } | undefined;
  if (typeof record?.values !== 'object' || record.values === null) return undefined;
  if (typeof record.sources !== 'object' || record.sources === null) return undefined;
  return {
    values: record.values as Record<string, unknown>,
    sources: record.sources as Record<string, string>,
    lastReloadError: typeof record.lastReloadError === 'string' ? record.lastReloadError : undefined,
  };
};

// A number field keeps what was typed until the save, so an empty or fractional entry can be refused
// beside the field instead of being sent as whatever `Number()` makes of it (`Number('')` is 0).
type PendingValue = string | boolean;

const WHOLE_NUMBER = /^\d+$/u;

const without = <T,>(record: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

/** The settings administration screen: every known field, which layer supplied it, and a guarded edit. */
export function AdminSettingsPage(): JSX.Element {
  const permitted = can('settings.manage');
  const [settings, setSettings] = useState<SettingsView>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<Record<string, PendingValue>>({});
  const [saving, setSaving] = useState(false);
  const [other, setOther] = useState<string>();
  const [byField, setByField] = useState<Record<string, string>>({});

  const load = async (): Promise<void> => {
    const result = await request(SETTINGS_PATH);
    const parsed = result.ok ? asSettingsView(result.data) : undefined;
    setSettings(parsed);
    setLoadFailed(parsed === undefined);
  };

  useEffect(() => {
    if (permitted) void load();
  }, [permitted]);

  if (!permitted) return <NotFoundPage />;

  // A secret emptied again is the same as one never typed into: blank means keep, never clear.
  const setField = (key: string, value: PendingValue, secret = false): void => {
    setPending((current) => {
      if (secret && value === '') return without(current, key);
      return { ...current, [key]: value };
    });
    setByField((current) => without(current, key));
    setOther(undefined);
  };

  const save = async (event: JSX.TargetedEvent<HTMLFormElement, SubmitEvent>): Promise<void> => {
    event.preventDefault();
    if (Object.keys(pending).length === 0) return;
    const body: Record<string, string | number | boolean> = {};
    const invalid: Record<string, string> = {};
    for (const field of FIELDS) {
      const value = pending[field.key];
      if (value === undefined) continue;
      if (field.kind !== 'number') body[field.key] = value;
      else if (typeof value === 'string' && WHOLE_NUMBER.test(value.trim())) body[field.key] = Number(value.trim());
      else invalid[field.key] = t('settings.numberInvalid');
    }
    if (Object.keys(invalid).length > 0) {
      setByField(invalid);
      say('assertive', t('settings.refusedFields'));
      return;
    }
    setSaving(true);
    try {
      const result = await request(SETTINGS_PATH, { method: 'PATCH', csrf: csrf() ?? '', body });
      if (!result.ok) {
        const split = fieldErrors(result, FIELD_KEYS);
        setByField(split.byField);
        const text = split.other === undefined && Object.keys(split.byField).length > 0
          ? t('settings.refusedFields')
          : t('settings.refused', { message: split.other ?? result.message });
        setOther(text);
        say('assertive', text);
        return;
      }
      const parsed = asSettingsView(result.data);
      if (parsed !== undefined) setSettings(parsed);
      setPending({});
      setByField({});
      say('polite', t('settings.saved'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h1>{t('settings.title')}</h1>
      {loadFailed ? <p role="alert">{t('settings.loadFailed')}</p> : null}
      {other === undefined ? null : <p role="alert">{other}</p>}
      {settings === undefined ? (
        loadFailed ? null : <p role="status">{t('app.loading')}</p>
      ) : (
        <form noValidate onSubmit={(event) => void save(event)}>
          {settings.lastReloadError === undefined ? null : (
            <p role="alert">{t('settings.reloadError', { message: settings.lastReloadError })}</p>
          )}
          {GROUPS.map((group) => (
            <fieldset key={group.legend}>
              <legend>{t(group.legend)}</legend>
              {group.fields.map((field) => {
                const current = field.key in pending ? pending[field.key] : settings.values[field.key];
                const source = settings.sources[field.key];
                const sourceLabel = source === undefined ? undefined : SOURCE_LABEL[source];
                // The environment wins over the file on every reload, so a change saved here would be
                // written and then never seen; the field says where the value really comes from instead.
                const fromEnv = source === 'env';
                const locked = PROTECTED.has(field.key) || fromEnv;
                const id = `settings-${field.key}`;
                const error = byField[field.key];
                const hint = fromEnv ? t('settings.envHint') : undefined;
                return (
                  <div key={field.key}>
                    {field.kind === 'boolean' ? (
                      <label>
                        <input
                          type="checkbox"
                          checked={Boolean(current)}
                          disabled={locked}
                          onChange={(event) => setField(field.key, event.currentTarget.checked)}
                        />
                        {' '}{t(field.label)}
                      </label>
                    ) : field.kind === 'timezone' ? (
                      <div class="form-field">
                        <label for={id}>{t(field.label)}</label>
                        <select
                          id={id}
                          value={String(current ?? '')}
                          disabled={locked}
                          aria-invalid={error === undefined ? undefined : 'true'}
                          aria-describedby={error === undefined ? undefined : `${id}-error`}
                          onChange={(event) => setField(field.key, event.currentTarget.value)}
                        >
                          {timeZones(String(current ?? '')).map((zone) => <option key={zone} value={zone}>{zone}</option>)}
                        </select>
                      </div>
                    ) : field.kind === 'secret' ? (
                      <FormField
                        id={id}
                        label={t(field.label)}
                        type="password"
                        value={typeof pending[field.key] === 'string' ? pending[field.key] as string : ''}
                        onInput={(value) => setField(field.key, value, true)}
                        hint={hint ?? t('settings.secretHint')}
                        error={error}
                        autoComplete="off"
                        disabled={locked}
                      />
                    ) : (
                      <FormField
                        id={id}
                        label={t(field.label)}
                        value={String(current ?? '')}
                        onInput={(value) => setField(field.key, value)}
                        inputMode={field.kind === 'number' ? 'numeric' : 'text'}
                        hint={hint}
                        error={error}
                        disabled={locked}
                      />
                    )}
                    {field.kind === 'boolean' || field.kind === 'timezone' ? (
                      <>
                        {hint === undefined ? null : <p id={`${id}-hint`} class="form-hint">{hint}</p>}
                        {error === undefined ? null : <p id={`${id}-error`} class="form-error">{error}</p>}
                      </>
                    ) : null}
                    {sourceLabel === undefined ? null : <span>{t(sourceLabel)}</span>}
                  </div>
                );
              })}
            </fieldset>
          ))}
          <button type="submit" disabled={saving || Object.keys(pending).length === 0}>{t('settings.save')}</button>
        </form>
      )}
    </>
  );
}
