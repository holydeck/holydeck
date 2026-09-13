// The surface a second factor is enrolled, proved, replaced and given up through.
//
// Requirement IDEN-03: every route here is behind the session guard, because every one of them changes
// something about an account that has already proved who it is. That is what separates this file from
// `session-routes.ts`: signing in must not say which half of a sign-in was wrong, while a caller holding
// a session has already proved they are the account they are asking about, and telling them plainly that
// nothing is enrolled — or that something already is — costs nothing and saves them a support call.
//
// What is still never said, to anybody: a secret leaves this server once, in the answer to the request
// that drew it, and a set of recovery codes leaves it once, in the answer to the request that drew those.
// After that the store holds a digest of each, the trail holds neither, and no route here reads one back.

import { accountIdIn } from '@holydeck/contracts/accounts';
import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import {
  TOTP_PATH,
  TOTP_RECOVERY_PATH,
  TOTP_VERIFICATION_PATH,
  otpauthUri,
  parseSecondFactor,
} from '@holydeck/contracts/totp';

import { accountContext } from './accounts.js';
import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession, refuseAsForbidden } from './csrf.js';
import { notFound } from './failures.js';
import { TotpError, totpContext } from './totp.js';

import type { AuditAction } from './audit.js';
import type { Identity } from './onboarding.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** A code that did not match: a wrong digit, a code already spent, and a code for nothing, in one answer. */
export const TOTP_REFUSED = 'auth.totp_refused';

/** Enrolling over a factor this account has already proved, which is a request aimed at the wrong state. */
export const TOTP_ENROLLED = 'auth.totp_enrolled';

/** Asking something of a factor that is not there. The same disagreement, from the other direction. */
export const TOTP_MISSING = 'auth.totp_missing';

const REFUSED_MESSAGE = 'That code was not this account’s second factor.';

const ENROLLED_MESSAGE = 'This account already has a second factor. Give the current one up before enrolling another.';

const MISSING_MESSAGE = 'This account has no second factor to do that to.';

const NOT_AN_ACCOUNT = 'a second factor belongs to an account, and this session is not held by one';

const TOTP_PREFIX = 'totp:';

export interface TotpRoutesOptions {
  /** Absent in a deployment that keeps no accounts, which has no second factors either. */
  readonly identity: Identity | undefined;
}

/** Every route this module serves, in the order it registers them, and what each of them changes. */
const ROUTES = [
  ['POST', TOTP_PATH],
  ['POST', TOTP_VERIFICATION_PATH],
  ['POST', TOTP_RECOVERY_PATH],
  ['DELETE', TOTP_PATH],
] as const;

export function serveTotpRoutes(app: FastifyInstance, { identity }: TotpRoutesOptions): void {
  // A deployment with nowhere to keep an account has no second factors to enrol or give up, and says so
  // where a path that was never served says it. The paths are still registered, so the guard still counts
  // them among the changes it covers rather than leaving four holes that appear only in some deployments.
  if (identity === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({ method, url, handler: (request, reply) => reply.code(404).send(notFound(request)) });
    }
    return;
  }

  /**
   * Who is asking, once. A session says which account it is for and the guard has already proved the
   * session; what is left is that the actor names an account at all, which a service's session does not.
   */
  const asker = async (request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> => {
    const id = accountIdIn(provenSession(request).record.actor);
    if (id === undefined) await refuseAsForbidden(request, reply, 'actor', NOT_AN_ACCOUNT);
    return id;
  };

  /**
   * Written after the change, and logged rather than answered when the trail refuses it: an operator who
   * enrolled a second factor has one, whether or not this server managed to write that down.
   */
  const note = async (
    request: FastifyRequest,
    actor: string,
    action: AuditAction,
    outcome: 'allowed' | 'refused',
  ): Promise<void> => {
    try {
      await identity.audit.record(auditContext(actor, correlationFor(TOTP_PREFIX, request.id)), {
        action,
        subject: actor,
        outcome,
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the second factor trail refused an entry');
    }
  };

  const refuse = (request: FastifyRequest, reply: FastifyReply, code: string, message: string): FastifyReply =>
    reply.code(code === TOTP_REFUSED ? 401 : 409).send(errorEnvelope(code, message, request.id));

  /** A disagreement about state is answered; anything else the store refuses is this server's defect. */
  const stateRefusal = (error: unknown, kind: 'state' | 'duplicate'): boolean =>
    error instanceof TotpError && error.kind === kind;

  app.post(TOTP_PATH, async (request, reply) => {
    const id = await asker(request, reply);
    if (id === undefined) return reply;
    const correlation = correlationFor(TOTP_PREFIX, request.id);
    // The handle rather than the identifier: an authenticator shows the label to whoever opens it, and
    // an account is recognised there by the name it signs in under.
    const account = await identity.accounts.read(accountContext(correlation), id);
    if (account === undefined) {
      await refuseAsForbidden(request, reply, 'actor', NOT_AN_ACCOUNT);
      return reply;
    }
    let enrolment;
    try {
      enrolment = await identity.totp.enroll(totpContext(correlation), id);
    } catch (error: unknown) {
      if (stateRefusal(error, 'duplicate')) return refuse(request, reply, TOTP_ENROLLED, ENROLLED_MESSAGE);
      throw error;
    }
    await note(request, provenSession(request).record.actor, 'totp.enroll', 'allowed');
    return reply
      .code(201)
      .send(
        successEnvelope(
          { secret: enrolment.secret, uri: otpauthUri({ secret: enrolment.secret, name: account.name }) },
          request.id,
          CLIENT_WINDOW.current,
        ),
      );
  });

  app.post(TOTP_VERIFICATION_PATH, async (request, reply) => {
    const id = await asker(request, reply);
    if (id === undefined) return reply;
    const presented = parseSecondFactor(request.body);
    if (!presented.ok) return reply.code(422).send(validationFailure(request.id, presented.problems));
    const correlation = correlationFor(TOTP_PREFIX, request.id);
    let codes;
    try {
      codes = await identity.totp.verify(totpContext(correlation), id, presented.value.code);
    } catch (error: unknown) {
      if (stateRefusal(error, 'state')) return refuse(request, reply, TOTP_MISSING, MISSING_MESSAGE);
      throw error;
    }
    const actor = provenSession(request).record.actor;
    await note(request, actor, 'totp.verify', codes === undefined ? 'refused' : 'allowed');
    if (codes === undefined) return refuse(request, reply, TOTP_REFUSED, REFUSED_MESSAGE);
    return reply.send(successEnvelope({ recoveryCodes: codes }, request.id, CLIENT_WINDOW.current));
  });

  app.post(TOTP_RECOVERY_PATH, async (request, reply) => {
    const id = await asker(request, reply);
    if (id === undefined) return reply;
    const correlation = correlationFor(TOTP_PREFIX, request.id);
    let codes;
    try {
      codes = await identity.totp.regenerate(totpContext(correlation), id);
    } catch (error: unknown) {
      if (stateRefusal(error, 'state')) return refuse(request, reply, TOTP_MISSING, MISSING_MESSAGE);
      throw error;
    }
    await note(request, provenSession(request).record.actor, 'totp.regenerate', 'allowed');
    return reply.send(successEnvelope({ recoveryCodes: codes }, request.id, CLIENT_WINDOW.current));
  });

  app.delete(TOTP_PATH, async (request, reply) => {
    const id = await asker(request, reply);
    if (id === undefined) return reply;
    const revoked = await identity.totp.revoke(totpContext(correlationFor(TOTP_PREFIX, request.id)), id);
    await note(request, provenSession(request).record.actor, 'totp.revoke', revoked ? 'allowed' : 'refused');
    return reply.send(successEnvelope({ revoked }, request.id, CLIENT_WINDOW.current));
  });
}
