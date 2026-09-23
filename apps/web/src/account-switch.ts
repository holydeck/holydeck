// Switching accounts (COLAB-08) changes whose data everything in this tab belongs to: the stores behind
// every page, the preparation cache, open editors and their drafts. Rather than chase each of those and
// hope none is missed, a switch finishes the way a fresh tab would begin: the drafts are cleared (they
// live in sessionStorage, which a reload keeps), then the page is loaded again from nothing, so no
// signal or module-level cache can still hold what the previous account read.
//
// Adding an account ends the same way: the server makes the newly signed-in slot the active one, so the
// tab is now the new account's and must start over just as it does after a switch.

import { SESSION_PATH } from '@holydeck/contracts/sessions';

import { csrf } from './app-state.js';
import { clearAllDrafts } from './drafts.js';
import { fieldErrors } from './form-errors.js';
import { request } from './request.js';

/** Where a tab lands after it changes account: the one page every account may open. */
const LANDING = '/services';

/** The full page load a switch ends in. An object, so a test can stand in for a browser navigation. */
export const pageReload = {
  to(path: string): void {
    globalThis.location.assign(path);
  },
};

/** Clears what the previous account left in this tab, then loads the page again as the new one. */
export function reloadAsAnotherAccount(): void {
  clearAllDrafts();
  pageReload.to(LANDING);
}

/**
 * Makes `slotId` the active account, then starts the tab over as it. Answers the message to show when the
 * server refuses, in which case nothing in the tab has changed; answers nothing once the reload is under way.
 */
export async function switchAccount(slotId: string): Promise<string | undefined> {
  const result = await request(SESSION_PATH, { method: 'PATCH', csrf: csrf() ?? '', body: { active: slotId } });
  if (!result.ok) return fieldErrors(result, []).other;
  reloadAsAnotherAccount();
  return undefined;
}
