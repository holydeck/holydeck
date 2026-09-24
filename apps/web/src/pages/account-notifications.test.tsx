// @vitest-environment happy-dom
// What one account hears about, and how (spec v1c-14, OUI-04). Only the preferences form: the bell and
// panel are T7, out of scope here.

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { AccountNotificationsPage, NOTIFICATION_PREFERENCES_PATH } from './account-notifications.js';

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const signedIn = (): SessionView => ({
  account: { id: 'a1', name: 'andru', displayName: 'Andru Example', role: 'operator', controlPresentation: false },
  actor: 'account:a1',
  permissions: ['notifications.use'],
  startedAt: '2026-09-13T09:30:00.000Z',
  lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z',
  rotation: 'authentication',
  csrf: 'c'.repeat(43),
  slots: [],
} as unknown as SessionView);

const preferencesReply = (overrides: Partial<{ muted: boolean; ownActions: boolean; channels: readonly unknown[] }> = {}) =>
  reply(200, successEnvelope({
    preferences: {
      muted: false,
      ownActions: true,
      channels: [{ channel: 'inApp', categories: ['content', 'presentation'], minimumSeverity: 'notice' }],
      ...overrides,
    },
  }, 'request-preferences'));

const withLiveRegions = (): ReturnType<typeof render> =>
  render(
    <>
      <p id="announce-polite" aria-live="polite"></p>
      <p id="announce-assertive" aria-live="assertive"></p>
      <AccountNotificationsPage />
    </>,
  );

describe('AccountNotificationsPage', () => {
  beforeEach(() => {
    resetAppState();
    session.value = signedIn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads current preferences from GET', async () => {
    setFetching(async () => preferencesReply());
    render(<AccountNotificationsPage />);

    expect(await screen.findByRole('heading', { level: 1, name: 'Notifications' })).toBeTruthy();
    const inAppEnable = await screen.findByRole('checkbox', { name: 'Send notifications by In-app' });
    expect((inAppEnable as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Send notifications by Email' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Content' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Authentication' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Notify me about my own actions' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('saves via PUT and shows a success/announce state', async () => {
    const fetching = vi.fn<FetchLike>(async (path) => {
      if (path === NOTIFICATION_PREFERENCES_PATH) return preferencesReply();
      return reply(404, errorEnvelope('not_found', 'nope', 'request-x'));
    });
    setFetching(fetching);
    withLiveRegions();
    await screen.findByRole('checkbox', { name: 'Send notifications by In-app' });

    fetching.mockImplementation(async (path, init) => {
      if (path === NOTIFICATION_PREFERENCES_PATH && init.method === 'PUT') {
        return reply(200, successEnvelope({ saved: true }, 'request-save'));
      }
      return preferencesReply();
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mute all notifications' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Notify me about my own actions' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Content' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Minimum severity' }), { target: { value: 'critical' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Send notifications by Email' }));
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form') as HTMLFormElement);

    await waitFor(() => expect(document.getElementById('announce-polite')?.textContent).toBe('Notification preferences saved.'));
    const putCall = fetching.mock.calls.find(([, init]) => init.method === 'PUT');
    expect(putCall).toBeTruthy();
    const body = JSON.parse((putCall?.[1].body as string) ?? '{}') as {
      muted: boolean;
      ownActions: boolean;
      channels: readonly { channel: string; categories: readonly string[]; minimumSeverity: string }[];
    };
    expect(body.muted).toBe(true);
    expect(body.ownActions).toBe(false);
    expect(body.channels.map((c) => c.channel).sort()).toEqual(['email', 'inApp']);
    const inApp = body.channels.find((c) => c.channel === 'inApp');
    expect(inApp?.categories).toEqual(['presentation']);
    expect(inApp?.minimumSeverity).toBe('critical');
  });

  it('renders a 422 validation refusal per-field', async () => {
    const fetching = vi.fn<FetchLike>(async (path, init) => {
      if (path === NOTIFICATION_PREFERENCES_PATH && init.method === 'PUT') {
        return reply(422, validationFailure('request-save', [
          { path: 'notification-preferences.channels.0.categories.1', code: 'not_allowed', message: 'presentation is selected more than once' },
        ]));
      }
      return preferencesReply();
    });
    setFetching(fetching);
    render(<AccountNotificationsPage />);
    await screen.findByRole('checkbox', { name: 'Send notifications by In-app' });

    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form') as HTMLFormElement);

    await waitFor(() => expect(screen.getByText('Channel In-app: presentation is selected more than once')).toBeTruthy());
  });

  it('shows a general refusal for a validation problem that names no channel', async () => {
    const fetching = vi.fn<FetchLike>(async (path, init) => {
      if (path === NOTIFICATION_PREFERENCES_PATH && init.method === 'PUT') {
        return reply(422, validationFailure('request-save', [
          { path: 'notification-preferences.muted', code: 'not_a_boolean', message: 'must be true or false' },
        ]));
      }
      return preferencesReply();
    });
    setFetching(fetching);
    render(<AccountNotificationsPage />);
    await screen.findByRole('checkbox', { name: 'Send notifications by In-app' });

    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form') as HTMLFormElement);

    expect((await screen.findByText('The change was refused: must be true or false')).getAttribute('role')).toBe('alert');
  });

  it('shows a load failure as an alert', async () => {
    setFetching(async () => reply(500, errorEnvelope('server.failed', 'Failed', 'request-preferences')));
    render(<AccountNotificationsPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The notification preferences could not be loaded.');
  });

  it('treats a malformed preferences shape as a load failure', async () => {
    setFetching(async () => preferencesReply({ channels: [{ channel: 'not-a-channel', categories: [], minimumSeverity: 'notice' }] }));
    render(<AccountNotificationsPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The notification preferences could not be loaded.');
  });

  it('treats a non-array channels list as a load failure', async () => {
    setFetching(async () => preferencesReply({ channels: 'not-an-array' as unknown as readonly unknown[] }));
    render(<AccountNotificationsPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The notification preferences could not be loaded.');
  });

  it('treats an unrecognized category within a channel as a load failure', async () => {
    setFetching(async () => preferencesReply({
      channels: [{ channel: 'inApp', categories: ['not-a-category'], minimumSeverity: 'notice' }],
    }));
    render(<AccountNotificationsPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The notification preferences could not be loaded.');
  });

  it('treats a response with no preferences object as a load failure', async () => {
    setFetching(async () => reply(200, successEnvelope({}, 'request-preferences')));
    render(<AccountNotificationsPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The notification preferences could not be loaded.');
  });

  it('treats a non-boolean muted flag as a load failure', async () => {
    setFetching(async () => preferencesReply({ muted: 'nope' as unknown as boolean }));
    render(<AccountNotificationsPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The notification preferences could not be loaded.');
  });

  it('adds a category to an enabled channel when its checkbox is checked', async () => {
    const fetching = vi.fn<FetchLike>(async (path, init) => {
      if (path === NOTIFICATION_PREFERENCES_PATH && init?.method === 'PUT') {
        return reply(200, successEnvelope({ saved: true }, 'request-save'));
      }
      return preferencesReply();
    });
    setFetching(fetching);
    render(<AccountNotificationsPage />);
    await screen.findByRole('checkbox', { name: 'Send notifications by In-app' });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Authentication' }));
    fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form') as HTMLFormElement);

    await waitFor(() => expect(fetching.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const putCall = fetching.mock.calls.find(([, init]) => init?.method === 'PUT');
    const body = JSON.parse((putCall?.[1].body as string) ?? '{}') as {
      channels: readonly { channel: string; categories: readonly string[] }[];
    };
    const inApp = body.channels.find((c) => c.channel === 'inApp');
    expect([...(inApp?.categories ?? [])].sort()).toEqual(['authentication', 'content', 'presentation']);
  });

  it('renders not found and makes no request without a session', () => {
    const fetching = vi.fn<FetchLike>();
    setFetching(fetching);
    session.value = null;
    render(<AccountNotificationsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(fetching).not.toHaveBeenCalled();
  });
});
