// @vitest-environment happy-dom
// The integrations screen shows one switch per third-party integration and nothing else: the server owns
// configuration and clamps an enable request when nothing is configured to call (integration-routes.ts).
// These tests keep the page tied to that real contract rather than to an implementation detail of the table.

import { render, screen, waitFor, fireEvent } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { App } from '../app.js';
import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { currentPath } from '../router.js';
import { INTEGRATIONS_PATH, AdminIntegrationsPage } from './admin-integrations.js';

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const signedIn = (permissions = ['integrations.manage']): SessionView => ({
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

const integration = (overrides: Partial<{
  id: string; configured: boolean; enabled: boolean; lastCallAt: string | null; callsInLast30Days: number;
  lockedByEnvironment: boolean;
}> = {}) => ({
  id: 'sermon-ai', configured: true, enabled: false, lastCallAt: null, callsInLast30Days: 0, ...overrides,
});

const listReply = (entries: readonly unknown[]) => reply(200, successEnvelope(entries, 'request-integrations'));

const renderPage = async (): Promise<void> => {
  currentPath.value = '/admin/integrations';
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Integrations' });
};

describe('AdminIntegrationsPage', () => {
  beforeEach(() => { resetAppState(); session.value = signedIn(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders the integrations the server answers with', async () => {
    setFetching(async () => listReply([integration({ callsInLast30Days: 3, lastCallAt: '2026-09-20T00:00:00.000Z' })]));
    await renderPage();

    expect(await screen.findByText('Sermon AI import')).toBeTruthy();
    expect(screen.getByText('Configured')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('2026-09-20T00:00:00.000Z')).toBeTruthy();
  });

  it('shows a hint and disables enabling an unconfigured integration', async () => {
    setFetching(async () => listReply([integration({ configured: false })]));
    await renderPage();

    expect(await screen.findByText('Add an API key in Settings to enable this integration.')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Enable Sermon AI import' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('holds the switch still, and says why, when the deployment environment sets it', async () => {
    setFetching(async () => listReply([integration({ enabled: true, lockedByEnvironment: true })]));
    await renderPage();

    expect(await screen.findByText('The deployment environment sets this switch, so it cannot be changed here.')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Disable Sermon AI import' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('enables an integration with a fresh PATCH and reloads', async () => {
    const fetching = vi.fn<FetchLike>();
    fetching.mockResolvedValueOnce(listReply([integration()]));
    fetching.mockResolvedValueOnce(reply(200, successEnvelope(integration({ enabled: true }), 'request-patch')));
    fetching.mockResolvedValueOnce(listReply([integration({ enabled: true })]));
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Enable Sermon AI import' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disable Sermon AI import' })).toBeTruthy());

    const [, patchCall] = fetching.mock.calls;
    expect(patchCall?.[0]).toBe(`${INTEGRATIONS_PATH}/sermon-ai`);
    expect(patchCall?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(patchCall?.[1]?.body ?? '{}')).toEqual({ enabled: true });
  });

  it('announces a refusal and keeps the prior state', async () => {
    const fetching = vi.fn<FetchLike>();
    fetching.mockResolvedValueOnce(listReply([integration({ enabled: true })]));
    fetching.mockResolvedValueOnce(reply(422, errorEnvelope('request.validation_failed', 'Refused', 'request-patch', [
      { path: 'body.enabled', code: 'field.not_allowed', message: 'Sermon AI import is unavailable.' },
    ])));
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Disable Sermon AI import' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The change was refused: Sermon AI import is unavailable.');
  });

  it('shows a load failure as an alert', async () => {
    setFetching(async () => reply(500, errorEnvelope('server.failed', 'Failed', 'request-integrations')));
    render(<AdminIntegrationsPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The integrations list could not be loaded.');
  });

  it('renders not found and makes no request without integrations.manage permission', () => {
    const fetching = vi.fn<FetchLike>();
    setFetching(fetching);
    session.value = signedIn([]);
    render(<AdminIntegrationsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(fetching).not.toHaveBeenCalled();
  });
});
