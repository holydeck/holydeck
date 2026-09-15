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
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

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
