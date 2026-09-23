// @vitest-environment happy-dom
// Sign-in's public promise is deliberately narrow: a normal refusal stays generic, while a success returns
// through boot so the route decision is the same one a restoring session uses after a browser reload.

import { fireEvent, render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ONBOARDING_PATH } from '@holydeck/contracts/accounts';
import { NOT_FOUND, errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { SESSION_PATH, SIGN_IN_REFUSED, type SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { pageReload } from '../account-switch.js';
import { App } from '../app.js';
import { resetAppState, session } from '../app-state.js';
import { DRAFT_PREFIX } from '../drafts.js';
import { SignInPage } from './sign-in.js';
import { setFetching } from '../request.js';
import { currentPath, matchRoute } from '../router.js';

const signedIn = {
  actor: 'account:GLkQ5wEtQEy5PfN2Zr9m7A',
  permissions: ['services.read', 'accounts.manage'],
  startedAt: '2026-09-13T09:30:00.000Z',
  lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z',
  rotation: 'authentication',
  csrf: 'a'.repeat(43),
  slots: [],
} as const satisfies SessionView;

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const resetRoute = (path = '/sign-in'): void => {
  history.replaceState({}, '', '/');
  currentPath.value = '/';
  history.replaceState({}, '', path);
  currentPath.value = path;
};

const fill = (): void => {
  fireEvent.input(screen.getByLabelText('Handle'), { target: { value: 'ruth' } });
  fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'a secure password' } });
};

const submit = (): void => {
  fireEvent.submit(screen.getByRole('button', { name: 'Sign in' }).closest('form') as HTMLFormElement);
};

describe('SignInPage', () => {
  beforeEach(() => {
    resetAppState();
    resetRoute();
    session.value = null;
  });

  it('gives one generic refusal and clears the password', async () => {
    setFetching(async () => reply(401, errorEnvelope(SIGN_IN_REFUSED, 'Wrong password', 'request-1')));
    render(<SignInPage next={undefined} />);
    fill();

    submit();

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Signing in failed. Check the handle and the password, and try again in a few minutes.',
    );
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  });

  it('adds another account from a signed-in tab, then starts the tab over as that account', async () => {
    resetRoute('/sign-in?add=1');
    session.value = signedIn;
    sessionStorage.setItem(`${DRAFT_PREFIX}users`, JSON.stringify({ name: 'Ruth' }));
    const reload = vi.spyOn(pageReload, 'to').mockImplementation(() => undefined);
    const fetching = vi.fn<FetchLike>(async (path, init) => {
      if (path === SESSION_PATH && init.method === 'POST') return reply(201, successEnvelope({}, 'request-add'));
      throw new Error(`unexpected request ${String(init.method)} ${path}`);
    });
    setFetching(fetching);
    render(<App />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Add account');
    expect(screen.queryByRole('status')).toBeNull();
    fill();
    submit();

    await vi.waitFor(() => expect(reload).toHaveBeenCalledWith('/services'));
    expect(sessionStorage.getItem(`${DRAFT_PREFIX}users`)).toBeNull();
    reload.mockRestore();
  });

  it('shows expiry context only when the router supplied a return path', () => {
    render(<SignInPage next="/admin/users" />);

    expect(screen.getByRole('status').textContent).toBe('Your session ended. Sign in again to continue.');
  });

  it('returns a new session to its safe next path', async () => {
    resetRoute('/sign-in?next=%2Fadmin%2Fusers');
    const fetching = vi.fn<FetchLike>(async (path, init) => {
      if (path === SESSION_PATH && init.method === 'POST') return reply(201, successEnvelope({}, 'request-1'));
      if (path === ONBOARDING_PATH) return reply(404, errorEnvelope(NOT_FOUND, 'Claimed', 'request-2'));
      return reply(200, successEnvelope(signedIn, 'request-3'));
    });
    setFetching(fetching);
    render(<App />);
    fill();

    submit();

    await screen.findByRole('heading', { level: 1, name: 'Users' });
    expect(session.value).toEqual(signedIn);
    expect(currentPath.value).toBe('/admin/users');
    expect(JSON.parse(fetching.mock.calls[0]?.[1].body ?? '{}')).toEqual({ name: 'ruth', password: 'a secure password' });
  });

  it('returns a new session to services without a next path', async () => {
    const fetching = vi.fn<FetchLike>(async (path, init) => {
      if (path === SESSION_PATH && init.method === 'POST') return reply(201, successEnvelope({}, 'request-1'));
      if (path === ONBOARDING_PATH) return reply(404, errorEnvelope(NOT_FOUND, 'Claimed', 'request-2'));
      return reply(200, successEnvelope(signedIn, 'request-3'));
    });
    setFetching(fetching);
    render(<App />);
    fill();

    submit();

    await screen.findByRole('heading', { level: 1, name: 'Services' });
    expect(currentPath.value).toBe('/services');
  });

  it('does not pass an unsafe next path on to boot', async () => {
    const matched = matchRoute('/sign-in?next=%2F%2Fevil.example');
    expect(matched).toEqual({ name: 'sign-in', next: undefined });
    resetRoute('/sign-in?next=%2F%2Fevil.example');
    setFetching(async (path, init) => {
      if (path === SESSION_PATH && init.method === 'POST') return reply(201, successEnvelope({}, 'request-1'));
      if (path === ONBOARDING_PATH) return reply(404, errorEnvelope(NOT_FOUND, 'Claimed', 'request-2'));
      return reply(200, successEnvelope(signedIn, 'request-3'));
    });
    render(<App />);
    fill();

    submit();

    await screen.findByRole('heading', { level: 1, name: 'Services' });
    expect(currentPath.value).toBe('/services');
  });
});
