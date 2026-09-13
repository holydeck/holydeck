// The first run, and the one request that closes a door behind itself.
//
// Requirement IDEN-01: a fresh instance is claimed once, by the administrator who installs it. Until
// that happens the route is reachable by anyone who can reach the deployment, because there is no
// account yet to prove anything with — which is why it is the single entry in the session guard's
// `UNGUARDED` list, and why it must stop existing the moment it has been used.
//
// Once claimed it answers not-found, in the same words a path this server never served answers with. A
// forbidden would be an answer too: it would tell an unauthenticated caller that this deployment is
// installed and in use, which is exactly what a caller with no business here is trying to find out.

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
import type { AuditTrail } from './audit.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** What this surface needs to exist: somewhere to put the account, and somewhere to record that it was. */
export interface Identity {
  readonly accounts: AccountStore;
  readonly audit: AuditTrail;
}

export interface OnboardingOptions {
  /** Absent in a deployment that keeps no accounts. The route is served either way, and answers not-found. */
  readonly identity: Identity | undefined;
}

const CLAIM_PREFIX = 'claim:';

const REFUSED_ELSEWHERE = 'a first run is claimed from this deployment’s own pages, or from a terminal';

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

    // A missing origin is allowed where the guard would refuse it: an installer claiming an instance from
    // a terminal sends none, and there is no session here for a foreign page to ride on in any case. An
    // origin that is present and belongs to someone else is still refused — that one is a browser.
    const origin = request.headers.origin;
    if (origin !== undefined && !isSameOrigin(origin, originOf(request))) {
      await refuseAsForbidden(request, reply, 'origin', REFUSED_ELSEWHERE);
      return reply;
    }

    const claim = parseInstanceClaim(request.body);
    if (!claim.ok) return reply.code(422).send(validationFailure(request.id, claim.problems));

    const correlation = correlationFor(CLAIM_PREFIX, request.id);
    try {
      // Not preceded by a question about whether the instance is already claimed: two claims arriving
      // together is precisely when that question answers "no" twice. The write is the decision.
      const account = await identity.accounts.claim(accountContext(correlation), claim.value);
      await identity.audit.record(auditContext(actorFor(account.id), correlation), {
        action: 'instance.claim',
        subject: account.name,
        outcome: 'allowed',
      });
      return reply.code(201).send(successEnvelope(account, request.id, CLIENT_WINDOW.current));
    } catch (error: unknown) {
      // Recorded before it is answered: the answer says nothing happened, so the trail is the only place
      // an administrator can see that someone tried, and under which handle.
      if (error instanceof AccountError && error.kind === 'claimed') {
        await identity.audit.record(auditContext('system', correlation), {
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
