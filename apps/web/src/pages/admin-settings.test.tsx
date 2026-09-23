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

const sources = { port: 'file', locale: 'default', anthropicApiKey: 'env', dataDir: 'env' };

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
    expect(screen.getAllByText('Environment').length).toBeGreaterThan(0);
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
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'America/New_York' } });
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

    fireEvent.input(screen.getByLabelText('Corpus access token'), { target: { value: 'corpus-secret' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save changes' }).closest('form') as HTMLFormElement);

    await waitFor(() => expect(fetching).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetching.mock.calls[1]?.[1].body ?? '{}')).toEqual({ corpusToken: 'corpus-secret' });
  });

  it('shows a refusal that names a setting beside that field, and announces it', async () => {
    setFetching(async (_path, init) => init.method === 'PATCH'
      ? reply(422, errorEnvelope('request.validation_failed', 'Refused', 'request-save', [
        { path: 'settings.port', code: 'field.not_allowed', message: 'port: must be between 1 and 65535' },
      ]))
      : settingsReply());
    await renderPage();

    fireEvent.input(screen.getByLabelText('Port'), { target: { value: '9443' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save changes' }).closest('form') as HTMLFormElement);

    expect((await screen.findByRole('alert')).textContent).toBe('Some settings were refused. Each one says why beside it.');
    expect(document.getElementById('announce-assertive')?.textContent).toBe('Some settings were refused. Each one says why beside it.');
    expect(screen.getByLabelText('Port').getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById('settings-port-error')?.textContent).toBe('port: must be between 1 and 65535');
  });

  it('shows a refusal that names no one setting as an alert for the whole form', async () => {
    setFetching(async (_path, init) => init.method === 'PATCH'
      ? reply(422, errorEnvelope('request.validation_failed', 'Refused', 'request-save', [
        { path: 'settings', code: 'field.not_allowed', message: 'tlsCertFile and tlsKeyFile: set both or neither' },
      ]))
      : settingsReply());
    await renderPage();

    fireEvent.input(screen.getByLabelText('TLS certificate file'), { target: { value: '/etc/tls.crt' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save changes' }).closest('form') as HTMLFormElement);

    expect((await screen.findByRole('alert')).textContent).toBe('The change was refused: tlsCertFile and tlsKeyFile: set both or neither');
  });

  it('groups the fields under General, Time zone, Security, Retention and Integrations', async () => {
    setFetching(async () => settingsReply());
    await renderPage();

    const form = screen.getByRole('button', { name: 'Save changes' }).closest('form') as HTMLFormElement;
    expect([...form.querySelectorAll('fieldset > legend')].map((legend) => legend.textContent)).toEqual([
      'General', 'Time zone', 'Security', 'Retention', 'Integrations',
    ]);
  });

  it('offers the time zone as a list of IANA names, keeping the current one', async () => {
    const fetching = vi.fn<FetchLike>(async (_path, init) => init.method === 'PATCH' ? reply(200, successEnvelope({ values, sources }, 'request-save')) : settingsReply());
    setFetching(fetching);
    await renderPage();

    const zone = screen.getByLabelText('Time zone') as HTMLSelectElement;
    expect(zone.tagName).toBe('SELECT');
    expect(zone.value).toBe('UTC');
    expect([...zone.options].map((option) => option.value)).toContain('Europe/Zurich');
    fireEvent.change(zone, { target: { value: 'Europe/Zurich' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save changes' }).closest('form') as HTMLFormElement);

    await waitFor(() => expect(fetching).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetching.mock.calls[1]?.[1].body ?? '{}')).toEqual({ timezone: 'Europe/Zurich' });
  });

  it('keeps a field the environment sets read-only, and says where to change it', async () => {
    setFetching(async () => settingsReply());
    await renderPage();

    const dataDir = screen.getByLabelText('Data directory') as HTMLInputElement;
    expect(dataDir.disabled).toBe(true);
    expect(document.getElementById('settings-dataDir-hint')?.textContent).toBe(
      'Set by this deployment’s environment. Change it there.',
    );
    expect((screen.getByLabelText('Anthropic API key') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Port') as HTMLInputElement).disabled).toBe(false);
  });

  it('treats the database URL as a secret, never echoing its redacted value back', async () => {
    const fetching = vi.fn<FetchLike>(async (_path, init) => init.method === 'PATCH' ? reply(200, successEnvelope({ values, sources }, 'request-save')) : settingsReply());
    setFetching(fetching);
    await renderPage();

    const mongo = screen.getByLabelText('Database URL') as HTMLInputElement;
    expect(mongo.type).toBe('password');
    expect(mongo.value).toBe('');
    fireEvent.input(screen.getByLabelText('Port'), { target: { value: '9443' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save changes' }).closest('form') as HTMLFormElement);

    await waitFor(() => expect(fetching).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetching.mock.calls[1]?.[1].body ?? '{}')).toEqual({ port: 9443 });
  });

  it('keeps a secret typed into and then cleared again, rather than wiping it', async () => {
    setFetching(async () => settingsReply());
    await renderPage();

    const token = screen.getByLabelText('Corpus access token');
    fireEvent.input(token, { target: { value: 'typed' } });
    fireEvent.input(token, { target: { value: '' } });

    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses an empty or fractional number beside the field, sending nothing', async () => {
    const fetching = vi.fn<FetchLike>(async () => settingsReply());
    setFetching(fetching);
    await renderPage();

    fireEvent.input(screen.getByLabelText('Port'), { target: { value: '' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save changes' }).closest('form') as HTMLFormElement);

    await waitFor(() => expect(document.getElementById('settings-port-error')?.textContent).toBe('Enter a whole number.'));
    fireEvent.input(screen.getByLabelText('Audit log retention (days)'), { target: { value: '1.5' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save changes' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(document.getElementById('settings-auditRetentionDays-error')?.textContent).toBe('Enter a whole number.'));
    expect(fetching).toHaveBeenCalledTimes(1);
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
