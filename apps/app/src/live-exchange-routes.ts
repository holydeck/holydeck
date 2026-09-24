// Where a Guest's join token or an output window's capability is traded in for the two tickets OUT-01
// describes: a socket ticket the connection upgrade spends once, and a read ticket good for as long as
// the capability it was minted from. Public, the same as sign-in and the corpus proxy: neither caller
// ever holds a session to prove — a Guest is nobody, and an output window opens from a link — so there is
// no origin or CSRF token to ask for either. What stands in for that guard is this file's own per-IP rate
// limit, the same defence `corpus-proxy-routes.ts` keeps for the same reason.
//
// `expiresAt` on the answer is the capability's own expiry, not the socket ticket's thirty seconds
// (`live-tickets.ts`'s `MintedLiveTickets.expiresAt`): the read ticket rides on the capability for as
// long as it is good, and telling a caller its whole exchange dies in thirty seconds would be wrong.

import rateLimit from '@fastify/rate-limit';

import { errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import {
  GUEST_EXCHANGE_PATH,
  OUTPUT_EXCHANGE_PATH,
  parseGuestExchangeBody,
  parseOutputExchangeBody,
} from '@holydeck/contracts/live';

import { auditContext } from './audit.js';
import { tokenDigest } from './capabilities.js';
import { correlationFor } from './context.js';
import { refuseAsForbidden } from './csrf.js';
import { notFound, unexpectedFailure } from './failures.js';
import { GuestJoinError, admitGuest, admitOutput } from './guest-join.js';

import type { AuditAction, AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { CapabilityStore } from './capabilities.js';
import type { LiveTicketStore } from './live-tickets.js';
import type { Identity } from './onboarding.js';
import type { ServiceStore } from './services.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export { GUEST_EXCHANGE_PATH, OUTPUT_EXCHANGE_PATH };

const LIVE_EXCHANGE_PREFIX = 'liveExchange:';

const PUBLIC: RouteNeed = { kind: 'public' };

/** Every route this module serves, in the order it registers them. */
const ROUTES = [
  ['POST', GUEST_EXCHANGE_PATH],
  ['POST', OUTPUT_EXCHANGE_PATH],
] as const;

// Generous enough for a normal reconnect storm (a Guest's phone waking up, an output window reloading)
// while still bounding how many capability redemptions one caller can force this server to check inside
// a minute — the same 10/min corpus-proxy-routes.ts's own render route keeps, for the same reason: this
// is the only defence a session-less route has.
const EXCHANGE_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

export interface LiveExchangeRoutesOptions {
  /** Absent in a deployment that keeps no capabilities, which has nothing here to redeem. */
  readonly capabilities: CapabilityStore | undefined;
  readonly services: ServiceStore | undefined;
  readonly liveTickets: LiveTicketStore | undefined;
  /** Absent audit-writing is best-effort everywhere else in this server, and this surface is no different. */
  readonly identity: Identity | undefined;
}

/**
 * Registers the two exchange routes, or a 404 stub for both where this deployment keeps no capabilities,
 * services or tickets to redeem against — the same shape `capability-routes.ts` uses so the guard's table
 * remains the complete surface of the application in every deployment.
 */
export function serveLiveExchangeRoutes(
  app: FastifyInstance,
  { capabilities, services, liveTickets, identity }: LiveExchangeRoutesOptions,
): void {
  if (capabilities === undefined || services === undefined || liveTickets === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({
        method,
        url,
        config: { need: PUBLIC },
        handler: (request, reply) => reply.code(404).send(notFound(request)),
      });
    }
    return;
  }

  /**
   * Written after the exchange, and logged rather than answered when the trail refuses it: an exchange
   * that succeeded or was refused holds that, whether or not this server managed to write it down.
   * `subject` is always the capability's own digest — traceable back to `capability-routes.ts`'s own
   * issue entry — never the token, and never a name for whoever redeemed it: there is none to hold.
   */
  const note = async (
    request: FastifyRequest,
    subject: string,
    outcome: AuditOutcome,
    action: AuditAction,
    detail: string,
  ): Promise<void> => {
    if (identity === undefined) return;
    try {
      await identity.audit.record(auditContext('system', correlationFor(LIVE_EXCHANGE_PREFIX, request.id)), {
        action,
        subject,
        outcome,
        detail,
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the live exchange trail refused an entry');
    }
  };

  void app.register(rateLimit, { global: false });

  void app.register(async (scoped) => {
    scoped.setErrorHandler((error, request, reply) => {
      if ((error as { statusCode?: unknown }).statusCode === 429) {
        return reply
          .code(429)
          .send(errorEnvelope('live.exchange_rate_limited', 'too many exchanges, try again shortly', request.id));
      }
      request.log.error(error);
      return reply.code(500).send(unexpectedFailure(request.id));
    });

    scoped.post(GUEST_EXCHANGE_PATH, { config: { need: PUBLIC, rateLimit: EXCHANGE_RATE_LIMIT } }, async (request, reply) => {
      const parsed = parseGuestExchangeBody(request.body);
      if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
      const correlationId = correlationFor(LIVE_EXCHANGE_PREFIX, request.id);
      try {
        const grant = await admitGuest(capabilities, services, correlationId, {
          token: parsed.value.token,
          service: parsed.value.service,
          view: 'audience',
        });
        const minted = liveTickets.mint({
          capabilityId: grant.capabilityId,
          kind: 'guest',
          service: parsed.value.service,
          view: 'audience',
          capabilityExpiresAt: grant.capabilityExpiresAt,
        });
        await note(request, grant.capabilityId, 'allowed', 'live.guest.exchange', `exchanged for service ${parsed.value.service}`);
        return reply.send(
          successEnvelope(
            { socketTicket: minted.socketTicket, readTicket: minted.readTicket, view: 'audience' as const, expiresAt: grant.capabilityExpiresAt },
            request.id,
          ),
        );
      } catch (error: unknown) {
        if (error instanceof GuestJoinError) {
          await note(request, tokenDigest(parsed.value.token), 'refused', 'live.guest.exchange', error.message);
          await refuseAsForbidden(
            request,
            reply,
            'token',
            error.kind === 'capability' ? 'that capability could not be redeemed' : error.message,
          );
          return reply;
        }
        throw error;
      }
    });

    scoped.post(OUTPUT_EXCHANGE_PATH, { config: { need: PUBLIC, rateLimit: EXCHANGE_RATE_LIMIT } }, async (request, reply) => {
      const parsed = parseOutputExchangeBody(request.body);
      if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
      const correlationId = correlationFor(LIVE_EXCHANGE_PREFIX, request.id);
      try {
        const grant = await admitOutput(capabilities, correlationId, {
          token: parsed.value.token,
          service: parsed.value.service,
          view: parsed.value.view,
        });
        const minted = liveTickets.mint({
          capabilityId: grant.capabilityId,
          kind: 'output',
          service: parsed.value.service,
          view: parsed.value.view,
          capabilityExpiresAt: grant.capabilityExpiresAt,
        });
        await note(
          request,
          grant.capabilityId,
          'allowed',
          'live.output.exchange',
          `exchanged for service ${parsed.value.service}, ${parsed.value.view} view`,
        );
        return reply.send(
          successEnvelope(
            { socketTicket: minted.socketTicket, readTicket: minted.readTicket, view: parsed.value.view, expiresAt: grant.capabilityExpiresAt },
            request.id,
          ),
        );
      } catch (error: unknown) {
        if (error instanceof GuestJoinError) {
          await note(request, tokenDigest(parsed.value.token), 'refused', 'live.output.exchange', error.message);
          await refuseAsForbidden(
            request,
            reply,
            'token',
            error.kind === 'capability' ? 'that capability could not be redeemed' : error.message,
          );
          return reply;
        }
        throw error;
      }
    });
  });
}
