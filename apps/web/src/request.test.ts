// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onboardingOffer } from '@holydeck/contracts/accounts';
import { UPDATE_REQUIRED, errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { SESSION_EXPIRED, SESSION_PATH } from '@holydeck/contracts/sessions';

import type { FetchLike } from './api.js';

import { lastAnsweredAt, resetAppState, session, updateRequired } from './app-state.js';
import { boot, request, setFetching } from './request.js';
import { currentPath } from './router.js';

const SESSION = {
  actor: 'account:GLkQ5wEtQEy5PfN2Zr9m7A',
  permissions: ['services.read'],
  startedAt: '2026-09-13T09:30:00.000Z',
  lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z',
  rotation: 'authentication',
  csrf: 'a'.repeat(43),
  slots: [],
} as const;

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const refused = (status: number, code: string) => reply(status, errorEnvelope(code, 'refused', 'request-1'));

const resetRoute = (path = '/'): void => {
  history.replaceState({}, '', path);
  currentPath.value = path;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T10:00:00.000Z'));
  resetAppState();
  resetRoute();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('boot', () => {
  it('shows first-run onboarding without asking for a session', async () => {
    const fetching = vi.fn<FetchLike>(async () => reply(200, successEnvelope(onboardingOffer(), 'request-1')));
    setFetching(fetching);

    await boot();

    expect(session.value).toBeNull();
    expect(currentPath.value).toBe('/welcome');
    expect(fetching).toHaveBeenCalledTimes(1);
  });

  it('takes an existing session from the root to services', async () => {
    const fetching = vi.fn<FetchLike>(async (path) =>
      path === SESSION_PATH
        ? reply(200, successEnvelope(SESSION, 'request-2'))
        : refused(404, 'resource.not_found'),
    );
    setFetching(fetching);

    await boot();

    expect(session.value).toEqual(SESSION);
    expect(currentPath.value).toBe('/services');
  });

  it('keeps an existing session on the page it was already using', async () => {
    resetRoute('/services/example');
    const fetching = vi.fn<FetchLike>(async (path) =>
      path === SESSION_PATH
        ? reply(200, successEnvelope(SESSION, 'request-3'))
        : refused(404, 'resource.not_found'),
    );
    setFetching(fetching);

    await boot();

    expect(currentPath.value).toBe('/services/example');
  });

  it('returns an existing session to the safe sign-in destination it was given', async () => {
    resetRoute('/sign-in?next=%2Fadmin%2Fusers');
    const fetching = vi.fn<FetchLike>(async (path) =>
      path === SESSION_PATH
        ? reply(200, successEnvelope(SESSION, 'request-4'))
        : refused(404, 'resource.not_found'),
    );
    setFetching(fetching);

    await boot();

    expect(currentPath.value).toBe('/admin/users');
  });

  it('returns an expired session to sign-in with the protected path encoded', async () => {
    resetRoute('/admin/users');
    const fetching = vi.fn<FetchLike>(async (path) =>
      path === SESSION_PATH ? refused(401, SESSION_EXPIRED) : refused(404, 'resource.not_found'),
    );
    setFetching(fetching);

    await boot();

    expect(session.value).toBeNull();
    expect(currentPath.value).toBe('/sign-in?next=%2Fadmin%2Fusers');
  });

  it('leaves the sign-in page in place when its session answer is expired', async () => {
    resetRoute('/sign-in');
    const fetching = vi.fn<FetchLike>(async (path) =>
      path === SESSION_PATH ? refused(401, SESSION_EXPIRED) : refused(404, 'resource.not_found'),
    );
    setFetching(fetching);

    await boot();

    expect(session.value).toBeNull();
    expect(currentPath.value).toBe('/sign-in');
  });

  it('records an update refusal without navigating away from the current page', async () => {
    const fetching = vi.fn<FetchLike>(async (path) =>
      path === SESSION_PATH ? refused(426, UPDATE_REQUIRED) : refused(404, 'resource.not_found'),
    );
    setFetching(fetching);

    await boot();

    expect(updateRequired.value).toBe(true);
    expect(session.value).toBeNull();
    expect(currentPath.value).toBe('/');
  });
});

describe('request', () => {
  it('redirects an expired protected request to sign-in', async () => {
    resetRoute('/services/example');
    const fetching = vi.fn<FetchLike>(async () => refused(401, SESSION_EXPIRED));
    setFetching(fetching);

    const result = await request('/api/v1/services/example');

    expect(result.ok).toBe(false);
    expect(session.value).toBeNull();
    expect(currentPath.value).toBe('/sign-in?next=%2Fservices%2Fexample');
  });

  it('does not redirect an expiry the sign-in page itself received', async () => {
    resetRoute('/sign-in');
    setFetching(async () => refused(401, SESSION_EXPIRED));

    await request('/api/v1/session');

    expect(currentPath.value).toBe('/sign-in');
  });

  it('records an update refusal while returning it unchanged', async () => {
    const fetching = vi.fn<FetchLike>(async () => refused(426, UPDATE_REQUIRED));
    setFetching(fetching);

    const result = await request('/api/v1/anything');

    expect(result.ok ? undefined : result.code).toBe(UPDATE_REQUIRED);
    expect(updateRequired.value).toBe(true);
  });

  it('passes an ordinary refusal through unchanged', async () => {
    setFetching(async () => refused(403, 'auth.forbidden'));

    expect(await request('/api/v1/anything')).toMatchObject({ ok: false, code: 'auth.forbidden' });
  });

  it("passes a change through api.ts so it carries the caller's CSRF token", async () => {
    const fetching = vi.fn<FetchLike>(async () => reply(200, successEnvelope({ saved: true }, 'request-5')));
    setFetching(fetching);

    await request('/api/v1/anything', { method: 'POST', csrf: SESSION.csrf, body: { name: 'service' } });

    expect(fetching).toHaveBeenCalledWith('/api/v1/anything', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-holydeck-csrf': SESSION.csrf }),
    }));
  });

  it('records when a successful request was answered', async () => {
    setFetching(async () => reply(200, successEnvelope({ saved: true }, 'request-6')));

    await request('/api/v1/anything');

    expect(lastAnsweredAt.value).toBe(Date.now());
  });
});
