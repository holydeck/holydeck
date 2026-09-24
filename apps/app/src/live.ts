// The live socket: the endpoint a client reaches, and everything that is true of a connection rather
// than of the protocol it carries. The handshake a browser can actually prove, the version it declared
// in the only place a browser socket can declare one, the channel it asked for — and then the socket is
// handed to `live-protocol.ts`, which owns the session itself: what it may watch, what it may command,
// what it is caught up with after a drop, and when it has stopped being a connection worth writing to.
//
// The split is on purpose. Everything in the protocol is worth testing without a network in the way, and
// everything here is only true with one.

import { CLIENT_WINDOW, decideClient } from '@holydeck/contracts/clients';
import { successEnvelope } from '@holydeck/contracts/http';
import {
  CAPABILITY_QUERY,
  CHANNEL_QUERY,
  CLIENT_VERSION_QUERY,
  LIVE_CHANNELS,
  LIVE_CLOSE,
  LIVE_CONNECTIONS_PATH,
  LIVE_PATH,
  SERVICE_QUERY,
  type LiveChannel,
} from '@holydeck/contracts/live';
import { TICKET_QUERY, isSameOrigin } from '@holydeck/contracts/sessions';
import websocket from '@fastify/websocket';

import { auditContext } from './audit.js';
import { tokenDigest } from './capabilities.js';
import { correlationFor } from './context.js';
import { unexpectedFailure } from './failures.js';
import { GuestJoinError, admitSocketTicket } from './guest-join.js';
import { grantFor } from './live-protocol.js';
import { originOf, refuseAsForbidden, refuseAsStoreSaid, sessionCallFor, sessionFor } from './csrf.js';
import { PRESENTATION_CONTROL } from './roles.js';
import { SessionError } from './sessions.js';

import type { AuditTrail } from './audit.js';
import type { CapabilityStore } from './capabilities.js';
import type { Guarded } from './csrf.js';
import type { SocketTicketAdmission } from './guest-join.js';
import type { LiveHub, LiveTransport } from './live-protocol.js';
import type { LiveTicketStore } from './live-tickets.js';
import type { RunEngine } from './run-engine.js';
import type { RouteNeed } from './authorization.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionStore } from './sessions.js';

// Public to the check every other route is behind: a socket proves itself in `proveHandshake` below,
// against an origin and a ticket a WebSocket carries in no header, in an order that check depends on.
// Asking a session of it here first would run the wrong check first, and would ask it a second time.
const PUBLIC: RouteNeed = { kind: 'public' };

// The connection-counts read (below) is Control presentation's, the same permission every other
// operator-only surface in this deployment is behind.
const PERMISSION: RouteNeed = { kind: 'permission', need: PRESENTATION_CONTROL };

// The path this route answers on, and the query names an upgrade carries — a browser WebSocket can set
// no request header, so the channel, the client version and a ticket all travel in the URL. A capability
// and the service it opens no longer do (OUT-01): their names are still read here, but only to refuse a
// socket URL that carries one. All are the contract's (`@holydeck/contracts/live`), so the client that
// opens a socket and the route that answers it name them once; re-exported here because this is where
// this application's own modules and tests have always read them from.
export { CAPABILITY_QUERY, CHANNEL_QUERY, CLIENT_VERSION_QUERY, LIVE_CONNECTIONS_PATH, LIVE_PATH, SERVICE_QUERY };

/** How often a session is asked whether it is still there, and whatever it fell behind on is drained. */
export const HEARTBEAT_MS = 5_000;
export const MAX_LIVE_PAYLOAD_BYTES = 8 * 1024;

// Only the query string is read from it, and a relative URL needs some origin to be read against.
const INTERNAL = 'http://application.invalid';

const queryOf = (url: string, name: string): string | undefined =>
  new URL(url, INTERNAL).searchParams.get(name) ?? undefined;

/** Whether the request is asking to stop being an HTTP request. */
export function isUpgrade(headers: Record<string, unknown>): boolean {
  return String(headers['upgrade'] ?? '').toLowerCase() === 'websocket';
}

/** The version a socket client declares, which for a socket is the only place it can declare it. */
export function declaredVersion(url: string): unknown {
  return queryOf(url, CLIENT_VERSION_QUERY);
}

const isChannel = (value: string | undefined): value is LiveChannel =>
  LIVE_CHANNELS.includes(value as LiveChannel);

/**
 * What the handshake proved, read back by the route handler that runs after it. Held here rather than on
 * the request, because the request-wide store is the session guard's and is written by nothing else: a
 * route that could put a session there could put any session there.
 */
const PROVEN = new WeakMap<FastifyRequest, Guarded>();

/** What a ticket an exchange minted from a capability proved for this request, read back by the route
 *  handler below — the capability counterpart to `PROVEN`, held apart because a Guest or an output window
 *  never has a `Guarded`. */
const TICKET_ADMISSION = new WeakMap<FastifyRequest, SocketTicketAdmission>();

/** Requests whose URL carried a capability token, closed by the route handler as a policy refusal. */
const URL_CAPABILITY = new WeakSet<FastifyRequest>();

export interface LiveOptions {
  readonly engine?: Pick<RunEngine, 'command'>;
  /** Built and owned by the caller (`main.ts`), never by this module: what a session may reach and how
   *  it is served does not need to know how the state it reaches was assembled. */
  readonly hub: LiveHub;
  /** Absent where a deployment keeps no sessions, and there is no ticket for a socket to be carrying. */
  readonly sessions?: SessionStore;
  /** Absent the same way, and for the same reason: with nowhere a capability is kept, no ticket was ever
   *  minted from one. Its revocations close every socket a revoked capability's ticket opened. */
  readonly capabilities?: CapabilityStore;
  /** The tickets the exchange routes mint from a capability (OUT-01) — the same store, so a ticket minted
   *  there is the one spent here. Absent where no capability is kept. */
  readonly liveTickets?: LiveTicketStore;
  /** Where a socket URL still carrying a capability token is written down. Absent where a deployment
   *  keeps no identity, and the refusal is only logged. */
  readonly audit?: AuditTrail;
  /** Explicit, so a test can beat the protocol by hand instead of waiting out a real interval. */
  readonly heartbeatMs?: number;
}

/**
 * A capability token in a socket URL is refused outright (OUT-01): a URL reaches access logs, proxy logs
 * and a browser's history, and a capability is good for as long as it was issued for. The attempt is
 * written down by the token's digest — the id an operator revokes it by — never by the token itself.
 * An audit trail that refuses the entry does not let the socket open; the handler still closes it.
 */
const noteUrlCapability = async (
  audit: AuditTrail | undefined,
  request: FastifyRequest,
  token: string,
): Promise<void> => {
  request.log.warn('a socket URL carried a capability token');
  if (audit === undefined) return;
  try {
    await audit.record(auditContext('system', correlationFor('live:', request.id)), {
      action: 'live.guest.url-capability',
      subject: tokenDigest(token),
      outcome: 'refused',
      detail: 'a capability is exchanged for a ticket, never carried in a socket URL',
    });
  } catch (error: unknown) {
    request.log.error({ err: error }, 'the live trail refused an entry');
  }
};

/**
 * What a socket proves before it is one. A browser sets no header on a WebSocket, so the two
 * things a mutation proves in a header and a cookie are proven here in the cookie and the query string:
 * the origin the page asking was served from, and a ticket good once and for seconds — either one an
 * exchange minted from a capability (OUT-01), or one this session was issued. The ticket is what appears
 * in the URL — never a capability, and never the session identifier, which stays in the cookie where a
 * proxy log, a referrer and a browser history never reach it.
 *
 * Refused before the upgrade finishes rather than closed after it: a status is something a client and an
 * operator can both read, and a close code on a socket that already opened is neither.
 */
const proveHandshake =
  (sessions: SessionStore | undefined, liveTickets: LiveTicketStore | undefined) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isSameOrigin(request.headers.origin, originOf(request))) {
      await refuseAsForbidden(request, reply, 'origin', 'a socket is opened only from this deployment’s own pages');
      return;
    }

    const ticket = queryOf(request.url, TICKET_QUERY);
    if (ticket === undefined) {
      await refuseAsForbidden(request, reply, TICKET_QUERY, 'exchange a capability or ask this session for a ticket, and spend it here');
      return;
    }

    if (liveTickets !== undefined) {
      try {
        const admission = admitSocketTicket(liveTickets, ticket, queryOf(request.url, CHANNEL_QUERY));
        if (admission !== undefined) {
          TICKET_ADMISSION.set(request, admission);
          return;
        }
      } catch (error: unknown) {
        if (error instanceof GuestJoinError) {
          request.log.warn({ err: error }, 'live socket ticket refused');
          await refuseAsForbidden(request, reply, TICKET_QUERY, 'a ticket opens one socket, within the seconds it is good for');
          return;
        }
        request.log.error(error);
        await reply.code(500).send(unexpectedFailure(request.id));
        return;
      }
    }

    if (sessions === undefined) {
      await refuseAsForbidden(request, reply, TICKET_QUERY, 'a ticket opens one socket, within the seconds it is good for');
      return;
    }

    const proven = await sessionFor(sessions, request, reply);
    if (proven === undefined) return;
    try {
      // The record the ticket was redeemed against, not the one the cookie was loaded with: a ticket names
      // the slot it was minted for, and this session runs as that slot for as long as it is open.
      const record = await proven.sessions.redeemTicket(sessionCallFor(request), proven.token, ticket);
      PROVEN.set(request, { token: proven.token, record, sessions: proven.sessions });
    } catch (error: unknown) {
      if (error instanceof SessionError && error.kind === 'ticket') {
        await refuseAsForbidden(request, reply, TICKET_QUERY, 'a ticket opens one socket, within the seconds it is good for');
        return;
      }
      await refuseAsStoreSaid(request, reply, error, 'this session ended while the socket was opening');
    }
  };

/**
 * A `ws` socket as the protocol sees it. `bufferedAmount` is the whole reason the protocol asks anything
 * of a transport at all: it is how a consumer that has stopped reading is told apart from a quiet one.
 */
const transportOf = (socket: {
  send: (text: string) => void;
  close: (code: number, reason: string) => void;
  bufferedAmount?: number;
}): LiveTransport => ({
  send: (text) => socket.send(text),
  close: (code, reason) => socket.close(code, reason),
  buffered: () => socket.bufferedAmount ?? 0,
});

export async function serveLive(
  app: FastifyInstance,
  { hub, engine, sessions, capabilities, liveTickets, audit, heartbeatMs = HEARTBEAT_MS }: LiveOptions,
): Promise<void> {
  if (engine !== undefined) hub.useCommands((member, frame) => engine.command(member, frame));
  await app.register(websocket, { options: { maxPayload: MAX_LIVE_PAYLOAD_BYTES } });

  let revocationRevision = 0;
  const admittedAt = new WeakMap<FastifyRequest, number>();
  const unsubscribe = capabilities?.onRevoked((capabilityId) => {
    revocationRevision += 1;
    hub.revokeCapability(capabilityId);
  });

  // Unreferenced on purpose: a heartbeat is something a running service does, never a reason for a
  // process with nothing else to do to keep running.
  const beat = setInterval(() => hub.tick(), heartbeatMs);
  beat.unref();
  app.addHook('onClose', () => {
    clearInterval(beat);
    unsubscribe?.();
  });

  // A deployment with neither sessions nor capabilities has nothing to prove a handshake against, and
  // serves the socket the way it serves everything else: to whoever asked. Whoever asked carries no
  // permissions, so what they reach is what a permission is not needed for — the surfaces a service is
  // shown on, watched only. Either one configured is a handshake worth proving. A capability in the URL
  // is refused by every deployment alike, including one that proves nothing, so no stale link anywhere
  // ever learns to work again.
  const guarded = sessions !== undefined || capabilities !== undefined || liveTickets !== undefined;
  const preValidation = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const smuggled = queryOf(request.url, CAPABILITY_QUERY);
    if (smuggled !== undefined) {
      URL_CAPABILITY.add(request);
      await noteUrlCapability(audit, request, smuggled);
      return;
    }
    if (!guarded) return;
    admittedAt.set(request, revocationRevision);
    await proveHandshake(sessions, liveTickets)(request, reply);
  };

  // Read-only, and behind Control presentation like every other operator-only surface: never a
  // per-connection row, only how many of each view type are open right now (spec 9.5, LIVE-06).
  app.get(LIVE_CONNECTIONS_PATH, { config: { need: PERMISSION } }, (request) =>
    successEnvelope({ counts: hub.connectionCounts() }, request.id, CLIENT_WINDOW.current),
  );

  app.get(LIVE_PATH, { websocket: true, config: { need: PUBLIC }, preValidation }, (socket, request) => {
    // Closed rather than refused with a status, so the policy code OUT-01 names is what a stale client
    // reads — and closed before anything else is read from a URL that should never have been sent.
    if (URL_CAPABILITY.has(request)) {
      socket.close(LIVE_CLOSE.refused, `${CAPABILITY_QUERY}: exchange it for a ticket; a socket URL never carries one`);
      return;
    }

    // Graded here rather than by the versioned-surface hook, for two reasons that point the same way: a
    // refused handshake tells a browser client nothing it can read, and an HTTP refusal written onto a
    // connection that asked to stop being HTTP is a socket both ends then wait on.
    const decision = decideClient(declaredVersion(request.url));
    if (!decision.accepted) {
      socket.close(
        LIVE_CLOSE.refused,
        `${CLIENT_VERSION_QUERY}: ${decision.message} — supported: ${decision.supported.join(', ')}`,
      );
      return;
    }

    const channel = queryOf(request.url, CHANNEL_QUERY);
    if (!isChannel(channel)) {
      socket.close(LIVE_CLOSE.refused, `${CHANNEL_QUERY}: must be one of ${LIVE_CHANNELS.join(', ')}`);
      return;
    }

    // A ticket minted from a capability carries the grant to join on and whether it is a Guest's — what
    // tells `connectionCounts()` a Guest apart from an ordinary Audience session, since the grant's own
    // shape does not (spec 9.5).
    const admission = TICKET_ADMISSION.get(request);
    // Any revocation during admission requires a fresh handshake; no revoked-id history is retained.
    if (admission !== undefined && admittedAt.get(request) !== revocationRevision) {
      socket.close(LIVE_CLOSE.refused, 'capability: revoked during admission');
      return;
    }
    const grant = admission?.grant ?? grantFor(PROVEN.get(request)?.record.permissions ?? []);
    const connection = hub.join(
      transportOf(socket), channel, grant, admission?.guest ?? false,
      PROVEN.get(request)?.record.actor,
    );
    if (connection === undefined) return;

    socket.on('message', (data: unknown) => {
      connection.receive(String(data));
    });
    // Whatever ended it — a client that closed, a proxy that timed out, a network that stopped being
    // one — the session is over, and the hub stops holding a place for it.
    socket.on('close', () => {
      connection.leave();
    });
  });
}
