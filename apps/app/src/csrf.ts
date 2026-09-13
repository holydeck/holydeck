// The check every request that changes something passes before it reaches a route.
//
// Three things are proven, in this order: that the request carries a session this server issued, that it
// came from this deployment's own origin, and that it returned the CSRF token that session was given
//. A cookie alone proves none of them — a browser attaches it to a request another site made.
//
// The guard is a hook rather than a decorator a route opts into, because an opt-in is a thing a route can
// forget. What it cannot cover is a route registered before it: Fastify runs a hook only for the routes
// registered after it, so `mutatingRoutesOf` reports what this guard is actually on, and a contract test
// compares that against every route the application registers.

import { ONBOARDING_PATH } from '@holydeck/contracts/accounts';
import { errorEnvelope } from '@holydeck/contracts/http';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  clearedSessionCookie,
  cookieIn,
  isSameOrigin,
  mutates,
} from '@holydeck/contracts/sessions';
import { createHash, timingSafeEqual } from 'node:crypto';

import { correlationFor } from './context.js';
import { unexpectedFailure } from './failures.js';
import { SessionError } from './sessions.js';
import { sessionContext } from './sessions.js';

import type { SessionRecord } from '@holydeck/contracts/sessions';
import type { RequestContext } from './context.js';
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import type { SessionRefusal, SessionStore } from './sessions.js';

/** Answered when there is no session to act under. The client's move is the same in every such case. */
export const SESSION_EXPIRED = 'auth.session.expired';

/** Answered when there is a session and the request still cannot be accepted from where it came from. */
export const FORBIDDEN = 'auth.forbidden';

const SIGN_IN_MESSAGE = 'Sign in again to continue.';

const REFUSED_MESSAGE = 'The request could not be accepted.';

/**
 * The mutating routes that may be reached without a session, written as `METHOD /path`. Claiming a fresh
 * instance is the one change that cannot carry a session: it is the request that creates the first
 * account there could ever be a session for. It closes for good once the instance has been claimed, and
 * the route answers not-found from then on, so this exception opens nothing after a first run.
 */
export const UNGUARDED: readonly string[] = Object.freeze([`POST ${ONBOARDING_PATH}`]);

/** What the guard proved, for the route that asked for it. A route reads this; nothing else may set it. */
export interface Guarded {
  readonly token: string;
  readonly record: SessionRecord;
  /** The store the session was proved against, so a route acts through that one and not another. */
  readonly sessions: SessionStore;
}

export interface Route {
  /** Fastify's own spelling of a method, so the list can be replayed against the application as it is. */
  readonly method: HTTPMethods;
  readonly url: string;
}

export interface GuardOptions {
  /** Absent in a deployment that keeps no sessions, which is a deployment that changes nothing. */
  readonly sessions: SessionStore | undefined;
  readonly unguarded?: readonly string[];
}

const TABLES = new WeakMap<FastifyInstance, Route[]>();

const PROVEN = new WeakMap<FastifyRequest, Guarded>();

/** Every mutating route this guard is on. An application the guard was never put on guards nothing. */
export function mutatingRoutesOf(app: FastifyInstance): readonly Route[] {
  return TABLES.get(app) ?? [];
}

/**
 * The session the guard proved for this request. A route the guard is not on has none to read, and asking
 * for one there is a defect rather than a refusal: the answer is this server's 500, never an unguarded 200.
 */
export function provenSession(request: FastifyRequest): Guarded {
  const proven = PROVEN.get(request);
  if (proven === undefined) {
    throw new Error(`${request.method} ${String(request.routeOptions.url)} is not a route the session guard is on`);
  }
  return proven;
}

/**
 * The origin the browser saw, which is not always the one this process did: behind a reverse proxy the
 * connection arrives as plain HTTP, and only the forwarded header remembers what the browser asked for.
 * The first value is the one the browser reached; the rest are hops after it.
 */
export const originOf = (request: FastifyRequest): string => {
  const forwarded = String(request.headers['x-forwarded-proto'] ?? request.protocol);
  return `${forwarded.replace(/,.*$/su, '').trim()}://${String(request.headers.host)}`;
};

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Compared as digests so the comparison is over two equal lengths, and takes the same time either way. */
const returned = (sent: unknown, held: string): boolean => timingSafeEqual(digest(String(sent)), digest(held));

/** The context a session call made for one request runs under, carrying that request's own identifier. */
export const sessionCallFor = (request: FastifyRequest): RequestContext =>
  sessionContext(correlationFor('guard:', request.id));

/** The two refusals that mean "sign in again". Every other refusal from the store is a defect. */
const SIGN_IN_AGAIN = new Set<SessionRefusal>(['unknown', 'expired']);

/** The one answer to a request there is no session behind, wherever in the surface it was refused. */
export const refuseWithoutSession = async (
  request: FastifyRequest,
  reply: FastifyReply,
  why: string,
): Promise<void> => {
  await reply
    .header('set-cookie', clearedSessionCookie())
    .code(401)
    .send(
      errorEnvelope(SESSION_EXPIRED, SIGN_IN_MESSAGE, request.id, [
        { path: SESSION_COOKIE, code: SESSION_EXPIRED, message: why },
      ]),
    );
};

/** The answer to a request there is a session behind that still cannot be accepted from where it came. */
export const refuseAsForbidden = async (
  request: FastifyRequest,
  reply: FastifyReply,
  path: string,
  why: string,
): Promise<void> => {
  await reply
    .code(403)
    .send(errorEnvelope(FORBIDDEN, REFUSED_MESSAGE, request.id, [{ path, code: FORBIDDEN, message: why }]));
};

/**
 * The answer to an error the store threw: sign in again for the two refusals that mean the session is
 * gone, and a fault of this server's for everything else, which is what everything else is.
 */
export async function refuseAsStoreSaid(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  why: string,
): Promise<void> {
  // A session that is over is an answer; anything else the store says is this server's own fault, and
  // is not dressed up as one, because telling an operator to sign in again would not help them.
  if (error instanceof SessionError && SIGN_IN_AGAIN.has(error.kind)) {
    await refuseWithoutSession(request, reply, why);
    return;
  }
  request.log.error(error);
  await reply.code(500).send(unexpectedFailure(request.id));
}

/**
 * The session a request carries, or nothing — in which case the refusal has already been answered, and
 * the caller's only job is to stop. Shared by the guard and by the routes that read a session directly,
 * so a safe method and a mutating one disagree about nothing except what they go on to check.
 */
export async function sessionFor(
  sessions: SessionStore | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Guarded | undefined> {
  if (sessions === undefined) {
    await refuseWithoutSession(request, reply, 'this deployment keeps no sessions, and so accepts no changes');
    return undefined;
  }
  const token = cookieIn(request.headers.cookie, SESSION_COOKIE);
  if (token === undefined) {
    await refuseWithoutSession(request, reply, 'the request carried no session');
    return undefined;
  }
  try {
    return { token, record: await sessions.read(sessionCallFor(request), token), sessions };
  } catch (error: unknown) {
    await refuseAsStoreSaid(request, reply, error, 'this session is over, or was never one this server issued');
    return undefined;
  }
}

export function guardMutations(app: FastifyInstance, { sessions, unguarded = UNGUARDED }: GuardOptions): void {
  const covered: Route[] = [];
  const allowed = new Set(unguarded);
  TABLES.set(app, covered);

  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (mutates(method) && !allowed.has(`${method} ${route.url}`)) covered.push({ method, url: route.url });
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!mutates(request.method)) return;
    if (allowed.has(`${request.method} ${String(request.routeOptions.url)}`)) return;

    const proven = await sessionFor(sessions, request, reply);
    if (proven === undefined) return;

    if (!isSameOrigin(request.headers.origin, originOf(request))) {
      await refuseAsForbidden(request, reply, 'origin', 'a change is accepted only from this deployment’s own pages');
      return;
    }
    if (!returned(request.headers[CSRF_HEADER], proven.record.csrf)) {
      await refuseAsForbidden(request, reply, CSRF_HEADER, 'return the token this session was given, in this header');
      return;
    }

    PROVEN.set(request, proven);
  });
}
