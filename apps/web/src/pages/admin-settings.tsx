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

type FieldKind = 'text' | 'number' | 'boolean' | 'secret';

interface FieldSpec {
  readonly key: string;
  readonly label: MessageKey;
  readonly kind: FieldKind;
}

const FIELDS: readonly FieldSpec[] = [
  { key: 'port', label: 'settings.field.port', kind: 'number' },
  { key: 'dataDir', label: 'settings.field.dataDir', kind: 'text' },
  { key: 'mediaRoot', label: 'settings.field.mediaRoot', kind: 'text' },
  { key: 'resticRepository', label: 'settings.field.resticRepository', kind: 'text' },
  { key: 'resticPassword', label: 'settings.field.resticPassword', kind: 'secret' },
  { key: 'locale', label: 'settings.field.locale', kind: 'text' },
  { key: 'corpusUrl', label: 'settings.field.corpusUrl', kind: 'text' },
  { key: 'corpusToken', label: 'settings.field.corpusToken', kind: 'secret' },
  { key: 'tlsCertFile', label: 'settings.field.tlsCertFile', kind: 'text' },
  { key: 'tlsKeyFile', label: 'settings.field.tlsKeyFile', kind: 'text' },
  { key: 'mongoUrl', label: 'settings.field.mongoUrl', kind: 'text' },
  { key: 'timezone', label: 'settings.field.timezone', kind: 'text' },
  { key: 'developmentDiagnostics', label: 'settings.field.developmentDiagnostics', kind: 'boolean' },
  { key: 'auditRetentionDays', label: 'settings.field.auditRetentionDays', kind: 'number' },
  { key: 'autosaveRetentionDays', label: 'settings.field.autosaveRetentionDays', kind: 'number' },
  { key: 'sermonAiEnabled', label: 'settings.field.sermonAiEnabled', kind: 'boolean' },
  { key: 'anthropicApiKey', label: 'settings.field.anthropicApiKey', kind: 'secret' },
];

// Refused by the server regardless of who asks (`settings.ts`'s `PROTECTED_SETTINGS`): only the
// deployment's own environment sets this. Disabled here rather than let every edit round-trip into a
// guaranteed refusal.
const PROTECTED = new Set(['developmentDiagnostics']);

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

type PendingValue = string | number | boolean;

/** The settings administration screen: every known field, which layer supplied it, and a guarded edit. */
export function AdminSettingsPage(): JSX.Element {
  const permitted = can('settings.manage');
  const [settings, setSettings] = useState<SettingsView>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<Record<string, PendingValue>>({});
  const [saving, setSaving] = useState(false);
  const [other, setOther] = useState<string>();

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

  const setField = (key: string, value: PendingValue): void => {
    setPending((current) => ({ ...current, [key]: value }));
    setOther(undefined);
  };

  const save = async (event: JSX.TargetedEvent<HTMLFormElement, SubmitEvent>): Promise<void> => {
    event.preventDefault();
    if (Object.keys(pending).length === 0) return;
    setSaving(true);
    try {
      const result = await request(SETTINGS_PATH, { method: 'PATCH', csrf: csrf() ?? '', body: pending });
      if (!result.ok) {
        const message = fieldErrors(result, []).other ?? result.message;
        const text = t('settings.refused', { message });
        setOther(text);
        say('assertive', text);
        return;
      }
      const parsed = asSettingsView(result.data);
      if (parsed !== undefined) setSettings(parsed);
      setPending({});
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
          {FIELDS.map((field) => {
            const current = field.key in pending ? pending[field.key] : settings.values[field.key];
            const source = settings.sources[field.key];
            const sourceLabel = source === undefined ? undefined : SOURCE_LABEL[source];
            const protectedField = PROTECTED.has(field.key);
            return (
              <div key={field.key}>
                {field.kind === 'boolean' ? (
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(current)}
                      disabled={protectedField}
                      onChange={(event) => setField(field.key, event.currentTarget.checked)}
                    />
                    {' '}{t(field.label)}
                  </label>
                ) : field.kind === 'secret' ? (
                  <FormField
                    id={`settings-${field.key}`}
                    label={t(field.label)}
                    type="password"
                    value={typeof pending[field.key] === 'string' ? pending[field.key] as string : ''}
                    onInput={(value) => setField(field.key, value)}
                    hint={t('settings.secretHint')}
                    autoComplete="off"
                  />
                ) : (
                  <FormField
                    id={`settings-${field.key}`}
                    label={t(field.label)}
                    value={String(current ?? '')}
                    onInput={(value) => setField(field.key, field.kind === 'number' ? Number(value) : value)}
                    inputMode={field.kind === 'number' ? 'numeric' : 'text'}
                  />
                )}
                {sourceLabel === undefined ? null : <span>{t(sourceLabel)}</span>}
              </div>
            );
          })}
          <button type="submit" disabled={saving || Object.keys(pending).length === 0}>{t('settings.save')}</button>
        </form>
      )}
    </>
  );
}
