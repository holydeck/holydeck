// The operator-facing permission vocabulary a session is granted at sign-in, kept apart from the
// internal store-permission strings `records.ts` names for its own collections. A route asks whether a
// session carries one of these; a repository asks whether a context carries one of those. Confusing the
// two would let a route that means "may administer accounts" be satisfied by a context that only means
// "may append an audit event," so the two vocabularies are never spelled the same way twice.

import type { AccountRecord, AccountRole } from '@holydeck/contracts/accounts';

/** Presents Control to a viewer without being one of the three roles that make an account. */
export const PRESENTATION_CONTROL = 'presentation.control';

/** Views a run's deck and the surfaces it drives, without Control presentation's power to change any of
 *  it (spec RUN-09). Granted the same way Control presentation is — see `permissionsFor` below. */
export const PRESENTATION_VIEW = 'presentation.view';

/** Reads a Service's own run recap once it has ended (spec RUN-07). Granted the same way Control
 *  presentation is — see `permissionsFor` below. */
export const SERVICE_READ = 'service.read';

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
 * Writes songs, sermons, slide groups and their slides (spec v1c-02, CRT-02). Held by Admin and Editor
 * alike — an Editor plans and runs Services, and preparing their content is part of the same work.
 */
export const CONTENT_EDIT = 'content.edit';

/**
 * Administers the shared catalogues content is written against — content languages and slide labels
 * (spec v1c-02, CRT-02) — rather than a single piece of content itself. Admin's alone, by role: the same
 * reach as accounts, settings, Layouts and media, because a catalogue entry outlives any one Service.
 */
export const CATALOGUE_MANAGE = 'catalogue.manage';

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
 * Enters, lists and leaves presence on a piece of content being edited (spec v1c-09, COLAB-01).
 * Granted to every role, including Member — presence is informational, not a change of reach.
 */
export const PRESENCE_USE = 'presence.use';

/**
 * Reads and restores earlier revisions of any content this store already versions (spec v1c-09,
 * COLAB-02) — today Slide Layouts and Service Templates, both Admin's own surfaces already. Spelled
 * `contentHistory.` rather than folding into `layouts.`/`serviceTemplates.`, because history reaches
 * across whichever content kind wrote it and is not either one's alone to administer.
 */
export const CONTENT_HISTORY_MANAGE = 'contentHistory.manage';

/** Reads the audit trail (spec v1c-09, ADMN-03/ADMN-04). Admin's alone, by role — the same reach as accounts and settings. */
export const AUDIT_READ = 'audit.read';

/** Views status and toggles integrations on/off (spec v1c-09, ADMN-04). Admin's alone, by role. */
export const INTEGRATIONS_MANAGE = 'integrations.manage';

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

/**
 * Sees what the queue holds — the Jobs page's own list, summary and per-job detail (OPS-08). Held apart
 * from `JOBS_MANAGE` because seeing a job is not resetting one. Spelled `jobs.view` rather than `jobs.read`:
 * `queue.ts` already grants `jobs.read` at the record layer, and an operator-facing permission and the
 * internal vocabulary it is checked against are never the same word.
 */
export const JOBS_READ = 'jobs.view';

/**
 * Asks a failed job be tried again (OPS-08). Admin's alone, by role — the same as every other
 * administrative surface. Spelled `jobs.manage` deliberately apart from the store-level
 * `jobs.read`/`jobs.run`/`jobs.requeue` `queue.ts` already grants at the record layer: an operator-facing
 * permission and the internal vocabulary it is checked against are never the same word. Held apart from
 * `JOBS_READ` above because requeuing is not merely seeing: a role that reads the queue does not thereby
 * act on it.
 */
export const JOBS_MANAGE = 'jobs.manage';

/**
 * Reads the operational health report (OPS-09). Admin's alone, by role — the same as every other
 * administrative surface. Spelled `operations.read` rather than `operations.manage` because this
 * surface has nothing to change: it reports on other domains' own state and never writes any of them.
 */
export const OPERATIONS_READ = 'operations.read';

/** Reads and manages the caller's own notification inbox, granted to every signed-in account (OPS-10). */
export const NOTIFICATIONS_USE = 'notifications.use';

const ROLE_PERMISSIONS: Readonly<Record<AccountRole, readonly string[]>> = {
  admin: [
    ACCOUNTS_MANAGE,
    SETTINGS_MANAGE,
    LAYOUTS_MANAGE,
    SERVICE_TEMPLATES_MANAGE,
    MEDIA_MANAGE,
    SERVICES_MANAGE,
    CONTENT_EDIT,
    CATALOGUE_MANAGE,
    PRESENCE_USE,
    CONTENT_HISTORY_MANAGE,
    AUDIT_READ,
    INTEGRATIONS_MANAGE,
    BACKUP_MANAGE,
    RESTORE_MANAGE,
    JOBS_READ,
    JOBS_MANAGE,
    OPERATIONS_READ,
  ],
  editor: [SERVICES_MANAGE, CONTENT_EDIT, PRESENCE_USE, CONTENT_HISTORY_MANAGE],
  member: [PRESENCE_USE],
};

/**
 * What a session opened for this account is granted. Role and Control presentation are granted apart
 * from each other — an admin does not hold Control presentation for being admin, and an editor or a
 * member holds it the moment it is granted to them, exactly as an admin would. Holding Control
 * presentation always implies View presentation and Service read too: an Operator who may run a
 * presentation may always view its deck and read its recap (no standalone way to grant either without
 * Control presentation ships in this spec).
 */
export function permissionsFor(account: AccountRecord): readonly string[] {
  return Object.freeze([
    NOTIFICATIONS_USE,
    ...ROLE_PERMISSIONS[account.role],
    ...(account.controlPresentation ? [PRESENTATION_CONTROL, PRESENTATION_VIEW, SERVICE_READ] : []),
  ]);
}
