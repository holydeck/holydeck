// @vitest-environment happy-dom
// The first-run path combines local validation with two server actions, so these tests exercise its user
// visible boundaries: the offered rules, an error that never leaves the browser, server feedback, and a
// completed claim that comes back through the ordinary boot route.

import { fireEvent, render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ONBOARDING_PATH, type OnboardingOffer } from '@holydeck/contracts/accounts';
import { NOT_FOUND, errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { SESSION_PATH, type SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { App } from '../app.js';
import { onboarding, resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { currentPath } from '../router.js';

const offer: OnboardingOffer = {
  role: 'admin',
  name: { minimum: 4, maximum: 18 },
  password: { minimum: 14, maximum: 96 },
};

const signedIn = {
  actor: 'account:GLkQ5wEtQEy5PfN2Zr9m7A',
  permissions: ['services.read'],
  startedAt: '2026-09-13T09:30:00.000Z',
  lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z',
  rotation: 'authentication',
  csrf: 'a'.repeat(43),
  slots: [],
} as const satisfies SessionView;

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const resetRoute = (): void => {
  history.replaceState({}, '', '/');
  currentPath.value = '/';
  history.replaceState({}, '', '/welcome');
  currentPath.value = '/welcome';
};

const fill = (values: { readonly name?: string; readonly displayName?: string; readonly password?: string; readonly confirm?: string } = {}): void => {
  fireEvent.input(screen.getByLabelText('Handle'), { target: { value: values.name ?? 'ruth' } });
  fireEvent.input(screen.getByLabelText('Display name'), { target: { value: values.displayName ?? 'Ruth Example' } });
  fireEvent.input(screen.getByLabelText('Password'), { target: { value: values.password ?? 'a secure password' } });
  fireEvent.input(screen.getByLabelText('Confirm password'), { target: { value: values.confirm ?? 'a secure password' } });
};

const submit = (): void => {
  fireEvent.submit(screen.getByRole('button', { name: 'Create account' }).closest('form') as HTMLFormElement);
};

describe('WelcomePage', () => {
  beforeEach(() => {
    resetAppState();
    resetRoute();
    onboarding.value = offer;
    session.value = null;
  });

  it('renders the bounds the server offered', () => {
    render(<App />);

    expect(screen.getByText('4 to 18 characters, used to sign in.')).toBeTruthy();
    expect(screen.getByText('14 to 96 characters.')).toBeTruthy();
    expect(screen.getByLabelText('Display name').getAttribute('minlength')).toBe('1');
    expect(screen.getByLabelText('Display name').getAttribute('maxlength')).toBe('64');
  });

  it('keeps a mismatched confirmation in the browser and focuses it', () => {
    const fetching = vi.fn<FetchLike>();
    setFetching(fetching);
    render(<App />);
    fill({ confirm: 'a different password' });

    submit();

    const confirm = screen.getByLabelText('Confirm password');
    expect(fetching).not.toHaveBeenCalled();
    expect(confirm.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(confirm);
    expect(screen.getByRole('alert').textContent).toContain('Check the highlighted fields.');
  });

  it('places a server field problem beside the input it names', async () => {
    setFetching(async () => reply(422, errorEnvelope('request.validation_failed', 'Refused', 'request-1', [
      { path: 'claim.name', code: 'field.not_allowed', message: 'That handle is already in use.' },
    ])));
    render(<App />);
    fill();

    submit();

    expect(await screen.findByText('That handle is already in use.')).toBeTruthy();
    expect(screen.getByLabelText('Handle').getAttribute('aria-invalid')).toBe('true');
  });

  it('claims, opens a session, and boots into services', async () => {
    const fetching = vi.fn<FetchLike>(async (path, init) => {
      if (path === ONBOARDING_PATH && init.method === 'POST') return reply(201, successEnvelope({}, 'request-1'));
      if (path === SESSION_PATH && init.method === 'POST') return reply(201, successEnvelope({}, 'request-2'));
      if (path === ONBOARDING_PATH) return reply(404, errorEnvelope(NOT_FOUND, 'Claimed', 'request-3'));
      return reply(200, successEnvelope(signedIn, 'request-4'));
    });
    setFetching(fetching);
    render(<App />);
    fill();

    submit();

    expect(await screen.findByRole('heading', { level: 1, name: 'Services' })).toBeTruthy();
    expect(session.value).toEqual(signedIn);
    expect(currentPath.value).toBe('/services');
    expect(fetching.mock.calls.map(([path, init]) => [path, init.method ?? 'GET'])).toEqual([
      [ONBOARDING_PATH, 'POST'],
      [SESSION_PATH, 'POST'],
      [ONBOARDING_PATH, 'GET'],
      [SESSION_PATH, 'GET'],
    ]);
  });

  it('returns to sign-in with an explanation when the new account cannot open a session', async () => {
    setFetching(async (path, init) => path === ONBOARDING_PATH && init.method === 'POST'
      ? reply(201, successEnvelope({}, 'request-1'))
      : reply(401, errorEnvelope('session.sign_in_refused', 'Refused', 'request-2')));
    render(<App />);
    fill();

    submit();

    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(
      'Signing in failed. Check the handle and the password, and try again in a few minutes.',
    );
    expect(currentPath.value).toBe('/sign-in?notice=claim-sign-in-refused');
  });

  it('shows the sign-in link once a claim has already happened', () => {
    onboarding.value = 'claimed';
    render(<App />);

    expect(screen.getByText('This installation already has an administrator. Sign in instead.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/sign-in');
  });
});
