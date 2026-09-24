// The operational health report an administrator reads (spec v1c-14, OUI-02). Eleven domains, each
// already judged by `operational-health.ts` server-side: this page renders the domain, its worst state
// and the one action string that already carries the recommendation — there is no separate
// "recommendations" field to read, and this page must not invent one. Kept in sync by hand with
// `OPERATIONAL_DOMAINS`/`OperationalState` the same way `admin-audit.tsx` repeats `AUDIT_CATEGORIES` — the
// web client has no package boundary into `apps/app`. Gated on `operations.read`.

import { useEffect, useState } from 'preact/hooks';

import { can } from '../app-state.js';
import { t } from '../i18n.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';

import type { JSX } from 'preact';

export const OPERATIONS_HEALTH_PATH = '/api/v1/operations/health';

// Mirrors `OPERATIONAL_DOMAINS` (`operational-health.ts:56-68`). The `health` domain is the worker's own
// heartbeat and the `process` domain is this app's own process metrics — OUI-02's "scope label
// (`app-process`/`worker-process`, never `host`)" is prose, not a wire value, so those two are labelled by
// scope in `operations.domain.*` below rather than expecting the server to send either string.
const DOMAINS = [
  'health',
  'storage',
  'queue',
  'backup',
  'restore',
  'media',
  'readiness',
  'database',
  'corpus',
  'disk',
  'process',
] as const;

type Domain = (typeof DOMAINS)[number];

// Mirrors `OperationalState` (`operational-health.ts:77`).
const STATES = ['ok', 'degraded', 'unknown', 'failed'] as const;

type HealthState = (typeof STATES)[number];

interface StatusView {
  readonly domain: Domain;
  readonly state: HealthState;
  readonly action: string;
}

interface HealthReportView {
  readonly at: string;
  readonly state: HealthState;
  readonly action: string;
  readonly statuses: readonly StatusView[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isDomain = (value: unknown): value is Domain => typeof value === 'string' && (DOMAINS as readonly string[]).includes(value);

const isHealthState = (value: unknown): value is HealthState => typeof value === 'string' && (STATES as readonly string[]).includes(value);

const parsedStatus = (value: unknown): StatusView | undefined => {
  if (!isRecord(value) || !isDomain(value['domain']) || !isHealthState(value['state']) || typeof value['action'] !== 'string') {
    return undefined;
  }
  return { domain: value['domain'], state: value['state'], action: value['action'] };
};

const parsedReport = (value: unknown): HealthReportView | undefined => {
  if (!isRecord(value) || !isRecord(value['health'])) return undefined;
  const health = value['health'];
  if (
    typeof health['at'] !== 'string' ||
    !isHealthState(health['state']) ||
    typeof health['action'] !== 'string' ||
    !Array.isArray(health['statuses'])
  ) {
    return undefined;
  }
  const statuses = health['statuses'].flatMap((row) => {
    const parsed = parsedStatus(row);
    return parsed === undefined ? [] : [parsed];
  });
  return { at: health['at'], state: health['state'], action: health['action'], statuses };
};

/** The service's own operational health, by domain, as the server last measured it. */
export function AdminOperationsPage(): JSX.Element {
  const permitted = can('operations.read');
  const [report, setReport] = useState<HealthReportView | undefined>(undefined);
  const [loading, setLoading] = useState(permitted);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    setLoadFailed(false);
    const result = await request(OPERATIONS_HEALTH_PATH);
    const parsed = result.ok ? parsedReport(result.data) : undefined;
    if (parsed !== undefined) setReport(parsed);
    setLoadFailed(parsed === undefined);
    setLoading(false);
  };

  useEffect(() => {
    if (permitted) void load();
  }, [permitted]);

  if (!permitted) return <NotFoundPage />;

  return (
    <>
      <h1>{t('operations.heading')}</h1>
      <button type="button" disabled={loading} onClick={() => void load()}>{t('operations.refresh')}</button>
      {loadFailed ? <p role="alert">{t('operations.loadFailed')}</p> : null}
      {loading && report === undefined && !loadFailed ? <p role="status">{t('app.loading')}</p> : null}
      {report === undefined ? null : (
        <>
          <dl>
            <dt>{t('operations.overallState')}</dt>
            <dd>{t(`operations.state.${report.state}`)}</dd>
            <dt>{t('operations.updatedAt')}</dt>
            <dd>{report.at}</dd>
          </dl>
          <p>{report.action}</p>
          <div class="table-scroll">
            <table class="operations-table">
              <caption>{t('operations.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('operations.column.domain')}</th>
                  <th scope="col">{t('operations.column.state')}</th>
                  <th scope="col">{t('operations.column.action')}</th>
                </tr>
              </thead>
              <tbody>
                {report.statuses.map((status) => (
                  <tr key={status.domain}>
                    <th scope="row">{t(`operations.domain.${status.domain}`)}</th>
                    <td>{t(`operations.state.${status.state}`)}</td>
                    <td>{status.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
