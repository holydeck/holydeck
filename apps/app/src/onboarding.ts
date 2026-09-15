// The first run, and the one request that closes a door behind itself.
//
// Requirement IDEN-01: a fresh instance is claimed once, by the administrator who installs it. Until
// that happens the route is reachable by anyone who can reach the deployment, because there is no
// account yet to prove anything with — which is why it is the single entry in the session guard's
// `UNGUARDED` list, and why it must stop existing the moment it has been used.
//
// Once claimed it answers not-found, in the same words a path this server never served answers with. A
// forbidden would be an answer too: it would tell an unauthenticated caller that this deployment is
// installed and in use, which is exactly what a caller with no business here is trying to find out. So
// would a validation problem, and that one is the cheapest of all to ask for — it takes no handle and no
// password to post an empty body. Nothing a claimed instance is sent is graded: it is answered.

import { ONBOARDING_PATH, actorFor, onboardingOffer, parseInstanceClaim } from '@holydeck/contracts/accounts';
import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { isSameOrigin } from '@holydeck/contracts/sessions';

import { AccountError, accountContext } from './accounts.js';
import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { originOf, refuseAsForbidden } from './csrf.js';
import { notFound } from './failures.js';

import type { AccountStore } from './accounts.js';
import type { AttemptGate } from './attempts.js';
import type { AuditEntry, AuditTrail } from './audit.js';
import type { PasskeyStore } from './passkeys.js';
import type { TotpStore } from './totp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * What an instance needs to know who anybody is: somewhere to keep the accounts, somewhere to record what
 * was done about them, the gate that counts what has been tried against them, and the second factors an
 * account may owe. Built once and handed to every surface that answers for an identity; a first run uses
 * two of the four, and signing in uses all of them.
 */
export interface Identity {
  readonly accounts: AccountStore;
  readonly audit: AuditTrail;
  readonly attempts: AttemptGate;
  readonly totp: TotpStore;
  readonly passkeys: PasskeyStore;
}

export interface OnboardingOptions {
  /** Absent in a deployment that keeps no accounts. The route is served either way, and answers not-found. */
  readonly identity: Identity | undefined;
}

const CLAIM_PREFIX = 'claim:';

const REFUSED_ELSEWHERE = 'a first run is claimed from this deployment’s own pages, or from a terminal';

/** What the trail calls an attempt whose body named nothing readable. Still an attempt, still recorded. */
const NO_HANDLE = '(no handle)';

const gone = (request: FastifyRequest, reply: FastifyReply): FastifyReply => reply.code(404).send(notFound(request));

export function serveOnboarding(app: FastifyInstance, { identity }: OnboardingOptions): void {
  // Safe, so it is not behind the guard and does not need to be in `UNGUARDED`. It is also the only
  // place the bounds a password has to meet are published, so a client never has to hard-code them.
  app.get(ONBOARDING_PATH, async (request, reply) => {
    if (identity === undefined) return gone(request, reply);
    const correlation = correlationFor(CLAIM_PREFIX, request.id);
    if (await identity.accounts.claimed(accountContext(correlation))) return gone(request, reply);
    return successEnvelope(onboardingOffer(), request.id, CLIENT_WINDOW.current);
  });

  app.post(ONBOARDING_PATH, async (request, reply) => {
    if (identity === undefined) return gone(request, reply);
    const correlation = correlationFor(CLAIM_PREFIX, request.id);

    // The trail records what happened; it is not a condition of it. An entry that could not be written is
    // a defect worth waking someone for, and it is logged as one — but an account that exists has to be
    // answered as created, or the administrator claims again and is refused as the second claimant.
    const note = async (actor: string, entry: AuditEntry): Promise<void> => {
      try {
        await identity.audit.record(auditContext(actor, correlation), entry);
      } catch (error: unknown) {
        request.log.error({ err: error }, 'the first-run trail refused an entry');
      }
    };

    // Read before anything is decided, and never answered with: a body that is not a claim still names
    // the attempt in the trail, and a claimed instance grades nothing at all.
    const claim = parseInstanceClaim(request.body);

    // Asked here only to decide what to answer, which is why it is allowed to be out of date. Who claimed
    // the instance is still settled by the write below — two claims arriving together is precisely when
    // this question answers "no" twice, and the loser is answered from the same place for the same reason.
    if (await identity.accounts.claimed(accountContext(correlation))) {
      await note('system', {
        action: 'instance.claim',
        subject: claim.ok ? claim.value.name : NO_HANDLE,
        outcome: 'refused',
        detail: 'this instance has been claimed already',
      });
      return gone(request, reply);
    }

    // A missing origin is allowed where the guard would refuse it: an installer claiming an instance from
    // a terminal sends none, and there is no session here for a foreign page to ride on in any case. An
    // origin that is present and belongs to someone else is still refused — that one is a browser.
    const origin = request.headers.origin;
    if (origin !== undefined && !isSameOrigin(origin, originOf(request))) {
      await refuseAsForbidden(request, reply, 'origin', REFUSED_ELSEWHERE);
      return reply;
    }

    if (!claim.ok) return reply.code(422).send(validationFailure(request.id, claim.problems));

    try {
      const account = await identity.accounts.claim(accountContext(correlation), claim.value);
      await note(actorFor(account.id), { action: 'instance.claim', subject: account.name, outcome: 'allowed' });
      return reply.code(201).send(successEnvelope(account, request.id, CLIENT_WINDOW.current));
    } catch (error: unknown) {
      // Recorded before it is answered: the answer says nothing happened, so the trail is the only place
      // an administrator can see that someone tried, and under which handle.
      if (error instanceof AccountError && error.kind === 'claimed') {
        await note('system', {
          action: 'instance.claim',
          subject: claim.value.name,
          outcome: 'refused',
          detail: 'this instance has been claimed already',
        });
        return gone(request, reply);
      }
      throw error;
    }
  });
}
