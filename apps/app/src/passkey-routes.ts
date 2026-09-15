// The surface a passkey is registered, listed, renamed and given up through.
//
// Requirement IDEN-04: every changing route here is behind the session guard, because a passkey is
// bound to an account that has already proved who it is. Registration still has a ceremony in the
// middle: this route draws the challenge, spends only the one this server issued for this account, and
// then hands the browser's answer to `webauthn.ts`, which is the only place the WebAuthn library lives.
//
// What never leaves here is the material a later assertion is checked with. A list says what a person
// needs to tell devices apart; the public key and counter stay in the store, and the audit trail carries
// the credential identifier rather than the key, signature or challenge.

import { accountIdIn } from '@holydeck/contracts/accounts';
import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import {
  PASSKEY_OPTIONS_PATH,
  PASSKEY_PATH,
  parsePasskeyName,
  parsePasskeyRegistration,
} from '@holydeck/contracts/webauthn';

import { accountContext } from './accounts.js';
import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { originOf, provenSession, refuseAsForbidden } from './csrf.js';
import { notFound } from './failures.js';
import { PasskeyError, passkeyContext } from './passkeys.js';
import { challengeIn, registrationOptions, verifiedRegistration } from './webauthn.js';

import type { AuditAction, AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { StoredPasskey } from './passkeys.js';
import type { RelyingParty } from './webauthn.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const SESSION: RouteNeed = { kind: 'session' };

/** A ceremony that did not prove a key this server asked for. */
export const PASSKEY_REFUSED = 'auth.passkey_refused';

/** A key this deployment already holds, even when another account asked to keep it. */
export const PASSKEY_REGISTERED = 'auth.passkey_registered';

/** The account already holds as many keys as the contract allows it to distinguish. */
export const PASSKEY_LIMIT_REACHED = 'auth.passkey_limit';

const REFUSED_MESSAGE = 'That passkey ceremony was not one this account could accept.';

const REGISTERED_MESSAGE = 'This passkey is already registered.';

const LIMIT_MESSAGE = 'This account already holds the maximum number of passkeys.';

const NOT_AN_ACCOUNT = 'a passkey belongs to an account, and this session is not held by one';

const PASSKEY_PREFIX = 'passkey:';

export interface PasskeyRoutesOptions {
  /** Absent in a deployment that keeps no accounts, which has no passkeys either. */
  readonly identity: Identity | undefined;
}

/** Every route this module serves, in the order it registers them, and what each of them changes. */
const ROUTES = [
  ['POST', PASSKEY_OPTIONS_PATH],
  ['POST', PASSKEY_PATH],
  ['GET', PASSKEY_PATH],
  ['PATCH', `${PASSKEY_PATH}/:id`],
  ['DELETE', `${PASSKEY_PATH}/:id`],
] as const;

const summaryOf = (passkey: StoredPasskey) => ({
  id: passkey.id,
  name: passkey.name,
  registeredAt: passkey.registeredAt,
  ...(passkey.lastUsedAt === undefined ? {} : { lastUsedAt: passkey.lastUsedAt }),
  transports: passkey.transports,
  synced: passkey.synced,
});

const partyOf = (request: FastifyRequest): RelyingParty => {
  const host = String(request.headers.host).replace(/:\d+$/u, '');
  return { id: host, origin: originOf(request) };
};

const refuse = (request: FastifyRequest, reply: FastifyReply, code: string, message: string): FastifyReply =>
  reply.code(code === PASSKEY_REFUSED ? 401 : 409).send(errorEnvelope(code, message, request.id));

export function servePasskeyRoutes(app: FastifyInstance, { identity }: PasskeyRoutesOptions): void {
  // A deployment with nowhere to keep an account has no passkeys to manage. The paths are still served,
  // so the guard's table remains the complete shape of the surface in every deployment.
  if (identity === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({
        method,
        url,
        config: { need: SESSION },
        handler: (request, reply) => reply.code(404).send(notFound(request)),
      });
    }
    return;
  }

  /**
   * Who is asking, after a session has been proven. A service may hold a session, but it has no passkey
   * list because there is no account for a browser to bind a credential to.
   */
  const asker = async (request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> => {
    const id = accountIdIn(provenSession(request).record.actor);
    if (id === undefined) await refuseAsForbidden(request, reply, 'actor', NOT_AN_ACCOUNT);
    return id;
  };

  /**
   * Written after the route has enough of a credential to name what happened. The trail refusing an
   * entry does not change whether the key exists, so it is logged for an operator rather than answered.
   */
  const note = async (
    request: FastifyRequest,
    actor: string,
    action: AuditAction,
    subject: string,
    outcome: AuditOutcome,
    detail?: string,
  ): Promise<void> => {
    try {
      await identity.audit.record(auditContext(actor, correlationFor(PASSKEY_PREFIX, request.id)), {
        action,
        subject,
        outcome,
        ...(detail === undefined ? {} : { detail }),
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the passkey trail refused an entry');
    }
  };

  const accountFor = async (request: FastifyRequest, reply: FastifyReply, id: string) => {
    const account = await identity.accounts.read(accountContext(correlationFor(PASSKEY_PREFIX, request.id)), id);
    if (account === undefined) await refuseAsForbidden(request, reply, 'actor', NOT_AN_ACCOUNT);
    return account;
  };

  app.post(PASSKEY_OPTIONS_PATH, { config: { need: SESSION } }, async (request, reply) => {
    const id = await asker(request, reply);
    if (id === undefined) return reply;
    const account = await accountFor(request, reply, id);
    if (account === undefined) return reply;
    const context = passkeyContext(correlationFor(PASSKEY_PREFIX, request.id));
    const [challenge, existing] = await Promise.all([
      identity.passkeys.challenge(context, 'registration', id),
      identity.passkeys.list(context, id),
    ]);
    return successEnvelope(
      await registrationOptions({ party: partyOf(request), account, existing, challenge }),
      request.id,
      CLIENT_WINDOW.current,
    );
  });

  app.post(PASSKEY_PATH, { config: { need: SESSION } }, async (request, reply) => {
    const id = await asker(request, reply);
    if (id === undefined) return reply;
    const parsed = parsePasskeyRegistration(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const actor = provenSession(request).record.actor;
    const challenge = challengeIn(parsed.value.credential.clientDataJSON);
    if (challenge === undefined) {
      await note(request, actor, 'passkey.register', parsed.value.credential.id, 'refused', 'no readable challenge');
      return refuse(request, reply, PASSKEY_REFUSED, REFUSED_MESSAGE);
    }
    const context = passkeyContext(correlationFor(PASSKEY_PREFIX, request.id));
    const spent = await identity.passkeys.spend(context, 'registration', challenge);
    if (spent?.account !== id) {
      await note(request, actor, 'passkey.register', parsed.value.credential.id, 'refused', 'challenge was not this account’s');
      return refuse(request, reply, PASSKEY_REFUSED, REFUSED_MESSAGE);
    }
    const verified = await verifiedRegistration({
      party: partyOf(request),
      challenge,
      response: parsed.value.credential,
    });
    if (!verified.ok) {
      await note(request, actor, 'passkey.register', parsed.value.credential.id, 'refused', verified.reason);
      return refuse(request, reply, PASSKEY_REFUSED, REFUSED_MESSAGE);
    }
    let passkey;
    try {
      passkey = await identity.passkeys.register(context, id, { name: parsed.value.name, ...verified.value });
    } catch (error: unknown) {
      if (error instanceof PasskeyError && error.kind === 'duplicate') {
        return refuse(request, reply, PASSKEY_REGISTERED, REGISTERED_MESSAGE);
      }
      if (error instanceof PasskeyError && error.kind === 'limit') {
        return refuse(request, reply, PASSKEY_LIMIT_REACHED, LIMIT_MESSAGE);
      }
      throw error;
    }
    await note(request, actor, 'passkey.register', passkey.id, 'allowed');
    return reply.code(201).send(successEnvelope({ passkey: summaryOf(passkey) }, request.id, CLIENT_WINDOW.current));
  });

  app.get(PASSKEY_PATH, { config: { need: SESSION } }, async (request, reply) => {
    const id = accountIdIn(provenSession(request).record.actor);
    if (id === undefined) {
      await refuseAsForbidden(request, reply, 'actor', NOT_AN_ACCOUNT);
      return reply;
    }
    const passkeys = await identity.passkeys.list(passkeyContext(correlationFor(PASSKEY_PREFIX, request.id)), id);
    return successEnvelope({ passkeys: passkeys.map(summaryOf) }, request.id, CLIENT_WINDOW.current);
  });

  app.patch(`${PASSKEY_PATH}/:id`, { config: { need: SESSION } }, async (request, reply) => {
    const id = await asker(request, reply);
    if (id === undefined) return reply;
    const parsed = parsePasskeyName(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const key = (request.params as { readonly id: string }).id;
    const renamed = await identity.passkeys.rename(
      passkeyContext(correlationFor(PASSKEY_PREFIX, request.id)),
      id,
      key,
      parsed.value.name,
    );
    if (!renamed) return reply.code(404).send(notFound(request));
    await note(request, provenSession(request).record.actor, 'passkey.name', key, 'allowed');
    return reply.send(successEnvelope({ renamed: true }, request.id, CLIENT_WINDOW.current));
  });

  app.delete(`${PASSKEY_PATH}/:id`, { config: { need: SESSION } }, async (request, reply) => {
    const id = await asker(request, reply);
    if (id === undefined) return reply;
    const key = (request.params as { readonly id: string }).id;
    const revoked = await identity.passkeys.revoke(passkeyContext(correlationFor(PASSKEY_PREFIX, request.id)), id, key);
    if (!revoked) return reply.code(404).send(notFound(request));
    await note(request, provenSession(request).record.actor, 'passkey.revoke', key, 'allowed');
    return reply.send(successEnvelope({ revoked }, request.id, CLIENT_WINDOW.current));
  });
}
