// The live socket: the endpoint a client reaches, and everything that is true of a connection rather
// than of the protocol it carries. The handshake a browser can actually prove, the version it declared
// in the only place a browser socket can declare one, the channel it asked for — and then the socket is
// handed to `live-protocol.ts`, which owns the session itself: what it may watch, what it may command,
// what it is caught up with after a drop, and when it has stopped being a connection worth writing to.
//
// The split is on purpose. Everything in the protocol is worth testing without a network in the way, and
// everything here is only true with one.

import { decideClient } from '@holydeck/contracts/clients';
import { LIVE_CHANNELS, LIVE_CLOSE, type LiveChannel } from '@holydeck/contracts/live';
import { TICKET_QUERY, isSameOrigin } from '@holydeck/contracts/sessions';
import websocket from '@fastify/websocket';

import { grantFor, liveHub } from './live-protocol.js';
import { originOf, refuseAsForbidden, refuseAsStoreSaid, sessionCallFor, sessionFor } from './csrf.js';
import { SessionError } from './sessions.js';

import type { Guarded } from './csrf.js';
import type { LiveHubOptions, LiveTransport } from './live-protocol.js';
import type { RouteNeed } from './authorization.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionStore } from './sessions.js';

// Public to the check every other route is behind: a socket proves itself in `proveHandshake` below,
// against an origin and a ticket a WebSocket carries in no header, in an order that check depends on.
// Asking a session of it here first would run the wrong check first, and would ask it a second time.
const PUBLIC: RouteNeed = { kind: 'public' };

export const LIVE_PATH = '/api/v1/live';

export const CHANNEL_QUERY = 'channel';

/**
 * A browser WebSocket cannot set a request header, so the version a client declares on an upgrade has
 * to travel in the query string. Only on an upgrade: an ordinary request keeps one way to state it.
 */
export const CLIENT_VERSION_QUERY = 'clientVersion';

/** How often a session is asked whether it is still there, and whatever it fell behind on is drained. */
export const HEARTBEAT_MS = 15_000;

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

export interface LiveOptions extends Omit<LiveHubOptions, 'clock'> {
  /** Explicit, so a frame's time is the session's time and a test does not have to read a clock. */
  readonly clock?: () => string;
  /** Absent where a deployment keeps no sessions, and there is no ticket for a socket to be carrying. */
  readonly sessions?: SessionStore;
  /** Explicit, so a test can beat the protocol by hand instead of waiting out a real interval. */
  readonly heartbeatMs?: number;
}

/**
 * What a socket proves before it is one. A browser sets no header on a WebSocket, so the two
 * things a mutation proves in a header and a cookie are proven here in the cookie and the query string:
 * the origin the page asking was served from, and a ticket this session was issued, good once and for
 * seconds. The ticket is what appears in the URL — never the session identifier, which stays in the
 * cookie where a proxy log, a referrer and a browser history never reach it.
 *
 * Refused before the upgrade finishes rather than closed after it: a status is something a client and an
 * operator can both read, and a close code on a socket that already opened is neither.
 */
const proveHandshake =
  (sessions: SessionStore) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isSameOrigin(request.headers.origin, originOf(request))) {
      await refuseAsForbidden(request, reply, 'origin', 'a socket is opened only from this deployment’s own pages');
      return;
    }
    const ticket = queryOf(request.url, TICKET_QUERY);
    if (ticket === undefined) {
      await refuseAsForbidden(request, reply, TICKET_QUERY, 'ask this session for a ticket, and spend it here');
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
  { clock = () => new Date().toISOString(), sessions, heartbeatMs = HEARTBEAT_MS, ...limits }: LiveOptions = {},
): Promise<void> {
  await app.register(websocket);

  const hub = liveHub({ clock, ...limits });

  // Unreferenced on purpose: a heartbeat is something a running service does, never a reason for a
  // process with nothing else to do to keep running.
  const beat = setInterval(() => hub.tick(), heartbeatMs);
  beat.unref();
  app.addHook('onClose', () => {
    clearInterval(beat);
  });

  // A deployment with no sessions has nothing to prove a handshake against, and serves the socket the
  // way it serves everything else: to whoever asked. Whoever asked carries no permissions, so what they
  // reach is what a permission is not needed for — the surfaces a service is shown on, watched only.
  const proving = sessions === undefined ? {} : { preValidation: proveHandshake(sessions) };

  app.get(LIVE_PATH, { websocket: true, config: { need: PUBLIC }, ...proving }, (socket, request) => {
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

    const connection = hub.join(transportOf(socket), channel, grantFor(PROVEN.get(request)?.record.permissions ?? []));
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
