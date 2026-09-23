// @vitest-environment happy-dom
// A switch is only finished once nothing of the previous account is left in the tab: its drafts go, and
// the page is loaded again from scratch so no store, cache or signal can still hold what it read.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { SESSION_PATH, type SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from './api.js';

import { pageReload, reloadAsAnotherAccount, switchAccount } from './account-switch.js';
import { resetAppState, session } from './app-state.js';
import { DRAFT_PREFIX } from './drafts.js';
import { setFetching } from './request.js';

const signedIn = { csrf: 'c'.repeat(43), permissions: [], slots: [] } as unknown as SessionView;

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

describe('switching the account a tab works as', () => {
  beforeEach(() => {
    resetAppState();
    session.value = signedIn;
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('activates the slot, clears every draft and reloads the whole page onto the services list', async () => {
    const fetching = vi.fn<FetchLike>(async () => reply(200, successEnvelope({}, 'r-switch')));
    setFetching(fetching);
    const reload = vi.spyOn(pageReload, 'to').mockImplementation(() => undefined);
    sessionStorage.setItem(`${DRAFT_PREFIX}song:s1`, JSON.stringify({ title: 'Draft of the other account' }));

    expect(await switchAccount('s2')).toBeUndefined();

    expect(fetching).toHaveBeenCalledWith(SESSION_PATH, expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ active: 's2' }),
      headers: expect.objectContaining({ 'x-holydeck-csrf': signedIn.csrf }),
    }));
    expect(sessionStorage.getItem(`${DRAFT_PREFIX}song:s1`)).toBeNull();
    expect(reload).toHaveBeenCalledWith('/services');
  });

  it('keeps the tab, its drafts and its page when the server refuses the switch, and says why', async () => {
    setFetching(async () => reply(403, errorEnvelope('auth.forbidden', 'No such slot', 'r-refused')));
    const reload = vi.spyOn(pageReload, 'to').mockImplementation(() => undefined);
    sessionStorage.setItem(`${DRAFT_PREFIX}song:s1`, JSON.stringify({ title: 'Kept' }));

    expect(await switchAccount('s9')).toEqual(expect.any(String));

    expect(sessionStorage.getItem(`${DRAFT_PREFIX}song:s1`)).not.toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('starts over the same way after an added account signs in', () => {
    const reload = vi.spyOn(pageReload, 'to').mockImplementation(() => undefined);
    sessionStorage.setItem(`${DRAFT_PREFIX}users`, JSON.stringify({ name: 'Ruth' }));

    reloadAsAnotherAccount();

    expect(sessionStorage.getItem(`${DRAFT_PREFIX}users`)).toBeNull();
    expect(reload).toHaveBeenCalledWith('/services');
  });
});
