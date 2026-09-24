// @vitest-environment happy-dom
// The operational health report an administrator reads (spec v1c-14, OUI-02): every domain
// `operational-health.ts` measures, its state and the action it recommends — nothing this page invents.

import { render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { AdminOperationsPage, OPERATIONS_HEALTH_PATH } from './admin-operations.js';

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const signedIn = (permissions = ['operations.read']): SessionView => ({
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

const status = (overrides: Partial<{ domain: string; state: string; action: string }> = {}) => ({
  domain: 'queue',
  state: 'ok',
  action: 'Nothing to do.',
  findings: [],
  ...overrides,
});

const healthReply = (statuses: readonly unknown[], overrides: Partial<{ at: string; state: string; action: string }> = {}) =>
  reply(200, successEnvelope({
    health: { at: '2026-09-24T00:00:00.000Z', state: 'ok', action: 'All domains are fine.', statuses, ...overrides },
  }, 'request-health'));

describe('AdminOperationsPage', () => {
  beforeEach(() => {
    resetAppState();
    session.value = signedIn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders each status as a row with its domain label, state and action', async () => {
    setFetching(async () => healthReply([
      status({ domain: 'queue', state: 'ok', action: 'Nothing to do.' }),
      status({ domain: 'backup', state: 'degraded', action: 'Run a backup soon.' }),
    ]));
    render(<AdminOperationsPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Operations' })).toBeTruthy();
    expect(await screen.findByText('Queue')).toBeTruthy();
    expect(screen.getByText('Backup')).toBeTruthy();
    expect(screen.getByText('Nothing to do.')).toBeTruthy();
    expect(screen.getByText('Run a backup soon.')).toBeTruthy();
    expect(screen.getByText('Degraded')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders with no alert and no rows when the report has no statuses', async () => {
    setFetching(async () => healthReply([]));
    render(<AdminOperationsPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Operations' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it('labels the process and worker-health domains by their scope, never as "host"', async () => {
    setFetching(async () => healthReply([
      status({ domain: 'process', state: 'ok', action: 'Nothing to do.' }),
      status({ domain: 'health', state: 'ok', action: 'Nothing to do.' }),
    ]));
    render(<AdminOperationsPage />);

    expect(await screen.findByText('App process')).toBeTruthy();
    expect(screen.getByText('Worker health')).toBeTruthy();
    expect(screen.queryByText(/host/i)).toBeNull();
  });

  it('drops a status row the server sent with an unrecognized domain, keeping the rest', async () => {
    setFetching(async () => healthReply([
      { domain: 'not-a-real-domain', state: 'ok', action: 'ignored' },
      status({ domain: 'queue', state: 'ok', action: 'Nothing to do.' }),
    ]));
    render(<AdminOperationsPage />);

    expect(await screen.findByText('Queue')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('treats a report with no statuses array as a load failure', async () => {
    setFetching(async () => reply(200, successEnvelope({ health: { at: '2026-09-24T00:00:00.000Z', state: 'ok', action: 'x' } }, 'request-health')));
    render(<AdminOperationsPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The operations health report could not be loaded.');
  });

  it('shows a load failure as an alert', async () => {
    setFetching(async () => reply(500, errorEnvelope('server.failed', 'Failed', 'request-health')));
    render(<AdminOperationsPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The operations health report could not be loaded.');
  });

  it('re-fetches on manual refresh', async () => {
    const fetching = vi.fn<FetchLike>(async () => healthReply([status({ domain: 'queue', state: 'ok' })]));
    setFetching(fetching);
    render(<AdminOperationsPage />);
    await screen.findByText('Queue');

    fetching.mockClear();
    fetching.mockResolvedValueOnce(healthReply([status({ domain: 'queue', state: 'degraded', action: 'Look at the queue.' })]));
    screen.getByRole('button', { name: 'Refresh' }).click();

    await waitFor(() => expect(screen.getByText('Look at the queue.')).toBeTruthy());
    expect(fetching).toHaveBeenCalledTimes(1);
    expect(fetching.mock.calls[0]?.[0]).toBe(OPERATIONS_HEALTH_PATH);
  });

  it('recovers from a failed refresh back to an alert once loaded data existed', async () => {
    const fetching = vi.fn<FetchLike>(async () => healthReply([status({ domain: 'queue', state: 'ok' })]));
    setFetching(fetching);
    render(<AdminOperationsPage />);
    await screen.findByText('Queue');

    fetching.mockResolvedValueOnce(reply(500, errorEnvelope('server.failed', 'Failed', 'request-health')));
    screen.getByRole('button', { name: 'Refresh' }).click();

    expect((await screen.findByRole('alert')).textContent).toBe('The operations health report could not be loaded.');
  });

  it('renders not found and makes no request without operations.read permission', () => {
    const fetching = vi.fn<FetchLike>();
    setFetching(fetching);
    session.value = signedIn([]);
    render(<AdminOperationsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(fetching).not.toHaveBeenCalled();
  });
});
