// @vitest-environment happy-dom
// Boot is deliberately small enough to test at its outer edge: mounting replaces the static fallback,
// boot selects the first route from the verified session, and an offline registration never blocks either.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NOT_FOUND, errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { ONBOARDING_PATH } from '@holydeck/contracts/accounts';
import { SESSION_PATH } from '@holydeck/contracts/sessions';

const signedIn = {
  actor: 'account:GLkQ5wEtQEy5PfN2Zr9m7A',
  permissions: ['services.read'],
  startedAt: '2026-09-13T09:30:00.000Z',
  lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z',
  rotation: 'authentication',
  csrf: 'a'.repeat(43),
  slots: [],
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const prepare = (): ReturnType<typeof vi.fn> => {
  document.body.innerHTML = '<div id="app"><main><h1>HolyDeck</h1><p id="status">Preparing the service view.</p></main></div>';
  history.replaceState({}, '', '/');
  const fetching = vi.fn(async (path: string) => {
    if (path === ONBOARDING_PATH) return reply(404, errorEnvelope(NOT_FOUND, 'Claimed', 'request-1'));
    if (path === SESSION_PATH) return reply(200, successEnvelope(signedIn, 'request-2'));
    throw new Error(`unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetching);
  return fetching;
};

const load = async () => import('./main.js');

describe('main', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('mounts the application in #app and lets boot route root to services', async () => {
    const fetching = prepare();
    const register = vi.fn().mockResolvedValue({});
    vi.stubGlobal('navigator', { languages: ['en'], serviceWorker: { register } });

    await load();
    await vi.waitFor(() => expect(document.querySelector('#app main h1')?.textContent).toBe('Services'));

    expect(location.pathname).toBe('/services');
    expect(fetching).toHaveBeenCalledWith(ONBOARDING_PATH, expect.any(Object));
    expect(register).toHaveBeenCalledWith('/service-worker.js', { scope: '/' });
  });

  it('still mounts the application when service-worker registration is refused', async () => {
    prepare();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('navigator', { languages: ['en'], serviceWorker: { register: vi.fn().mockRejectedValue(new Error('refused')) } });

    await load();
    await vi.waitFor(() => expect(document.querySelector('#app main h1')?.textContent).toBe('Services'));

    expect(warn).toHaveBeenCalled();
  });

  it('does not boot when no document exists', async () => {
    const fetching = vi.fn();
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('fetch', fetching);
    vi.stubGlobal('navigator', undefined);

    await load();

    expect(fetching).not.toHaveBeenCalled();
  });
});
