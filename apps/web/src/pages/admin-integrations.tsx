// The one screen that turns on a third-party integration (spec v1c-09, ADMN-04). The server is the whole
// authority here: it silently clamps an enable request back to false when nothing is configured to call
// (integration-routes.ts's `statusOf`/PATCH handler), so this page disables that action itself rather than
// let an administrator send a request the server would honor without doing what it asked for.

import { useEffect, useState } from 'preact/hooks';

import { can, csrf } from '../app-state.js';
import { fieldErrors } from '../form-errors.js';
import { t } from '../i18n.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';
import { say } from '../status.js';

import type { MessageKey } from '@holydeck/localization/messages';
import type { JSX } from 'preact';

export const INTEGRATIONS_PATH = '/api/v1/integrations';

const NAME: Readonly<Record<string, MessageKey>> = {
  'sermon-ai': 'integrations.name.sermon-ai',
};

interface IntegrationView {
  readonly id: string;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly lastCallAt: string | null;
  readonly callsInLast30Days: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const parsedIntegration = (value: unknown): IntegrationView | undefined => {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['configured'] !== 'boolean' ||
    typeof value['enabled'] !== 'boolean' ||
    (typeof value['lastCallAt'] !== 'string' && value['lastCallAt'] !== null) ||
    typeof value['callsInLast30Days'] !== 'number'
  ) {
    return undefined;
  }
  return {
    id: value['id'],
    configured: value['configured'],
    enabled: value['enabled'],
    lastCallAt: value['lastCallAt'],
    callsInLast30Days: value['callsInLast30Days'],
  };
};

const parsedIntegrations = (value: unknown): { readonly integrations: readonly IntegrationView[]; readonly failed: boolean } => {
  if (!Array.isArray(value)) return { integrations: [], failed: true };
  let failed = false;
  const integrations = value.flatMap((row) => {
    const parsed = parsedIntegration(row);
    if (parsed === undefined) failed = true;
    return parsed === undefined ? [] : [parsed];
  });
  return { integrations, failed };
};

/** Every known third-party integration, its configuration status, and its one on/off switch. */
export function AdminIntegrationsPage(): JSX.Element {
  const permitted = can('integrations.manage');
  const [integrations, setIntegrations] = useState<readonly IntegrationView[]>([]);
  const [loading, setLoading] = useState(permitted);
  const [loadFailed, setLoadFailed] = useState(false);
  const [other, setOther] = useState<string>();
  const [changing, setChanging] = useState<string>();

  const load = async (): Promise<void> => {
    setLoading(true);
    setLoadFailed(false);
    const result = await request(INTEGRATIONS_PATH);
    const parsed = result.ok ? parsedIntegrations(result.data) : undefined;
    setIntegrations(parsed?.integrations ?? []);
    setLoadFailed(parsed === undefined || parsed.failed);
    setLoading(false);
  };

  useEffect(() => {
    if (permitted) void load();
  }, [permitted]);

  if (!permitted) return <NotFoundPage />;

  const toggle = async (integration: IntegrationView): Promise<void> => {
    setChanging(integration.id);
    setOther(undefined);
    const name = t(NAME[integration.id] ?? 'integrations.column.name');
    try {
      const result = await request(`${INTEGRATIONS_PATH}/${encodeURIComponent(integration.id)}`, {
        method: 'PATCH',
        csrf: csrf() ?? '',
        body: { enabled: !integration.enabled },
      });
      if (!result.ok) {
        const message = fieldErrors(result, []).other ?? result.message;
        const text = t('integrations.refused', { message });
        setOther(text);
        say('assertive', text);
        return;
      }
      await load();
      say('polite', t(integration.enabled ? 'integrations.announce.disabled' : 'integrations.announce.enabled', { name }));
    } finally {
      setChanging(undefined);
    }
  };

  return (
    <>
      <h1>{t('integrations.heading')}</h1>
      {loadFailed ? <p role="alert">{t('integrations.loadFailed')}</p> : null}
      {other === undefined ? null : <p role="alert">{other}</p>}
      {loading ? <p role="status">{t('app.loading')}</p> : (
        <div class="table-scroll">
          <table class="integrations-table">
            <caption>{t('integrations.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('integrations.column.name')}</th>
                <th scope="col">{t('integrations.column.configured')}</th>
                <th scope="col">{t('integrations.column.status')}</th>
                <th scope="col">{t('integrations.column.calls')}</th>
                <th scope="col">{t('integrations.column.lastCall')}</th>
                <th scope="col">{t('integrations.column.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {integrations.map((integration) => {
                const busy = changing === integration.id;
                const name = t(NAME[integration.id] ?? 'integrations.column.name');
                return (
                  <tr key={integration.id}>
                    <th scope="row">{name}</th>
                    <td>{t(integration.configured ? 'integrations.configured.yes' : 'integrations.configured.no')}</td>
                    <td>{t(integration.enabled ? 'integrations.status.enabled' : 'integrations.status.disabled')}</td>
                    <td>{integration.callsInLast30Days}</td>
                    <td>{integration.lastCallAt ?? t('integrations.never')}</td>
                    <td>
                      <button
                        type="button"
                        disabled={busy || (!integration.enabled && !integration.configured)}
                        onClick={() => void toggle(integration)}
                      >
                        {t(integration.enabled ? 'integrations.action.disable' : 'integrations.action.enable', { name })}
                      </button>
                      {integration.configured ? null : <p>{t('integrations.hint.notConfigured')}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
