// @vitest-environment happy-dom
// The background job queue an administrator watches (spec v1c-14, OUI-01): filters by kind/state, a
// summary of counts per state, and a Requeue action gated apart from viewing, exactly what
// `job-routes.ts` exposes.

import { render, screen, waitFor, fireEvent } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { App } from '../app.js';
import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { currentPath } from '../router.js';
import { AdminJobsPage, JOBS_PATH } from './admin-jobs.js';

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const signedIn = (permissions = ['jobs.view']): SessionView => ({
  account: { id: 'a1', name: 'andru', displayName: 'Andru Example', role: 'admin', controlPresentation: false },
  actor: 'account:a1',
  permissions,
  startedAt: '2026-09-13T09:30:00.000Z',
  lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z',
  rotation: 'authentication',
  csrf: 'c'.repeat(43),
  slots: [],
} as unknown as SessionView);

const job = (overrides: Partial<{
  id: string;
  kind: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  state: string;
  attempt: number;
  retryLimit: number;
  queuedAt: string;
  workers: readonly string[];
  leaseExpiresAt: string;
  heartbeatAt: string;
  lastError: string;
}> = {}) => ({
  id: 'job-1',
  kind: 'sermon-import',
  idempotencyKey: 'sermon-import:1',
  payload: {},
  state: 'queued',
  attempt: 0,
  retryLimit: 3,
  queuedAt: '2026-09-22T00:00:00.000Z',
  workers: [],
  ...overrides,
});

const jobsReply = (jobs: readonly unknown[]) => reply(200, successEnvelope({ jobs }, 'request-jobs'));

const summaryReply = (summary: Record<string, number>) =>
  reply(200, successEnvelope({ summary: { queued: 0, leased: 0, succeeded: 0, failed: 0, ...summary } }, 'request-jobs-summary'));

const renderPage = async (): Promise<void> => {
  currentPath.value = '/admin/jobs';
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Jobs' });
};

/** Routes a mocked fetch by path prefix, so a page's list/summary calls each get their own canned reply. */
const byPath = (routes: {
  jobs?: () => ReturnType<typeof reply>;
  summary?: () => ReturnType<typeof reply>;
  requeue?: (id: string) => ReturnType<typeof reply>;
}): FetchLike => (async (path: string) => {
  if (path.startsWith(`${JOBS_PATH}/summary`)) return routes.summary?.() ?? summaryReply({});
  const requeueMatch = /\/([^/]+)\/requeue$/u.exec(path);
  if (requeueMatch?.[1] !== undefined) return routes.requeue?.(requeueMatch[1]) ?? reply(200, successEnvelope(job(), 'request-jobs'));
  return routes.jobs?.() ?? jobsReply([]);
}) as unknown as FetchLike;

describe('AdminJobsPage', () => {
  beforeEach(() => {
    resetAppState();
    session.value = signedIn(['jobs.view']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders jobs from the server, with attempts, state and worker columns', async () => {
    setFetching(byPath({
      jobs: () => jobsReply([job({
        id: 'job-1',
        kind: 'sermon-import',
        state: 'leased',
        attempt: 1,
        retryLimit: 3,
        workers: ['worker-1'],
        leaseExpiresAt: '2026-09-22T00:05:00.000Z',
        heartbeatAt: '2026-09-22T00:01:00.000Z',
      })]),
    }));
    await renderPage();

    expect(await screen.findByText('job-1')).toBeTruthy();
    expect(screen.getByText('sermon-import')).toBeTruthy();
    expect(screen.getByText('1 / 3')).toBeTruthy();
    expect(screen.getByText('worker-1')).toBeTruthy();
    expect(screen.getByText('2026-09-22T00:05:00.000Z')).toBeTruthy();
  });

  it('drops a malformed job row rather than rendering it', async () => {
    setFetching(byPath({ jobs: () => jobsReply([{ id: 'bad' }, job({ id: 'job-1' })]) }));
    await renderPage();

    expect(await screen.findByText('job-1')).toBeTruthy();
    expect(screen.queryByText('bad')).toBeNull();
  });

  it('shows an empty state when no jobs match', async () => {
    setFetching(byPath({ jobs: () => jobsReply([]) }));
    await renderPage();

    expect(await screen.findByText('No jobs match these filters.')).toBeTruthy();
  });

  it('shows a redacted last error the server already trimmed', async () => {
    setFetching(byPath({ jobs: () => jobsReply([job({ state: 'failed', lastError: 'boom' })]) }));
    await renderPage();

    expect(await screen.findByText('boom')).toBeTruthy();
  });

  it('filters by kind with a fresh request', async () => {
    const fetching = vi.fn<FetchLike>(byPath({}));
    setFetching(fetching);
    await renderPage();

    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'sermon-import' } });
    await waitFor(() => expect(fetching.mock.calls.at(-1)?.[0]).toBe(`${JOBS_PATH}?kind=sermon-import`));
  });

  it('filters by state with a fresh request', async () => {
    const fetching = vi.fn<FetchLike>(byPath({}));
    setFetching(fetching);
    await renderPage();

    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'failed' } });
    await waitFor(() => expect(fetching.mock.calls.at(-1)?.[0]).toBe(`${JOBS_PATH}?state=failed`));
  });

  it('renders summary counts from the summary route', async () => {
    setFetching(byPath({ summary: () => summaryReply({ queued: 2, failed: 1 }) }));
    await renderPage();

    expect(await screen.findByText('2')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
  });

  it('offers no Requeue button without jobs.manage, even on a failed row', async () => {
    session.value = signedIn(['jobs.view']);
    setFetching(byPath({ jobs: () => jobsReply([job({ id: 'job-1', state: 'failed' })]) }));
    await renderPage();
    await screen.findByText('job-1');

    expect(screen.queryByRole('button', { name: 'Requeue' })).toBeNull();
  });

  it('offers no Requeue button on a row that is not failed, even with jobs.manage', async () => {
    session.value = signedIn(['jobs.view', 'jobs.manage']);
    setFetching(byPath({ jobs: () => jobsReply([job({ id: 'job-1', state: 'queued' })]) }));
    await renderPage();
    await screen.findByText('job-1');

    expect(screen.queryByRole('button', { name: 'Requeue' })).toBeNull();
  });

  it('requeues a failed job with jobs.manage, then re-fetches the list and the summary', async () => {
    session.value = signedIn(['jobs.view', 'jobs.manage']);
    const fetching = vi.fn<FetchLike>(byPath({
      jobs: () => jobsReply([job({ id: 'job-1', state: 'failed' })]),
      summary: () => summaryReply({ failed: 1 }),
    }));
    setFetching(fetching);
    await renderPage();
    await screen.findByText('job-1');
    const before = fetching.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Requeue' }));

    await waitFor(() => expect(fetching.mock.calls.length).toBeGreaterThan(before));
    expect(fetching.mock.calls.some(
      ([path, init]) => path === `${JOBS_PATH}/job-1/requeue` && (init as { method?: string }).method === 'POST',
    )).toBe(true);
    await waitFor(() => expect(fetching.mock.calls.filter(([path]) => path === JOBS_PATH).length).toBeGreaterThan(1));
    await waitFor(() => expect(fetching.mock.calls.filter(([path]) => path === `${JOBS_PATH}/summary`).length).toBeGreaterThan(1));
  });

  it('renders the server’s own refusal message on a 409, not a generic one', async () => {
    session.value = signedIn(['jobs.view', 'jobs.manage']);
    const message =
      'This kind of job is not requeued here — start a new one through its own route so its checks run fresh.';
    setFetching(byPath({
      jobs: () => jobsReply([job({ id: 'job-1', kind: 'restore-apply', state: 'failed' })]),
      requeue: () => reply(409, errorEnvelope('entity.conflict', message, 'request-jobs')),
    }));
    await renderPage();
    await screen.findByText('job-1');

    fireEvent.click(screen.getByRole('button', { name: 'Requeue' }));

    expect((await screen.findByRole('alert')).textContent).toBe(message);
  });

  it('shows a load failure as an alert', async () => {
    setFetching(async () => reply(500, errorEnvelope('server.failed', 'Failed', 'request-jobs')));
    render(<AdminJobsPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The jobs list could not be loaded.');
  });

  it('renders not found and makes no request without jobs.view permission', () => {
    const fetching = vi.fn<FetchLike>();
    setFetching(fetching);
    session.value = signedIn([]);
    render(<AdminJobsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(fetching).not.toHaveBeenCalled();
  });
});
