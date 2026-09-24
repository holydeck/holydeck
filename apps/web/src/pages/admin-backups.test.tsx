// @vitest-environment happy-dom
// The recorded backups an administrator watches and can trigger on demand (spec v1c-14, OUI-03): the list
// and "Back up now" half (T5), plus the restore wizard (T6). `backup.manage` gates the list and the backup
// action, matching `backup-routes.ts`'s own single-permission split (unlike Jobs, there is no separate
// viewing permission here). The restore wizard is gated apart, by `restore.manage`. "Last rehearsal" has no
// column and "Rehearse" has no button — D-PLAN-3, no server route exists to read or trigger either; the 409
// a restore submission gets back when nothing has rehearsed cleanly is this page's only view onto that.

import { render, screen, waitFor, fireEvent, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { App } from '../app.js';
import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { currentPath } from '../router.js';
import { JOBS_PATH } from './admin-jobs.js';
import { AdminBackupsPage, BACKUPS_PATH, RESTORES_PATH, RESTORE_POLL_MS } from './admin-backups.js';

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const signedIn = (permissions = ['backup.manage']): SessionView => ({
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

const content = (overrides: Partial<{ class: string; count: number; bytes: number; hash: string }> = {}) => ({
  class: 'audit-events',
  count: 10,
  bytes: 2048,
  hash: 'sha256:abc',
  ...overrides,
});

const backup = (overrides: Partial<{
  backupId: string;
  at: string;
  contents: readonly ReturnType<typeof content>[];
  snapshots: readonly string[];
}> = {}) => ({
  backupId: overrides.backupId ?? 'backup-1',
  at: overrides.at ?? '2026-09-20T02:00:00.000Z',
  production: {
    manifest: {
      id: overrides.backupId ?? 'backup-1',
      createdAt: overrides.at ?? '2026-09-20T02:00:00.000Z',
      schemaVersion: 1,
      contents: overrides.contents ?? [
        content(),
        content({ class: 'settings', bytes: 512, hash: 'restic:s1' }),
        content({ class: 'media', bytes: 4096, hash: 'restic:s2' }),
      ],
      excludedSecrets: ['secret-x'],
    },
    consistency: { pointInTime: true, method: 'a session read at one snapshot cluster time' },
  },
  snapshots: overrides.snapshots ?? ['s1', 's2'],
});

const backupsReply = (backups: readonly unknown[]) => reply(200, successEnvelope({ backups }, 'request-backups'));

const renderPage = async (): Promise<void> => {
  currentPath.value = '/admin/backups';
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Backups' });
};

/** Routes a mocked fetch by method, since list (GET) and back-up-now (POST) share one path. */
const byMethod = (routes: {
  list?: () => ReturnType<typeof reply>;
  create?: () => ReturnType<typeof reply>;
}): FetchLike => (async (_path: string, init?: { method?: string }) => {
  if (init?.method === 'POST') return routes.create?.() ?? reply(202, successEnvelope({ id: 'job-1', created: true }, 'request-backups'));
  return routes.list?.() ?? backupsReply([]);
}) as unknown as FetchLike;

const jobsReply = (jobs: readonly unknown[]) => reply(200, successEnvelope({ jobs }, 'request-jobs'));

/** Routes a mocked fetch across backups (GET/POST), restore submission and the restore-apply jobs poll. */
const byPath = (routes: {
  list?: () => ReturnType<typeof reply>;
  restore?: () => ReturnType<typeof reply>;
  jobs?: () => ReturnType<typeof reply>;
}): FetchLike => (async (path: string, init?: { method?: string }) => {
  if (path === RESTORES_PATH && init?.method === 'POST') {
    return routes.restore?.() ?? reply(202, successEnvelope({ id: 'restore-job-1', created: true }, 'request-restores'));
  }
  if (path.startsWith(JOBS_PATH)) return routes.jobs?.() ?? jobsReply([]);
  return routes.list?.() ?? backupsReply([]);
}) as unknown as FetchLike;

describe('AdminBackupsPage', () => {
  beforeEach(() => {
    resetAppState();
    session.value = signedIn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders backups from the server, with status, components and size', async () => {
    setFetching(byMethod({ list: () => backupsReply([backup({ backupId: 'backup-1' })]) }));
    await renderPage();

    expect(await screen.findByText('backup-1')).toBeTruthy();
    expect(screen.getByText('2026-09-20T02:00:00.000Z')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText('Database, Settings, Media')).toBeTruthy();
    expect(screen.getByText('6.5 KB')).toBeTruthy();
  });

  it('drops a malformed backup row rather than rendering it', async () => {
    setFetching(byMethod({ list: () => backupsReply([{ backupId: 'bad' }, backup({ backupId: 'backup-1' })]) }));
    await renderPage();

    expect(await screen.findByText('backup-1')).toBeTruthy();
    expect(screen.queryByText('bad')).toBeNull();
  });

  it('shows an empty state when no backups have been recorded', async () => {
    setFetching(byMethod({ list: () => backupsReply([]) }));
    await renderPage();

    expect(await screen.findByText('No backups have been recorded yet.')).toBeTruthy();
  });

  it('shows a load failure as an alert', async () => {
    setFetching(async () => reply(500, errorEnvelope('server.failed', 'Failed', 'request-backups')));
    render(<AdminBackupsPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The backups list could not be loaded.');
  });

  it('renders not found and makes no request without backup.manage permission', () => {
    const fetching = vi.fn<FetchLike>();
    setFetching(fetching);
    session.value = signedIn([]);
    render(<AdminBackupsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(fetching).not.toHaveBeenCalled();
  });

  it('offers a Back up now form with all three components checked by default', async () => {
    setFetching(byMethod({}));
    await renderPage();

    expect(await screen.findByLabelText('Database')).toHaveProperty('checked', true);
    expect(screen.getByLabelText('Settings')).toHaveProperty('checked', true);
    expect(screen.getByLabelText('Media')).toHaveProperty('checked', true);
  });

  it('starts a backup with only the checked components, then re-fetches the list', async () => {
    const fetching = vi.fn<FetchLike>(byMethod({ list: () => backupsReply([]) }));
    setFetching(fetching);
    await renderPage();
    await screen.findByLabelText('Media');
    const before = fetching.mock.calls.length;

    fireEvent.click(screen.getByLabelText('Media'));
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));

    await waitFor(() => expect(fetching.mock.calls.length).toBeGreaterThan(before));
    const posted = fetching.mock.calls.find(([path, init]) => path === BACKUPS_PATH && (init as { method?: string }).method === 'POST');
    expect(posted).toBeDefined();
    expect(JSON.parse((posted?.[1] as { body: string }).body)).toEqual({ components: ['mongo', 'settings'] });
    await waitFor(() => expect(fetching.mock.calls.filter(([path]) => path === BACKUPS_PATH).length).toBeGreaterThan(1));
  });

  it('renders the server’s own refusal message on a 409, not a generic one', async () => {
    setFetching(byMethod({
      list: () => backupsReply([]),
      create: () => reply(409, errorEnvelope('entity.conflict', 'a backup is already running', 'request-backups')),
    }));
    await renderPage();
    await screen.findByLabelText('Media');

    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));

    expect((await screen.findByRole('alert')).textContent).toBe('a backup is already running');
  });

  it('hides the restore wizard without restore.manage', async () => {
    setFetching(byPath({ list: () => backupsReply([backup({ backupId: 'backup-1' })]) }));
    await renderPage();
    await screen.findByText('backup-1');

    expect(screen.queryByRole('region', { name: 'Restore a backup' })).toBeNull();
  });

  it('disables the restore submit button until the typed id matches the selected backup', async () => {
    session.value = signedIn(['backup.manage', 'restore.manage']);
    setFetching(byPath({ list: () => backupsReply([backup({ backupId: 'backup-1' })]) }));
    await renderPage();
    const region = await screen.findByRole('region', { name: 'Restore a backup' });
    const submit = within(region).getByRole('button', { name: 'Start restore' });
    expect(submit).toHaveProperty('disabled', true);

    fireEvent.click(within(region).getByLabelText('backup-1'));
    expect(submit).toHaveProperty('disabled', true);

    fireEvent.input(within(region).getByLabelText('Type the backup ID to confirm'), { target: { value: 'backup-' } });
    expect(submit).toHaveProperty('disabled', true);

    fireEvent.input(within(region).getByLabelText('Type the backup ID to confirm'), { target: { value: 'backup-1' } });
    expect(submit).toHaveProperty('disabled', false);
  });

  it('starts a restore with the selected backup and components, then polls the job to success', async () => {
    session.value = signedIn(['backup.manage', 'restore.manage']);
    let jobState: 'leased' | 'succeeded' = 'leased';
    const fetching = vi.fn<FetchLike>(byPath({
      list: () => backupsReply([backup({ backupId: 'backup-1' })]),
      jobs: () => jobsReply([{ id: 'restore-job-1', state: jobState }]),
    }));
    setFetching(fetching);
    await renderPage();
    const region = await screen.findByRole('region', { name: 'Restore a backup' });

    fireEvent.click(within(region).getByLabelText('backup-1'));
    fireEvent.input(within(region).getByLabelText('Type the backup ID to confirm'), { target: { value: 'backup-1' } });
    fireEvent.input(within(region).getByLabelText('Password'), { target: { value: 'right password' } });

    vi.useFakeTimers();
    fireEvent.click(within(region).getByRole('button', { name: 'Start restore' }));
    await vi.advanceTimersByTimeAsync(0);

    const posted = fetching.mock.calls.find(([path]) => path === RESTORES_PATH);
    expect(posted).toBeDefined();
    expect(JSON.parse((posted?.[1] as { body: string }).body)).toEqual({
      backupId: 'backup-1',
      confirm: 'backup-1',
      components: ['mongo', 'settings', 'media'],
      password: 'right password',
    });
    expect(within(region).getByText('Restore in progress…')).toBeTruthy();

    jobState = 'succeeded';
    await vi.advanceTimersByTimeAsync(RESTORE_POLL_MS);
    expect(within(region).getByText('Restore complete.')).toBeTruthy();
  });

  it('shows the failed job state and offers to start over, not Requeue', async () => {
    session.value = signedIn(['backup.manage', 'restore.manage']);
    let jobState: 'leased' | 'failed' = 'leased';
    setFetching(byPath({
      list: () => backupsReply([backup({ backupId: 'backup-1' })]),
      jobs: () => jobsReply([{ id: 'restore-job-1', state: jobState }]),
    }));
    await renderPage();
    const region = await screen.findByRole('region', { name: 'Restore a backup' });

    fireEvent.click(within(region).getByLabelText('backup-1'));
    fireEvent.input(within(region).getByLabelText('Type the backup ID to confirm'), { target: { value: 'backup-1' } });
    fireEvent.input(within(region).getByLabelText('Password'), { target: { value: 'right password' } });

    vi.useFakeTimers();
    fireEvent.click(within(region).getByRole('button', { name: 'Start restore' }));
    await vi.advanceTimersByTimeAsync(0);

    jobState = 'failed';
    await vi.advanceTimersByTimeAsync(RESTORE_POLL_MS);

    expect(within(region).getByRole('alert').textContent).toBe(
      'Restore failed. A failed restore is not requeued — start over to try again.',
    );
    expect(within(region).getByRole('button', { name: 'Start over' })).toBeTruthy();
  });

  it('shows a distinct no-passing-rehearsal state on a 409, not folded into a generic error', async () => {
    session.value = signedIn(['backup.manage', 'restore.manage']);
    setFetching(byPath({
      list: () => backupsReply([backup({ backupId: 'backup-1' })]),
      restore: () => reply(409, errorEnvelope('entity.state_conflict', 'this backup has no passing rehearsal in the last 24 hours', 'request-restores')),
    }));
    await renderPage();
    const region = await screen.findByRole('region', { name: 'Restore a backup' });

    fireEvent.click(within(region).getByLabelText('backup-1'));
    fireEvent.input(within(region).getByLabelText('Type the backup ID to confirm'), { target: { value: 'backup-1' } });
    fireEvent.input(within(region).getByLabelText('Password'), { target: { value: 'right password' } });
    fireEvent.click(within(region).getByRole('button', { name: 'Start restore' }));

    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toBe('No passing rehearsal this backup has no passing rehearsal in the last 24 hours');
    expect(within(alert).getByText('No passing rehearsal').tagName).toBe('STRONG');
  });

  it('re-prompts for the password on a 401 instead of failing hard', async () => {
    session.value = signedIn(['backup.manage', 'restore.manage']);
    setFetching(byPath({
      list: () => backupsReply([backup({ backupId: 'backup-1' })]),
      restore: () => reply(401, errorEnvelope('auth.sign_in_refused', 'Confirm your password and try again in a few minutes.', 'request-restores')),
    }));
    await renderPage();
    const region = await screen.findByRole('region', { name: 'Restore a backup' });

    fireEvent.click(within(region).getByLabelText('backup-1'));
    fireEvent.input(within(region).getByLabelText('Type the backup ID to confirm'), { target: { value: 'backup-1' } });
    fireEvent.input(within(region).getByLabelText('Password'), { target: { value: 'wrong password' } });
    fireEvent.click(within(region).getByRole('button', { name: 'Start restore' }));

    expect(await within(region).findByText('That password was not accepted.')).toBeTruthy();
    expect(within(region).getByLabelText('Password')).toHaveProperty('value', '');
    expect(within(region).getByRole('button', { name: 'Start restore' })).toBeTruthy();
  });
});
