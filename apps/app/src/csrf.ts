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
import { UPDATE_REQUIRED_MESSAGE, UPDATE_REQUIRED_STATUS } from '@holydeck/contracts/clients';
import { UPDATE_REQUIRED, errorEnvelope } from '@holydeck/contracts/http';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  SESSION_EXPIRED,
  SESSION_PATH,
  clearedSessionCookie,
  cookieIn,
  isSameOrigin,
  mutates,
} from '@holydeck/contracts/sessions';
export { SESSION_EXPIRED } from '@holydeck/contracts/sessions';
import { createHash, timingSafeEqual } from 'node:crypto';

import { correlationFor } from './context.js';
import { CORPUS_RENDER_PROXY_PATH } from './corpus-proxy-routes.js';
import { unexpectedFailure } from './failures.js';
import { SessionError } from './sessions.js';
import { sessionContext } from './sessions.js';

import type { SessionRecord } from '@holydeck/contracts/sessions';
import type { RequestContext } from './context.js';
import type { RestoreCompatibilityStore } from './restore-compatibility.js';
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import type { SessionRefusal, SessionStore } from './sessions.js';

/** What `sessionFor`/`refuseAsStoreSaid` need to tell a restore-caused session end from an ordinary one. */
export type RestoreCompatibility = Pick<RestoreCompatibilityStore, 'restoredRecently'>;

/** Answered when there is a session and the request still cannot be accepted from where it came from. */
export const FORBIDDEN = 'auth.forbidden';

const SIGN_IN_MESSAGE = 'Sign in again to continue.';

const REFUSED_MESSAGE = 'The request could not be accepted.';

/**
 * The mutating routes that may be reached without a session, written as `METHOD /path`. The first two are
 * changes that cannot carry a session, for the same reason read twice: claiming a fresh instance is the
 * request that creates the first account there could ever be a session for, and signing in is the request
 * that opens one. The claim closes for good once it has been used and answers not-found from then on;
 * signing in stays open because it has to, which is why it is the one route with a gate that counts what
 * it is sent. The third is different in kind, not merely another exception of the same shape: it carries
 * no session to prove because it is not this application's own change at all, only a render request
 * forwarded to the corpus under the caller's own bearer token — this application never reads its body or
 * writes anything because of it. Leaving it out of this guard does not leave it unguarded:
 * `corpus-proxy-routes.ts` refuses it with 401, before any upstream call, unless the request carries its
 * own `Authorization: Bearer ...` header — a header no cross-site page can make a browser attach the way
 * it attaches a cookie, which is what stands in for the origin and CSRF-token checks this route cannot
 * carry. Anything else added here is a hole.
 */
export const UNGUARDED: readonly string[] = Object.freeze([
  `POST ${ONBOARDING_PATH}`,
  `POST ${SESSION_PATH}`,
  `POST ${CORPUS_RENDER_PROXY_PATH}`,
]);

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
  /** Absent in a deployment that keeps no durable records, which is a deployment no restore can apply to. */
  readonly compatibility?: RestoreCompatibility;
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
 * Stashes a session a safe route proved for itself, so it reads back exactly the way a mutating route's
 * does: through `provenSession`. Nothing but the authorization hook that proves a safe route's session
 * calls this — a route that proves its own would be a route trusting itself instead of the guard.
 */
export function rememberProvenSession(request: FastifyRequest, guarded: Guarded): void {
  PROVEN.set(request, guarded);
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

/**
 * The answer to a request whose session ended because a restore was applied to production, within that
 * restore's `RestoreCompatibility` grace window — told to reload rather than merely to sign in again,
 * since what it holds beyond the session cookie (cached responses, an open build) may be stale too.
 */
const refuseAsUpdateRequired = async (request: FastifyRequest, reply: FastifyReply, why: string): Promise<void> => {
  await reply
    .header('set-cookie', clearedSessionCookie())
    .code(UPDATE_REQUIRED_STATUS)
    .send(
      errorEnvelope(UPDATE_REQUIRED, UPDATE_REQUIRED_MESSAGE, request.id, [
        { path: SESSION_COOKIE, code: UPDATE_REQUIRED, message: why },
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
 * gone, and a fault of this server's for everything else, which is what everything else is. Of the two,
 * a restore recently applied to production (`compatibility`, absent in a deployment that keeps no durable
 * records) is answered "update" instead of "sign in again" — that session did not merely expire, this
 * deployment ended it out from under its own client.
 */
export async function refuseAsStoreSaid(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  why: string,
  compatibility?: RestoreCompatibility,
): Promise<void> {
  // A session that is over is an answer; anything else the store says is this server's own fault, and
  // is not dressed up as one, because telling an operator to sign in again would not help them.
  if (error instanceof SessionError && SIGN_IN_AGAIN.has(error.kind)) {
    if (compatibility !== undefined && (await compatibility.restoredRecently())) {
      await refuseAsUpdateRequired(request, reply, why);
      return;
    }
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
  compatibility?: RestoreCompatibility,
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
    await refuseAsStoreSaid(request, reply, error, 'this session is over, or was never one this server issued', compatibility);
    return undefined;
  }
}

export function guardMutations(
  app: FastifyInstance,
  { sessions, unguarded = UNGUARDED, compatibility }: GuardOptions,
): void {
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

    const proven = await sessionFor(sessions, request, reply, compatibility);
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
