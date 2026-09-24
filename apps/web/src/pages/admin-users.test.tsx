// @vitest-environment happy-dom
// The account screen is a small administration boundary: these tests keep its rows, guarded choices and
// changing requests tied to the account contract rather than to an implementation detail of the table.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCOUNTS_PATH, type AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { CSRF_HEADER, type SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { App } from '../app.js';
import { resetAppState, session } from '../app-state.js';
import { DRAFT_PREFIX } from '../drafts.js';
import { setFetching } from '../request.js';
import { currentPath } from '../router.js';
import { AdminUsersPage } from './admin-users.js';

const csrf = 'c'.repeat(43);

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A',
  name: 'andru',
  displayName: 'Andru Example',
  role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z',
  controlPresentation: true,
  disabled: false,
};

const ruth: AccountRecord = {
  id: 'z9kQ5wEtQEy5PfN2Zr9m7B',
  name: 'ruth',
  displayName: 'Ruth Example',
  role: 'editor',
  createdAt: '2026-09-13T09:31:00.000Z',
  controlPresentation: false,
  disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const signedIn = (permissions = ['accounts.manage']): SessionView => ({
  account: me,
  actor: `account:${me.id}`,
  permissions,
  startedAt: '2026-09-13T09:30:00.000Z',
  lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z',
  rotation: 'authentication',
  csrf,
  slots: [],
});

const list = (): ReturnType<typeof reply> => reply(200, successEnvelope([ruth, me], 'request-list'));

const renderPage = async (): Promise<void> => {
  currentPath.value = '/admin/users';
  // Keeps the shell's notification bell from polling and consuming a slot in this file's sequential
  // `mockResolvedValueOnce` fetch queues; the page under test never needs the bell to be active.
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  render(<App />);
  await screen.findByRole('table');
};

describe('AdminUsersPage', () => {
  beforeEach(() => {
    resetAppState();
    sessionStorage.clear();
    session.value = signedIn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders account facts and keeps self-refused controls off the signed-in row', async () => {
    setFetching(async () => list());
    await renderPage();

    expect(screen.getAllByText('Active')).toHaveLength(2);
    expect(screen.getByText('Allowed')).toBeTruthy();
    expect(screen.getByText('(you)')).toBeTruthy();
    const ownRow = screen.getByText('andru').closest('tr') as HTMLTableRowElement;
    expect(ownRow.textContent).not.toContain('Disable Andru Example');
    expect(ownRow.textContent).not.toContain('Role for Andru Example');
  });

  it('posts a new account with CSRF, refreshes the list, and announces its creation', async () => {
    const fetching = vi.fn<FetchLike>(async (path, init) => {
      if (init.method === 'POST') return reply(201, successEnvelope({}, 'request-create'));
      return list();
    });
    setFetching(fetching);
    await renderPage();
    sessionStorage.setItem(`${DRAFT_PREFIX}another-form`, JSON.stringify({ name: 'Elsewhere' }));

    fireEvent.input(screen.getByLabelText('Handle'), { target: { value: 'maria' } });
    fireEvent.input(screen.getByLabelText('Display name'), { target: { value: 'Maria Example' } });
    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'a secure password' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }).closest('form') as HTMLFormElement);

    await waitFor(() => expect(document.getElementById('announce-polite')?.textContent).toBe('Account Maria Example created.'));
    expect(fetching.mock.calls.map(([path, init]) => [path, init.method ?? 'GET'])).toEqual([
      [ACCOUNTS_PATH, 'GET'],
      [ACCOUNTS_PATH, 'POST'],
      [ACCOUNTS_PATH, 'GET'],
    ]);
    expect(fetching.mock.calls[1]?.[1].headers[CSRF_HEADER]).toBe(csrf);
    expect(JSON.parse(fetching.mock.calls[1]?.[1].body ?? '{}')).toEqual({
      name: 'maria', displayName: 'Maria Example', password: 'a secure password', role: 'editor',
    });
    expect(document.getElementById('announce-polite')?.textContent).toBe('Account Maria Example created.');
    expect(sessionStorage.getItem(`${DRAFT_PREFIX}admin-users:create`)).toBeNull();
    expect(sessionStorage.getItem(`${DRAFT_PREFIX}another-form`)).toBe('{"name":"Elsewhere"}');
  });

  it('restores the create form draft after the page remounts', async () => {
    setFetching(async () => list());
    currentPath.value = '/admin/users';
    const first = render(<App />);
    await screen.findByRole('table');
    fireEvent.input(screen.getByLabelText('Handle'), { target: { value: 'maria' } });
    fireEvent.input(screen.getByLabelText('Display name'), { target: { value: 'Maria Example' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'member' } });
    first.unmount();

    await renderPage();

    expect((screen.getByLabelText('Handle') as HTMLInputElement).value).toBe('maria');
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Maria Example');
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Role') as HTMLSelectElement).value).toBe('member');
  });

  it('puts a creation field refusal on its named input', async () => {
    setFetching(async (_path, init) => init.method === 'POST'
      ? reply(422, errorEnvelope('request.validation_failed', 'Refused', 'request-create', [
        { path: 'newAccount.name', code: 'field.not_allowed', message: 'That handle is already in use.' },
      ]))
      : list());
    await renderPage();

    fireEvent.input(screen.getByLabelText('Handle'), { target: { value: 'maria' } });
    fireEvent.input(screen.getByLabelText('Display name'), { target: { value: 'Maria Example' } });
    fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'a secure password' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create account' }).closest('form') as HTMLFormElement);

    expect((await screen.findByText('That handle is already in use.')).textContent).toBeTruthy();
    expect(screen.getByLabelText('Handle').getAttribute('aria-invalid')).toBe('true');
  });

  it('assigns the selected role', async () => {
    const fetching = vi.fn<FetchLike>(async (_path, init) => init.method === 'PATCH' ? reply(200, successEnvelope({}, 'request-role')) : list());
    setFetching(fetching);
    await renderPage();

    fireEvent.change(screen.getByLabelText('Role for Ruth Example'), { target: { value: 'member' } });

    await waitFor(() => expect(document.getElementById('announce-polite')?.textContent).toBe('Account Ruth Example updated.'));
    expect(fetching.mock.calls[1]?.[0]).toBe(`${ACCOUNTS_PATH}/${encodeURIComponent(ruth.id)}/role`);
    expect(JSON.parse(fetching.mock.calls[1]?.[1].body ?? '{}')).toEqual({ role: 'member' });
  });

  it('disables and restores an account', async () => {
    const disabled = { ...ruth, disabled: true };
    let reads = 0;
    const fetching = vi.fn<FetchLike>(async (_path, init) => {
      if (init.method === 'PATCH') return reply(200, successEnvelope({}, 'request-status'));
      reads += 1;
      return reply(200, successEnvelope(reads === 1 ? [ruth, me] : [disabled, me], 'request-list'));
    });
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Disable Ruth Example' }));

    await screen.findByRole('button', { name: 'Restore Ruth Example' });
    expect(fetching.mock.calls[1]?.[0]).toBe(`${ACCOUNTS_PATH}/${ruth.id}/status`);
    expect(JSON.parse(fetching.mock.calls[1]?.[1].body ?? '{}')).toEqual({ disabled: true });
  });

  it('encodes account ids in status and presentation requests', async () => {
    const encode = vi.spyOn(globalThis, 'encodeURIComponent').mockReturnValue('escaped-account-id');
    const fetching = vi.fn<FetchLike>(async (_path, init) => init.method === 'PATCH' ? reply(200, successEnvelope({}, 'request-update')) : list());
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Disable Ruth Example' }));
    await waitFor(() => expect(fetching).toHaveBeenCalledTimes(3));
    fireEvent.click(await screen.findByRole('button', { name: 'Allow Ruth Example to control presentation' }));
    await waitFor(() => expect(fetching).toHaveBeenCalledTimes(5));

    expect(fetching.mock.calls[1]?.[0]).toBe(`${ACCOUNTS_PATH}/escaped-account-id/status`);
    expect(fetching.mock.calls[3]?.[0]).toBe(`${ACCOUNTS_PATH}/escaped-account-id/control-presentation`);
    expect(encode).toHaveBeenCalledWith(ruth.id);
  });

  it('grants and revokes presentation control', async () => {
    const fetching = vi.fn<FetchLike>(async (_path, init) => init.method === 'PATCH' ? reply(200, successEnvelope({}, 'request-control')) : list());
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Allow Ruth Example to control presentation' }));

    await waitFor(() => expect(document.getElementById('announce-polite')?.textContent).toBe('Account Ruth Example updated.'));
    expect(fetching.mock.calls[1]?.[0]).toBe(`${ACCOUNTS_PATH}/${ruth.id}/control-presentation`);
    expect(JSON.parse(fetching.mock.calls[1]?.[1].body ?? '{}')).toEqual({ granted: true });
  });

  it('shows and announces a refused change', async () => {
    setFetching(async (_path, init) => init.method === 'PATCH'
      ? reply(422, errorEnvelope('request.validation_failed', 'Refused', 'request-control', [
        { path: 'grant.granted', code: 'field.not_allowed', message: 'Control is unavailable.' },
      ]))
      : list());
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Allow Ruth Example to control presentation' }));

    expect((await screen.findByRole('alert')).textContent).toBe('The change was refused: Control is unavailable.');
    expect(document.getElementById('announce-assertive')?.textContent).toBe('The change was refused: Control is unavailable.');
  });

  it('shows a list refusal as an alert', async () => {
    setFetching(async () => reply(500, errorEnvelope('server.failed', 'Failed', 'request-list')));
    render(<AdminUsersPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The accounts could not be loaded.');
  });

  it('keeps valid rows while reporting malformed rows as a failed load', async () => {
    setFetching(async () => reply(200, successEnvelope([ruth, { id: 'invalid' }], 'request-list')));
    render(<AdminUsersPage />);

    expect(await screen.findByText('ruth')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('The accounts could not be loaded.');
  });

  it('renders not found and makes no request without account administration permission', () => {
    const fetching = vi.fn<FetchLike>();
    setFetching(fetching);
    act(() => { session.value = signedIn([]); });
    render(<AdminUsersPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(fetching).not.toHaveBeenCalled();
  });
});
