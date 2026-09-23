// @vitest-environment happy-dom
// The settings screen is a small administration boundary: these tests keep its fields, source badges and
// changing requests tied to the settings contract rather than to an implementation detail of the form.

import { render, screen, waitFor, fireEvent } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { CSRF_HEADER, type SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { App } from '../app.js';
import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { currentPath } from '../router.js';
import { AdminSettingsPage, SETTINGS_PATH } from './admin-settings.js';

const csrf = 'c'.repeat(43);

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const signedIn = (permissions = ['settings.manage']): SessionView => ({
  account: { id: 'a1', name: 'andru', displayName: 'Andru Example', role: 'admin', controlPresentation: false },
  actor: 'account:a1',
  permissions,
  startedAt: '2026-09-13T09:30:00.000Z',
  lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z',
  rotation: 'authentication',
  csrf,
  slots: [],
} as unknown as SessionView);

const values = {
  port: 8443,
  dataDir: '/var/lib/holydeck',
  mediaRoot: '/var/lib/holydeck/media',
  resticRepository: '/backups/holydeck',
  resticPassword: '[redacted]',
  locale: 'en',
  corpusUrl: 'https://corpus.example',
  corpusToken: '[redacted]',
  tlsCertFile: '/etc/holydeck/tls.crt',
  tlsKeyFile: '/etc/holydeck/tls.key',
  mongoUrl: 'mongodb://127.0.0.1:27017/holydeck',
  timezone: 'UTC',
  developmentDiagnostics: false,
  auditRetentionDays: 90,
  autosaveRetentionDays: 30,
  sermonAiEnabled: false,
  anthropicApiKey: '',
};

const sources = { port: 'file', locale: 'default', anthropicApiKey: 'env' };

const settingsReply = (extra: { readonly lastReloadError?: string } = {}): ReturnType<typeof reply> =>
  reply(200, successEnvelope({ values, sources, ...extra }, 'request-settings'));

const renderPage = async (): Promise<void> => {
  currentPath.value = '/admin/settings';
  render(<App />);
  await screen.findByLabelText('Port');
};

describe('AdminSettingsPage', () => {
  beforeEach(() => {
    resetAppState();
    session.value = signedIn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders every known field with its current value and source', async () => {
    setFetching(async () => settingsReply());
    await renderPage();

    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('8443');
    expect((screen.getByLabelText('Time zone') as HTMLInputElement).value).toBe('UTC');
    expect((screen.getByLabelText('Development diagnostics') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Development diagnostics') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Settings file')).toBeTruthy();
    expect(screen.getByText('Environment')).toBeTruthy();
    expect(screen.getByText('Default')).toBeTruthy();
  });

  it('never shows a secret field its stored value, however it is sourced', async () => {
    setFetching(async () => settingsReply());
    await renderPage();

    expect((screen.getByLabelText('Backup repository password') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Corpus access token') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Corpus access token') as HTMLInputElement).type).toBe('password');
  });

  it('shows the last reload error when the server names one', async () => {
    setFetching(async () => settingsReply({ lastReloadError: 'the settings file is malformed' }));
    await renderPage();

    expect(await screen.findByText('The last reload failed: the settings file is malformed')).toBeTruthy();
  });

  it('shows a load refusal as an alert', async () => {
    setFetching(async () => reply(500, errorEnvelope('server.failed', 'Failed', 'request-settings')));
    render(<AdminSettingsPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The settings could not be loaded.');
  });

  it('PATCHes only the touched fields with CSRF, refreshes, and announces the save', async () => {
    const fetching = vi.fn<FetchLike>(async (_path, init) => init.method === 'PATCH' ? reply(200, successEnvelope({ values, sources }, 'request-save')) : settingsReply());
    setFetching(fetching);
    await renderPage();

    fireEvent.input(screen.getByLabelText('Port'), { target: { value: '9443' } });
    fireEvent.input(screen.getByLabelText('Time zone'), { target: { value: 'America/New_York' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save changes' }).closest('form') as HTMLFormElement);

    await waitFor(() => expect(document.getElementById('announce-polite')?.textContent).toBe('Settings saved.'));
    expect(fetching.mock.calls.map(([path, init]) => [path, init.method ?? 'GET'])).toEqual([
      [SETTINGS_PATH, 'GET'],
      [SETTINGS_PATH, 'PATCH'],
    ]);
    expect(fetching.mock.calls[1]?.[1].headers[CSRF_HEADER]).toBe(csrf);
    expect(JSON.parse(fetching.mock.calls[1]?.[1].body ?? '{}')).toEqual({ port: 9443, timezone: 'America/New_York' });
  });

  it('sends a secret only once it has been typed into', async () => {
    const fetching = vi.fn<FetchLike>(async (_path, init) => init.method === 'PATCH' ? reply(200, successEnvelope({ values, sources }, 'request-save')) : settingsReply());
    setFetching(fetching);
    await renderPage();

    fireEvent.input(screen.getByLabelText('Anthropic API key'), { target: { value: 'sk-example' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save changes' }).closest('form') as HTMLFormElement);

    await waitFor(() => expect(fetching).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetching.mock.calls[1]?.[1].body ?? '{}')).toEqual({ anthropicApiKey: 'sk-example' });
  });

  it('shows and announces a refused change', async () => {
    setFetching(async (_path, init) => init.method === 'PATCH'
      ? reply(422, errorEnvelope('request.validation_failed', 'Refused', 'request-save', [
        { path: 'settings.developmentDiagnostics', code: 'field.not_allowed', message: 'That setting is environment-only.' },
      ]))
      : settingsReply());
    await renderPage();

    fireEvent.input(screen.getByLabelText('Port'), { target: { value: '9443' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save changes' }).closest('form') as HTMLFormElement);

    expect((await screen.findByRole('alert')).textContent).toBe('The change was refused: That setting is environment-only.');
    expect(document.getElementById('announce-assertive')?.textContent).toBe('The change was refused: That setting is environment-only.');
  });

  it('renders not found and makes no request without settings administration permission', () => {
    const fetching = vi.fn<FetchLike>();
    setFetching(fetching);
    session.value = signedIn([]);
    render(<AdminSettingsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(fetching).not.toHaveBeenCalled();
  });
});
