// @vitest-environment happy-dom
// The recorded backups an administrator watches and can trigger on demand (spec v1c-14, OUI-03, T5): the
// list and "Back up now" half only — the restore wizard is T6, deliberately out of scope. One permission,
// `backup.manage`, gates both the list and the action, matching `backup-routes.ts`'s own single-permission
// split (unlike Jobs, there is no separate viewing permission here). "Last rehearsal" has no column and
// "Rehearse" has no button — D-PLAN-3, no server route exists to read or trigger either.

import { render, screen, waitFor, fireEvent } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { App } from '../app.js';
import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { currentPath } from '../router.js';
import { AdminBackupsPage, BACKUPS_PATH } from './admin-backups.js';

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

describe('AdminBackupsPage', () => {
  beforeEach(() => {
    resetAppState();
    session.value = signedIn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
});
