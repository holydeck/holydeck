// @vitest-environment happy-dom
// Sign-out has one safe destination for a confirmed deletion and an already-ended session; an uncertain
// refusal is intentionally different, keeping the session visible and saying what happened in the shell.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { SESSION_EXPIRED, SESSION_PATH, type SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from './api.js';

import { resetAppState, session } from './app-state.js';
import { setFetching } from './request.js';
import { currentPath } from './router.js';
import { signOut } from './sign-out.js';

const signedIn = { csrf: 'c'.repeat(43), permissions: [], slots: [] } as unknown as SessionView;

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const resetRoute = (): void => {
  history.replaceState({}, '', '/');
  currentPath.value = '/';
  history.replaceState({}, '', '/services');
  currentPath.value = '/services';
};

describe('signOut', () => {
  beforeEach(() => {
    resetAppState();
    resetRoute();
    session.value = signedIn;
    document.body.innerHTML = '<p id="announce-assertive" aria-live="assertive"></p>';
  });

  it('ends a confirmed session and replaces the current history entry', async () => {
    const fetching = vi.fn<FetchLike>(async () => reply(200, successEnvelope({}, 'request-1')));
    setFetching(fetching);

    await signOut();

    expect(fetching).toHaveBeenCalledWith(SESSION_PATH, expect.objectContaining({
      method: 'DELETE',
      headers: expect.objectContaining({ 'x-holydeck-csrf': signedIn.csrf }),
    }));
    expect(session.value).toBeNull();
    expect(currentPath.value).toBe('/sign-in');
  });

  it('treats an already expired session as a completed sign-out', async () => {
    setFetching(async () => reply(401, errorEnvelope(SESSION_EXPIRED, 'Expired', 'request-1')));

    await signOut();

    expect(session.value).toBeNull();
    expect(currentPath.value).toBe('/sign-in');
  });

  it('keeps an uncertain session in place and announces the failure', async () => {
    setFetching(async () => reply(500, errorEnvelope('server.unexpected_error', 'Failed', 'request-1')));

    await signOut();

    expect(session.value).toBe(signedIn);
    expect(currentPath.value).toBe('/services');
    expect(document.getElementById('announce-assertive')?.textContent).toBe('Signing out failed. Try again.');
  });
});
