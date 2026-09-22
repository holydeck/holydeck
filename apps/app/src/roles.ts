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

/** Views and changes the settings file. Admin's alone, by role — the same as accounts. */
export const SETTINGS_MANAGE = 'settings.manage';

/**
 * Creates, versions, archives and brings back Slide Layouts (spec TMPL-01, which gives them to Admin).
 * Spelled `layouts.` rather than `slideLayouts.` on purpose: the record class of the same name already
 * owns `slideLayouts.read` and `slideLayouts.append`, and the two vocabularies stay told apart by sight.
 */
export const LAYOUTS_MANAGE = 'layouts.manage';

/**
 * Creates and previews Service Templates (spec TMPL-04, which gives them to Admin).
 * Spelled `serviceTemplates.` rather than borrowing the record class's internal vocabulary, for the
 * same reason `layouts.` was spelled apart from `slideLayouts.`.
 */
export const SERVICE_TEMPLATES_MANAGE = 'serviceTemplates.manage';

/**
 * Uploads to and administers the media library MEDI-01 describes. Spelled `media.` rather than borrowing
 * `media.ts`'s own store-permission vocabulary, for the same reason `layouts.` was spelled apart from
 * `slideLayouts.`: an operator-facing permission and a repository's internal one are never the same word.
 * Admin's alone, by role — the same as accounts, settings and Layouts.
 */
export const MEDIA_MANAGE = 'media.manage';

/**
 * Creates, schedules, transitions and edits Services and their items (spec SERV-01/02/03). Spelled
 * `services.` rather than borrowing `services.ts`'s own store-permission vocabulary, for the same reason
 * `layouts.` and `media.` were spelled apart from their record classes. Editor's first-ever permission
 * grant — an Editor plans and runs Services without needing Admin's account/settings/Layouts/media reach.
 */
export const SERVICES_MANAGE = 'services.manage';

/**
 * Lists recorded backups and requests an on-demand run (OPS-05). Admin's alone, by role — the same as
 * administering settings and accounts, with its own operator-facing permission apart from the stores.
 */
export const BACKUP_MANAGE = 'backup.manage';

/**
 * Requests a recorded backup be applied to production (OPS-06). Admin's alone, by role — the same as
 * requesting a backup, and kept apart from `BACKUP_MANAGE` because granting one is not granting the other.
 */
export const RESTORE_MANAGE = 'restore.manage';

const ROLE_PERMISSIONS: Readonly<Record<AccountRole, readonly string[]>> = {
  admin: [
    ACCOUNTS_MANAGE,
    SETTINGS_MANAGE,
    LAYOUTS_MANAGE,
    SERVICE_TEMPLATES_MANAGE,
    MEDIA_MANAGE,
    SERVICES_MANAGE,
    BACKUP_MANAGE,
    RESTORE_MANAGE,
  ],
  editor: [SERVICES_MANAGE],
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
