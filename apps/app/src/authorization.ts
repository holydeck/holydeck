// The check every route is asked before its handler runs: whether this request may reach it with no
// session at all, with one merely proved, or with one that also carries a permission. Structurally
// parallel to `csrf.ts` — declared once at registration, proved and stashed once per request — but a
// different question: that guard proves a session exists and came from this deployment's own pages; this
// one decides what a route is even allowed to ask of that session, and answers the routes `csrf.ts` never
// touches at all, because they change nothing.
//
// A route's need is declared once, through `config.need`, and never inferred. A route registered with
// none throws the moment it is registered — synchronously, at boot — because a route this check forgot to
// name is a route this server would otherwise answer with an unguarded 200.

import { mutates } from '@holydeck/contracts/sessions';

import { provenSession, refuseAsForbidden, rememberProvenSession, sessionFor } from './csrf.js';
import { unexpectedFailure } from './failures.js';

import type { FastifyInstance, HTTPMethods } from 'fastify';
import type { SessionStore } from './sessions.js';

/**
 * What a route needs before its handler runs. `public` needs nothing; `session` needs one proved, and
 * proves it for a safe route the way `csrf.ts` already does for a mutating one; `permission` needs that
 * session's record to carry the named permission besides.
 */
export type RouteNeed =
  | { readonly kind: 'public' }
  | { readonly kind: 'session' }
  | { readonly kind: 'permission'; readonly need: string };

export interface Route {
  /** Fastify's own spelling of a method, so a table of these can be replayed against the application. */
  readonly method: HTTPMethods;
  readonly url: string;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** What this route needs before its handler runs. Required — `enforceAuthorization` throws without it. */
    need?: RouteNeed;
  }
}

export interface AuthorizationOptions {
  /** Absent in a deployment that keeps no sessions. A `session` or `permission` route then proves none. */
  readonly sessions: SessionStore | undefined;
}

const NEEDS = new WeakMap<FastifyInstance, Map<string, RouteNeed>>();

const keyFor = (method: string, url: string): string => `${method} ${url}`;

/** The need declared for every route this check is installed on. A route it was never put on has none. */
export function needsOf(app: FastifyInstance): ReadonlyMap<string, RouteNeed> {
  return NEEDS.get(app) ?? new Map();
}

export function enforceAuthorization(app: FastifyInstance, { sessions }: AuthorizationOptions): void {
  const declared = new Map<string, RouteNeed>();
  NEEDS.set(app, declared);

  app.addHook('onRoute', (route) => {
    const need = route.config?.need;
    if (need === undefined) {
      throw new Error(`${[route.method].flat().join(',')} ${route.url} declares no authorization need`);
    }
    for (const method of [route.method].flat()) declared.set(keyFor(method, route.url), need);
  });

  app.addHook('onRequest', async (request, reply) => {
    // Asked of every request this application receives, including one no route matched: that one has no
    // URL a need could have been declared for, and nothing here is this check's to answer — the not-found
    // handler answers it, the same way it answers any other path this server never served.
    if (request.is404) return;

    const need = declared.get(keyFor(request.method, String(request.routeOptions.url)));
    /* v8 ignore start -- onRoute's synchronous throw makes a route reaching here structurally
       impossible; answered as the defect it would be, in case it ever is */
    if (need === undefined) {
      request.log.error(`${request.method} ${String(request.routeOptions.url)} declares no authorization need`);
      await reply.code(500).send(unexpectedFailure(request.id));
      return;
    }
    /* v8 ignore stop */
    if (need.kind === 'public') return;

    // A mutating route already had its session proved by the guard registered just before this one — this
    // hook never runs at all if that guard refused, so reading it here is safe rather than presumed. A
    // safe route proves its own, the same way `csrf.ts`'s own safe route already did, and stashes it the
    // same way, so its handler reads it through the one door every other route's handler reads one through.
    const proven = mutates(request.method) ? provenSession(request) : await sessionFor(sessions, request, reply);
    if (proven === undefined) return;
    if (!mutates(request.method)) rememberProvenSession(request, proven);

    if (need.kind === 'permission' && !proven.record.permissions.includes(need.need)) {
      await refuseAsForbidden(request, reply, 'permission', `this session may not ${need.need}`);
    }
  });
}
