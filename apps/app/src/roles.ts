// The operator-facing permission vocabulary a session is granted at sign-in, kept apart from the
// internal store-permission strings `records.ts` names for its own collections. A route asks whether a
// session carries one of these; a repository asks whether a context carries one of those. Confusing the
// two would let a route that means "may administer accounts" be satisfied by a context that only means
// "may append an audit event," so the two vocabularies are never spelled the same way twice.

import type { AccountRecord, AccountRole } from '@holydeck/contracts/accounts';

/** Presents Control to a viewer without being one of the three roles that make an account. */
export const PRESENTATION_CONTROL = 'presentation.control';

/** Administers accounts: grants and revokes what other accounts hold. Admin's alone, by role. */
export const ACCOUNTS_MANAGE = 'accounts.manage';

const ROLE_PERMISSIONS: Readonly<Record<AccountRole, readonly string[]>> = {
  admin: [ACCOUNTS_MANAGE],
  editor: [],
  member: [],
};

/**
 * What a session opened for this account is granted. Role and Control presentation are granted apart
 * from each other — an admin does not hold Control presentation for being admin, and an editor or a
 * member holds it the moment it is granted to them, exactly as an admin would.
 */
export function permissionsFor(account: AccountRecord): readonly string[] {
  return Object.freeze([
    ...ROLE_PERMISSIONS[account.role],
    ...(account.controlPresentation ? [PRESENTATION_CONTROL] : []),
  ]);
}
