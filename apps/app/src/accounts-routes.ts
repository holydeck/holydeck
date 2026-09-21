// The surface Control presentation is granted to an account, or taken back from one.
//
// Requirement IDEN-06: this is the first route this server asks a permission of, rather than merely a
// proved session, and the shape every later route that administers something follows: a need declared
// once, through `config.need`, and checked once, before a handler runs at all. Granting the control is
// Admin's alone, by the operator-facing vocabulary `roles.ts` names — never by holding it already.

import {
  ACCOUNTS_PATH,
  actorFor,
  parseAccountStatus,
  parseControlGrant,
  parseCreateAccount,
  parseRoleAssignment,
} from '@holydeck/contracts/accounts';
import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { FIELD_CODES } from '@holydeck/contracts/problems';

import { AccountError, accountContext } from './accounts.js';
import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { ACCOUNTS_MANAGE } from './roles.js';
import { sessionContext } from './sessions.js';

import type { AuditAction, AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { SessionStore } from './sessions.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const ACCOUNT_PREFIX = 'account:';

/** Where one account is granted or refused Control presentation, apart from the three roles. */
const CONTROL_PATH = `${ACCOUNTS_PATH}/:id/control-presentation`;

/** Where an account is closed, without being deleted, or reopened again. */
const STATUS_PATH = `${ACCOUNTS_PATH}/:id/status`;

/** Where an account is reassigned which of the three roles it holds. */
const ROLE_PATH = `${ACCOUNTS_PATH}/:id/role`;

const PERMISSION: RouteNeed = { kind: 'permission', need: ACCOUNTS_MANAGE };

/** Every route this module serves, in the order it registers them. */
const ROUTES = [
  ['PATCH', CONTROL_PATH],
  ['POST', ACCOUNTS_PATH],
  ['PATCH', STATUS_PATH],
  ['PATCH', ROLE_PATH],
] as const;

export interface AccountRoutesOptions {
  /** Absent in a deployment that keeps no accounts, which has nothing here to administer. */
  readonly identity: Identity | undefined;
  /** Absent in a deployment that keeps no sessions, which has none left open to end. */
  readonly sessions: SessionStore | undefined;
}

export function serveAccountRoutes(app: FastifyInstance, { identity, sessions }: AccountRoutesOptions): void {
  // A deployment with nowhere to keep an account has nothing here to create or administer. Every path is
  // still served, so the guard's table remains the complete shape of the surface in every deployment.
  if (identity === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({
        method,
        url,
        config: { need: PERMISSION },
        handler: (request, reply) => reply.code(404).send(notFound(request)),
      });
    }
    return;
  }

  /**
   * Written after the change, and logged rather than answered when the trail refuses it: an account that
   * was created or administered holds that, whether or not this server managed to write it down.
   */
  const note = async (
    request: FastifyRequest,
    action: AuditAction,
    actor: string,
    subject: string,
    outcome: AuditOutcome,
    detail?: string,
  ): Promise<void> => {
    try {
      await identity.audit.record(auditContext(actor, correlationFor(ACCOUNT_PREFIX, request.id)), {
        action,
        subject,
        outcome,
        ...(detail === undefined ? {} : { detail }),
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the account trail refused an entry');
    }
  };

  // THR-01: a privilege changed server-side is not one a session already open should keep acting on. This
  // ends every session that account holds rather than reaching into one to hand it fresher permissions, so
  // the next request under the old identifier finds no session at all instead of a silently patched one.
  const revoked = async (request: FastifyRequest, id: string): Promise<void> => {
    if (sessions === undefined) return;
    try {
      await sessions.revokeAllFor(sessionContext(correlationFor(ACCOUNT_PREFIX, request.id)), actorFor(id));
    } catch (error: unknown) {
      request.log.error({ err: error }, 'a privilege change could not end that account’s open sessions');
    }
  };

  app.patch(CONTROL_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseControlGrant(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = (request.params as { readonly id: string }).id;
    const updated = await identity.accounts.grantControl(
      accountContext(correlationFor(ACCOUNT_PREFIX, request.id)),
      id,
      parsed.value.granted,
    );
    // Nothing an id nobody holds could have been granted or refused: this answers the lookup that failed,
    // not a decision about Control presentation, so it is not one the trail has anything to say about.
    if (updated === undefined) return reply.code(404).send(notFound(request));
    await revoked(request, id);
    await note(request, 'account.control', provenSession(request).record.actor, actorFor(id), 'allowed');
    return reply.send(successEnvelope(updated, request.id, CLIENT_WINDOW.current));
  });

  app.post(ACCOUNTS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseCreateAccount(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    try {
      const created = await identity.accounts.create(
        accountContext(correlationFor(ACCOUNT_PREFIX, request.id)),
        parsed.value,
      );
      await note(request, 'account.create', provenSession(request).record.actor, actorFor(created.id), 'allowed');
      return reply.code(201).send(successEnvelope(created, request.id, CLIENT_WINDOW.current));
    } catch (error) {
      // A name already in use is exactly the same category of user-correctable problem as any other field
      // validation failure — answered the same way, rather than inventing a new status code for it.
      if (error instanceof AccountError && error.kind === 'duplicate') {
        return reply.code(422).send(
          validationFailure(request.id, [
            { path: 'name', code: FIELD_CODES.notAllowed, message: 'this name is already used by another account' },
          ]),
        );
      }
      throw error;
    }
  });

  app.patch(STATUS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseAccountStatus(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = (request.params as { readonly id: string }).id;
    const call = accountContext(correlationFor(ACCOUNT_PREFIX, request.id));
    let updated;
    try {
      updated = parsed.value.disabled
        ? await identity.accounts.disable(call, id)
        : await identity.accounts.restore(call, id);
    } catch (error: unknown) {
      if (!(error instanceof AccountError) || error.kind !== 'state') throw error;
      await note(request, 'account.disable', provenSession(request).record.actor, actorFor(id), 'refused');
      return reply.code(422).send(validationFailure(request.id, [
        { path: 'status.disabled', code: FIELD_CODES.notAllowed, message: error.message },
      ]));
    }
    if (updated === undefined) return reply.code(404).send(notFound(request));
    // A closed account has nothing left to reopen a session with; a reopened one asks for a fresh sign-in
    // rather than inheriting whatever slot happened to survive its closing.
    if (parsed.value.disabled) await revoked(request, id);
    // Two distinct actions, not one, so a reader of the trail sees which direction happened without
    // reading a detail field.
    const action: AuditAction = parsed.value.disabled ? 'account.disable' : 'account.restore';
    await note(request, action, provenSession(request).record.actor, actorFor(id), 'allowed');
    return reply.send(successEnvelope(updated, request.id, CLIENT_WINDOW.current));
  });

  app.patch(ROLE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseRoleAssignment(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = (request.params as { readonly id: string }).id;
    let updated;
    try {
      updated = await identity.accounts.assignRole(
        accountContext(correlationFor(ACCOUNT_PREFIX, request.id)),
        id,
        parsed.value.role,
      );
    } catch (error: unknown) {
      if (!(error instanceof AccountError) || error.kind !== 'state') throw error;
      await note(request, 'account.role', provenSession(request).record.actor, actorFor(id), 'refused');
      return reply.code(422).send(validationFailure(request.id, [
        { path: 'roleAssignment.role', code: FIELD_CODES.notAllowed, message: error.message },
      ]));
    }
    if (updated === undefined) return reply.code(404).send(notFound(request));
    await revoked(request, id);
    // The action name alone does not say which role was assigned, so the detail names it.
    await note(
      request,
      'account.role',
      provenSession(request).record.actor,
      actorFor(id),
      'allowed',
      `now ${parsed.value.role}`,
    );
    return reply.send(successEnvelope(updated, request.id, CLIENT_WINDOW.current));
  });
}
