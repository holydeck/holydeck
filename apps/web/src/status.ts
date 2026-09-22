// Where the app shell says its own status — a failed sign-out, an extended session, a user created —
// through the same two live regions `announcements.ts` binds its six contracted announcements to.
//
// A separate door rather than a seventh entry in `ANNOUNCEMENTS`: those six are the UI contract's list,
// graded and bounded there, and the shell's messages are ordinary form and navigation feedback that the
// contract's general rule covers ("status announcements use aria-live"). Sharing `REGION_ID` keeps both
// saying things in the one polite and one assertive place a screen reader watches, never a third.
//
// Unlike `createAnnouncer`, a missing region is not an error here: these messages are also shown on the
// page itself, so a region the shell has not rendered yet costs a repetition, not the information.

import { REGION_ID, type Politeness } from './announcements.js';

/** The two members `say` touches, so a test can hand it any object that has them. */
export interface StatusDocumentLike {
  getElementById(id: string): { textContent: string | null } | null;
}

/**
 * Says `text` in the live region for `politeness`. Identical text is cleared first, because a live region
 * announces changes and a second identical refusal would otherwise be swallowed. Answers whether a region
 * was there to say it in.
 */
export function say(politeness: Politeness, text: string, doc: StatusDocumentLike | undefined = globalThis.document): boolean {
  const region = doc?.getElementById(REGION_ID[politeness]) ?? null;
  if (region === null) return false;
  if (region.textContent === text) region.textContent = '';
  region.textContent = text;
  return true;
}
