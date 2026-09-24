// The background job queue an administrator watches and, on a failed job, asks be tried again
// (spec v1c-14, OUI-01). Seeing and acting are gated apart, matching `job-routes.ts`'s own split:
// `jobs.view` gates the two GET routes this page reads, `jobs.manage` gates the Requeue action. There is
// no cursor on the list route (`job-routes.ts` lines 8-9), so this page has no paging, only the kind/state
// filters the route accepts. The whole record is shown, nothing withheld — `ADMIN_VISIBLE_FIELDS` in
// `packages/contracts/src/jobs.ts` names every field a job carries and this page renders each one; only
// `lastError` gets a width-limiting disclosure, since the server has already redacted what it sends
// (`admin-audit.tsx`'s own comment on that same assumption for audit `detail`) and there is nothing left
// to re-decide here, only long text to keep from stretching the table. A 409 refusal — including the
// `restore-apply`/`media-root-migrate` "not requeued here" case `job-routes.ts` returns — is shown as the
// server wrote it, not reworded.

import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { JOB_STATES, type JobRecord, type JobState } from '@holydeck/contracts/jobs';

import { can, csrf } from '../app-state.js';
import { TruncatedText } from '../components/truncated-text.js';
import { t } from '../i18n.js';
import { NotFoundPage } from './not-found.js';
import { request } from '../request.js';

import type { JSX } from 'preact';

export const JOBS_PATH = '/api/v1/jobs';
const JOBS_SUMMARY_PATH = `${JOBS_PATH}/summary`;

// Mirrors `job-routes.ts`'s own `REQUEUE_REFUSED_KINDS`: these two kinds refuse a requeue server-side (409),
// so the button is withheld here rather than offered and then refused.
const REQUEUE_REFUSED_KINDS = new Set(['restore-apply', 'media-root-migrate']);

type JobSummary = Readonly<Record<JobState, number>>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isJobState = (value: unknown): value is JobState => typeof value === 'string' && (JOB_STATES as readonly string[]).includes(value);

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** Parses one row exactly to `JobRecord`'s own discriminated shape, leased jobs kept apart from the rest. */
const parsedJob = (value: unknown): JobRecord | undefined => {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['kind'] !== 'string' ||
    typeof value['idempotencyKey'] !== 'string' ||
    !isRecord(value['payload']) ||
    !isJobState(value['state']) ||
    typeof value['attempt'] !== 'number' ||
    typeof value['retryLimit'] !== 'number' ||
    typeof value['queuedAt'] !== 'string' ||
    !isStringArray(value['workers'])
  ) {
    return undefined;
  }
  const base = {
    id: value['id'],
    kind: value['kind'],
    idempotencyKey: value['idempotencyKey'],
    payload: value['payload'],
    attempt: value['attempt'],
    retryLimit: value['retryLimit'],
    queuedAt: value['queuedAt'],
    workers: value['workers'],
    lastError: typeof value['lastError'] === 'string' ? value['lastError'] : undefined,
  };
  if (value['state'] === 'leased') {
    if (typeof value['leaseExpiresAt'] !== 'string' || typeof value['heartbeatAt'] !== 'string') return undefined;
    return { ...base, state: 'leased', leaseExpiresAt: value['leaseExpiresAt'], heartbeatAt: value['heartbeatAt'] };
  }
  return {
    ...base,
    state: value['state'],
    leaseExpiresAt: typeof value['leaseExpiresAt'] === 'string' ? value['leaseExpiresAt'] : undefined,
    heartbeatAt: typeof value['heartbeatAt'] === 'string' ? value['heartbeatAt'] : undefined,
  };
};

const parsedJobs = (value: unknown): readonly JobRecord[] => {
  if (!isRecord(value) || !Array.isArray(value['jobs'])) return [];
  return value['jobs'].flatMap((row) => {
    const parsed = parsedJob(row);
    return parsed === undefined ? [] : [parsed];
  });
};

const parsedSummary = (value: unknown): JobSummary | undefined => {
  if (!isRecord(value) || !isRecord(value['summary'])) return undefined;
  const summary = value['summary'];
  const counts: Partial<Record<JobState, number>> = {};
  for (const state of JOB_STATES) {
    if (typeof summary[state] !== 'number') return undefined;
    counts[state] = summary[state];
  }
  return counts as JobSummary;
};

const queryFor = (kind: string, state: string): string => {
  const params = new URLSearchParams();
  if (kind !== '') params.set('kind', kind);
  if (state !== '') params.set('state', state);
  const query = params.toString();
  return query === '' ? JOBS_PATH : `${JOBS_PATH}?${query}`;
};

/** The queued and running background jobs the server tracks, filtered by kind and state. */
export function AdminJobsPage(): JSX.Element {
  const permitted = can('jobs.view');
  const canManage = can('jobs.manage');
  const [kind, setKind] = useState('');
  const [state, setState] = useState('');
  const [jobs, setJobs] = useState<readonly JobRecord[]>([]);
  const [summary, setSummary] = useState<JobSummary | undefined>(undefined);
  const [loading, setLoading] = useState(permitted);
  const [loadFailed, setLoadFailed] = useState(false);
  const [requeuingId, setRequeuingId] = useState<string | undefined>(undefined);
  const [actionMessage, setActionMessage] = useState<string | undefined>(undefined);

  const loadJobs = async (): Promise<void> => {
    const result = await request(queryFor(kind, state));
    if (result.ok) {
      setJobs(parsedJobs(result.data));
      setLoadFailed(false);
    } else {
      setJobs([]);
      setLoadFailed(true);
    }
  };

  const loadSummary = async (): Promise<void> => {
    const result = await request(JOBS_SUMMARY_PATH);
    setSummary(result.ok ? parsedSummary(result.data) : undefined);
  };

  useEffect(() => {
    if (!permitted) return;
    let current = true;
    setLoading(true);
    void (async () => {
      await loadJobs();
      if (current) setLoading(false);
    })();
    return () => {
      current = false;
    };
  }, [permitted, kind, state]);

  useEffect(() => {
    if (permitted) void loadSummary();
  }, [permitted]);

  if (!permitted) return <NotFoundPage />;

  const requeue = async (id: string): Promise<void> => {
    setRequeuingId(id);
    setActionMessage(undefined);
    try {
      const result = await request(`${JOBS_PATH}/${id}/requeue`, { method: 'POST', csrf: csrf() ?? '' });
      if (!result.ok) {
        setActionMessage(result.message);
        return;
      }
      await Promise.all([loadJobs(), loadSummary()]);
    } finally {
      setRequeuingId(undefined);
    }
  };

  return (
    <>
      <h1>{t('jobs.heading')}</h1>
      <dl class="jobs-summary">
        {JOB_STATES.map((value) => (
          <Fragment key={value}>
            <dt>{t(`jobs.state.${value}`)}</dt>
            <dd>{summary?.[value] ?? 0}</dd>
          </Fragment>
        ))}
      </dl>
      <div class="form-field">
        <label for="jobs-kind">{t('jobs.filterKindLabel')}</label>
        <input id="jobs-kind" type="text" value={kind} onChange={(event) => setKind(event.currentTarget.value)} />
      </div>
      <div class="form-field">
        <label for="jobs-state">{t('jobs.filterStateLabel')}</label>
        <select id="jobs-state" value={state} onChange={(event) => setState(event.currentTarget.value)}>
          <option value="">{t('jobs.allStates')}</option>
          {JOB_STATES.map((value) => (
            <option key={value} value={value}>{t(`jobs.state.${value}`)}</option>
          ))}
        </select>
      </div>
      {actionMessage === undefined ? null : <p role="alert">{actionMessage}</p>}
      {loadFailed ? <p role="alert">{t('jobs.loadFailed')}</p> : null}
      {loading && jobs.length === 0 && !loadFailed ? <p role="status">{t('app.loading')}</p> : null}
      {!loading && jobs.length === 0 && !loadFailed ? <p>{t('jobs.empty')}</p> : null}
      {jobs.length === 0 ? null : (
        <div class="table-scroll">
          <table class="jobs-table">
            <caption>{t('jobs.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('jobs.column.id')}</th>
                <th scope="col">{t('jobs.column.kind')}</th>
                <th scope="col">{t('jobs.column.state')}</th>
                <th scope="col">{t('jobs.column.attempt')}</th>
                <th scope="col">{t('jobs.column.queuedAt')}</th>
                <th scope="col">{t('jobs.column.workers')}</th>
                <th scope="col">{t('jobs.column.leaseExpiresAt')}</th>
                <th scope="col">{t('jobs.column.heartbeatAt')}</th>
                <th scope="col">{t('jobs.column.lastError')}</th>
                <th scope="col">{t('jobs.column.idempotencyKey')}</th>
                <th scope="col">{t('jobs.column.payload')}</th>
                {canManage ? <th scope="col">{t('jobs.column.actions')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {jobs.map((row) => (
                <tr key={row.id}>
                  <th scope="row">{row.id}</th>
                  <td>{row.kind}</td>
                  <td>{t(`jobs.state.${row.state}`)}</td>
                  <td>{`${row.attempt} / ${row.retryLimit}`}</td>
                  <td>{row.queuedAt}</td>
                  <td>{row.workers.length === 0 ? '—' : row.workers.join(', ')}</td>
                  <td>{row.leaseExpiresAt ?? '—'}</td>
                  <td>{row.heartbeatAt ?? '—'}</td>
                  <td>{row.lastError === undefined ? '—' : <TruncatedText text={row.lastError} />}</td>
                  <td>{row.idempotencyKey}</td>
                  <td><code>{JSON.stringify(row.payload)}</code></td>
                  {canManage ? (
                    <td>
                      {row.state === 'failed' && !REQUEUE_REFUSED_KINDS.has(row.kind) ? (
                        <button type="button" disabled={requeuingId === row.id} onClick={() => void requeue(row.id)}>
                          {t('jobs.requeue')}
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
