// The operator-facing permission vocabulary a session is granted at sign-in, kept apart from the
// internal store-permission strings `records.ts` names for its own collections. A route asks whether a
// session carries one of these; a repository asks whether a context carries one of those. Confusing the
// two would let a route that means "may administer accounts" be satisfied by a context that only means
// "may append an audit event," so the two vocabularies are never spelled the same way twice.

import type { AccountRecord, AccountRole } from '@holydeck/contracts/accounts';

/** Presents Control to a viewer without being one of the three roles that make an account. */
export const PRESENTATION_CONTROL = 'presentation.control';

/**
 * Takes a Service live over an open blocker, carrying every blocking check into the trail with a reason
 * (ADR 0003). Held by the Operator alone and granted per account, never by role and never implied by
 * Control presentation: operating the run is not the same answerability as overruling readiness.
 */
export const OPERATOR_OVERRIDE = 'operator.override';

/** Administers accounts: grants and revokes what other accounts hold. Admin's alone, by role. */
export const ACCOUNTS_MANAGE = 'accounts.manage';

/** Views and changes the settings file. Admin's alone, by role — the same as accounts. */
export const SETTINGS_MANAGE = 'settings.manage';

/**
 * Creates, versions, archives and brings back Slide Layouts (spec TMPL-01, which gives them to Admin).
 * Spelled `layouts.` rather than `slideLayouts.` on purpose: the record class of the same name already
 * owns `slideLayouts.read` and `slideLayouts.append`, and the two vocabularies stay told apart by sight.
 */
export const LAYOUTS_MANAGE = 'layouts.manage';

const ROLE_PERMISSIONS: Readonly<Record<AccountRole, readonly string[]>> = {
  admin: [ACCOUNTS_MANAGE, SETTINGS_MANAGE, LAYOUTS_MANAGE],
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
    ...(account.operatorOverride ? [OPERATOR_OVERRIDE] : []),
  ]);
}
