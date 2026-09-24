// @vitest-environment happy-dom
// A shell-only pass (T2): the route, its Administration entry and its permission gate exist and behave
// correctly. A later pass proves the backup list, "Back up now" and the restore wizard.

import { render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
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

describe('AdminBackupsPage', () => {
  beforeEach(() => {
    resetAppState();
    session.value = signedIn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders once the backups list has loaded', async () => {
    const fetching = vi.fn<FetchLike>(async () => reply(200, successEnvelope({ backups: [] }, 'request-backups')));
    setFetching(fetching);
    render(<AdminBackupsPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Backups' })).toBeTruthy();
    expect(fetching.mock.calls[0]?.[0]).toBe(BACKUPS_PATH);
    expect(screen.queryByRole('alert')).toBeNull();
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
});
