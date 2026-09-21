// The administrative trail, written through the durable record class that holds it.
//
// Spec ADMN-03 asks for an append-only trail, and `records.ts` already refuses to rewrite one. What this
// module adds is the vocabulary: an entry names an action out of a declared list, so the trail can be
// enumerated by someone reading this file rather than discovered by reading every caller. An action
// nothing declares is refused, which is the same promise the record classes make about field names.
//
// Nothing here is ever handed a password or a token. `subject` names what was acted on and `detail` says
// why in prose meant for a person, and both are written verbatim — so a caller passing a secret into
// either has put it in the trail, which is the one thing the trail must never hold.

import { randomBytes } from 'node:crypto';

import { requestContext } from './context.js';
import { permissionsFor } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';

import type { RequestContext } from './context.js';
import type { RepositoryDb } from './repositories.js';

/** Every action this release records. One entry per thing an administrator can be answerable for. */
export const AUDIT_ACTIONS = [
  'instance.claim',
  'session.signIn',
  'session.lock',
  // A second factor is its own small history: enrolling one, proving it, spending a code at a sign-in,
  // drawing fresh recovery codes, and giving it up. The trail holds the account it happened to and
  // never the secret, the code, or a recovery code — those live in `totp.ts` and go no further.
  'totp.enroll',
  'totp.verify',
  'totp.use',
  'totp.regenerate',
  'totp.revoke',
  // A passkey has the same small history, minus a secret to keep: registering one, renaming it, signing
  // in with it, and giving it up. The trail holds the key's identifier, which is public by construction,
  // and never the public key, the challenge or the signature.
  'passkey.register',
  'passkey.name',
  'passkey.use',
  'passkey.revoke',
  // Granting or revoking Control presentation, apart from the three roles. An account being created,
  // closed, reopened, or reassigned which of the three roles it holds has its own entry beside this one.
  'account.control',
  'account.create',
  'account.disable',
  'account.restore',
  'account.role',
  // A proven session refused for lacking a permission its route required. The one server-wide check that
  // decides what a session may do, as opposed to who it is — `session.signIn`'s refusal covers the latter.
  'authorization.refuse',
  // A browser-container gaining a second (or third) authenticated slot, and the container's own pointer
  // moving between the slots it already holds. Neither entry ever carries a permission or a token.
  'session.slot.add',
  'session.slot.switch',
  // A Guest's invitation or an output window's capability, issued or given back before it was ever spent.
  // The trail holds the operator who acted and the service and view in prose, and never the token.
  'capability.guest.issue',
  'capability.output.issue',
  'capability.revoke',
  // The settings file, administered as the one thing it is: a change is recorded once, naming only
  // which fields it touched and never a value — viewing it is never audited, the same as any other GET.
  'settings.update',
  // Every change to a piece of content, whatever the surface: `slide-layout-routes.ts` is its first
  // caller, and names the Layout in the subject and the direction in the detail rather than adding a
  // verb per surface. The content surfaces after it join this action instead of inventing their own.
  'content.change',
  // A Service's own history: creating, duplicating, scheduling, archiving/unarchiving, transitioning
  // through its lifecycle, and editing its sections and items. `services.ts` is the only caller — no
  // routes task exists yet to carry this the way `accounts-routes.ts` carries `account.*`, so the
  // store appends these itself.
  'service.create',
  'service.duplicate',
  'service.schedule',
  'service.archive',
  'service.edit',
  'service.transition',
  // A Service item's own history: adding, removing, enabling, disabling, duplicating, and reordering
  // items within a Service's sections. Same caller as the service-level actions above — `services.ts`.
  'service.item.add',
  'service.item.remove',
  'service.item.enable',
  'service.item.disable',
  'service.item.duplicate',
  'service.item.reorder',
  'service.item.revise',
  // Reserved for the presentation-run surface T76+ builds. Exercised only by this task's own tests today.
  'presentation.run',
  // An Operator taking a Service live over an open blocker. Written by `snapshots.ts` itself — no routes
  // task owns the readiness surface yet — and naming the Operator, the reason, and every check carried.
  'readiness.override',
  // Reserved for the backup surface T100+ builds. Exercised only by this task's own tests today.
  'backup.run',
  // Reserved for the restore surface T101+ builds. Exercised only by this task's own tests today.
  'restore.run',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The eight kinds of thing ADMN-03 and ADMN-04 ask the trail to answer for, spanning every action above. */
export const AUDIT_CATEGORIES = [
  'authentication',
  'authorization',
  'settings',
  'content',
  'presentation',
  'backup',
  'restore',
  'integration',
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/**
 * Every action's category, so an entry can be filtered by the kind of thing it answers for without
 * parsing its name. `authentication` proves who the actor is; `authorization` grants, revokes or checks
 * what that actor may do — a distinction this map is what makes assertable rather than merely intended.
 */
export const CATEGORY_OF: Readonly<Record<AuditAction, AuditCategory>> = {
  'instance.claim': 'authentication',
  'session.signIn': 'authentication',
  'session.lock': 'authentication',
  'totp.enroll': 'authentication',
  'totp.verify': 'authentication',
  'totp.use': 'authentication',
  'totp.regenerate': 'authentication',
  'totp.revoke': 'authentication',
  'passkey.register': 'authentication',
  'passkey.name': 'authentication',
  'passkey.use': 'authentication',
  'passkey.revoke': 'authentication',
  'session.slot.add': 'authentication',
  'session.slot.switch': 'authentication',
  'account.control': 'authorization',
  'account.create': 'authorization',
  'account.disable': 'authorization',
  'account.restore': 'authorization',
  'account.role': 'authorization',
  'capability.guest.issue': 'authorization',
  'capability.output.issue': 'authorization',
  'capability.revoke': 'authorization',
  'authorization.refuse': 'authorization',
  'settings.update': 'settings',
  'content.change': 'content',
  'service.create': 'content',
  'service.duplicate': 'content',
  'service.schedule': 'content',
  'service.archive': 'content',
  'service.edit': 'content',
  'service.transition': 'content',
  'service.item.add': 'content',
  'service.item.remove': 'content',
  'service.item.enable': 'content',
  'service.item.disable': 'content',
  'service.item.duplicate': 'content',
  'service.item.reorder': 'content',
  'service.item.revise': 'content',
  'presentation.run': 'presentation',
  'readiness.override': 'presentation',
  'backup.run': 'backup',
  'restore.run': 'restore',
};

/** Whether the thing the actor asked for happened. A refusal is recorded exactly as an allowance is. */
export type AuditOutcome = 'allowed' | 'refused';

export interface AuditEntry {
  readonly action: AuditAction;
  /** What was acted on: an actor, a handle that was asked for, a service. Never a secret. */
  readonly subject: string;
  readonly outcome: AuditOutcome;
  /** Why, for a person reading the trail later. Never a secret. */
  readonly detail?: string;
}

export interface AuditTrail {
  /** Appends one entry and answers with its identifier. */
  record(context: unknown, entry: AuditEntry): Promise<string>;
}

export interface AuditOptions {
  readonly now: () => string;
  readonly newId?: () => string;
}

const ID_BYTES = 12;

export function auditOn(db: RepositoryDb, options: AuditOptions): AuditTrail {
  const newId = options.newId ?? ((): string => randomBytes(ID_BYTES).toString('base64url'));
  const events = repositoriesOn(db).auditEvents;
  const trail: AuditTrail = {
    async record(context, entry) {
      if (!AUDIT_ACTIONS.includes(entry.action)) {
        // A record class refuses a field it does not declare; this refuses an action, for the same reason.
        throw new RepositoryError('schema', `auditEvents: ${entry.action} is not an action the trail declares`);
      }
      // `append` proves the context before anything is written, and writes `actor` and `correlationId`
      // from it rather than from the caller, so the entry cannot be filed under another name.
      const checked = context as RequestContext;
      return events.append(context, {
        _id: `audit:${newId()}`,
        actor: checked.actor,
        correlationId: checked.correlationId,
        at: options.now(),
        action: entry.action,
        subject: entry.subject,
        outcome: entry.outcome,
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      });
    },
  };
  return Object.freeze(trail);
}

/** The context the server writes its own trail under: able to append an entry, and to do nothing else. */
export function auditContext(actor: string, correlationId: string): RequestContext {
  return requestContext({ actor, permissions: [permissionsFor('auditEvents').append], correlationId });
}
