import { ONBOARDING_PATH } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { UPDATE_REQUIRED } from '@holydeck/contracts/http';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  SESSION_PATH,
  clearedSessionCookie,
  mutates,
  sessionCookie,
} from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  FORBIDDEN,
  SESSION_EXPIRED,
  UNGUARDED,
  guardMutations,
  mutatingRoutesOf,
  provenSession,
  rememberProvenSession,
} from './csrf.js';
import { withSafeErrors } from './failures.js';
import { SessionError, sessionContext, sessionsOn } from './sessions.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { FastifyInstance } from 'fastify';
import type { RestoreCompatibility, Route } from './csrf.js';
import type { SessionStore, StartedSession } from './sessions.js';

const NOW = '2026-09-13T09:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';

let app: FastifyInstance;
let store: SessionStore;

const version = { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current) };

const serving = async (
  sessions: SessionStore | undefined,
  compatibility?: RestoreCompatibility,
): Promise<FastifyInstance> => {
  const built = Fastify({ logger: false });
  guardMutations(built, { sessions, compatibility });
  built.post('/api/v1/anything', (request) => ({ actor: provenSession(request).record.actor }));
  built.get('/api/v1/anything', () => ({ read: true }));
  await built.ready();
  return built;
};

/** A `RestoreCompatibility` that answers the same thing every time it is asked. */
const compatibility = (restoredRecently: boolean): RestoreCompatibility => ({
  restoredRecently: async () => restoredRecently,
});

const signedIn = async (): Promise<StartedSession> =>
  store.start(sessionContext('req-0f9c2a41'), { actor: 'account:7f3a', permissions: ['services.read'] });

const mutating = (session: StartedSession | undefined, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/anything',
    headers: {
      ...version,
      host: HOST,
      'x-forwarded-proto': 'https',
      origin: ORIGIN,
      ...(session === undefined ? {} : { cookie: sessionCookie(session.token, 60), [CSRF_HEADER]: session.record.csrf }),
      ...headers,
    },
  });

beforeEach(async () => {
  store = sessionsOn(memorySessions().db, { now: () => NOW });
  app = await serving(store);
});

afterEach(async () => {
  await app.close();
});

describe('what the guard lets past', () => {
  test('a method that changes nothing carries no token, because it changes nothing', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/anything', headers: version });
    expect(response.statusCode).toBe(200);
  });

  test('a session, its token and its own origin together reach the route, which is handed the session', async () => {
    const session = await signedIn();
    const response = await mutating(session);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ actor: 'account:7f3a' });
  });

  test('the origin is read through the proxy that terminated the connection, not the socket', async () => {
    const session = await signedIn();
    // Behind a reverse proxy the process sees plain HTTP; the browser saw HTTPS and says so in the origin.
    await expect(mutating(session, { 'x-forwarded-proto': 'https, http' })).resolves.toMatchObject({
      statusCode: 200,
    });
  });
});

describe('what the guard refuses', () => {
  test('a request that carries no session is refused as a request with no session', async () => {
    const response = await mutating(undefined);
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toMatchObject({
      code: SESSION_EXPIRED,
      fields: [{ path: SESSION_COOKIE }],
    });
  });

  test('a session identifier this server does not know is refused, and the browser is told to drop it', async () => {
    const response = await mutating(undefined, { cookie: `${SESSION_COOKIE}=${'x'.repeat(43)}` });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBe(clearedSessionCookie());
  });

  test('a session that is over is refused, and is over for every later request too', async () => {
    let clock = Date.parse(NOW);
    store = sessionsOn(memorySessions().db, { now: () => new Date(clock).toISOString() });
    app = await serving(store);
    const session = await signedIn();
    clock = Date.parse(NOW) + 25 * 3_600_000;
    const response = await mutating(session);
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBe(clearedSessionCookie());
  });

  test('a session with no token returned is refused, and the refusal names the header to return it in', async () => {
    const session = await signedIn();
    const response = await mutating(session, { [CSRF_HEADER]: '' });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatchObject({ code: FORBIDDEN, fields: [{ path: CSRF_HEADER }] });
  });

  test('another session’s token is no better than none', async () => {
    const mine = await signedIn();
    const theirs = await signedIn();
    const response = await mutating(mine, { [CSRF_HEADER]: theirs.record.csrf });
    expect(response.statusCode).toBe(403);
  });

  test('a request whose origin is another site, or is missing, is refused before the token is read', async () => {
    const session = await signedIn();
    expect((await mutating(session, { origin: 'https://elsewhere.example.invalid' })).statusCode).toBe(403);
    const missing = await mutating(session, { origin: '' });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error).toMatchObject({ fields: [{ path: 'origin' }] });
  });

  test('a deployment that keeps no sessions changes nothing through this surface at all', async () => {
    app = await serving(undefined);
    const response = await mutating(undefined);
    expect(response.statusCode).toBe(401);
  });

  test('a store that refused for any other reason is a defect, and is not answered as a sign-in', async () => {
    const session = await signedIn();
    const defects = [
      new SessionError('schema', 'the store holds a session this code cannot read'),
      new TypeError('mongodb://holydeck:hunter2@records.invalid:27017 is not a function'),
    ];
    for (const defect of defects) {
      const broken: SessionStore = { ...store, read: () => Promise.reject(defect) };
      app = await serving(broken);
      const response = await mutating(session);
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('cannot read');
      expect(response.body).not.toContain('hunter2');
      await app.close();
    }
  });
});

describe('the guard after a restore', () => {
  test('a session this server does not know, within a restore’s grace window, is told to update', async () => {
    app = await serving(store, compatibility(true));
    const response = await mutating(undefined, { cookie: `${SESSION_COOKIE}=${'x'.repeat(43)}` });
    expect(response.statusCode).toBe(426);
    expect(response.json().error).toMatchObject({ code: UPDATE_REQUIRED, fields: [{ path: SESSION_COOKIE }] });
    expect(response.headers['set-cookie']).toBe(clearedSessionCookie());
  });

  test('a session that expired, within a restore’s grace window, is also told to update', async () => {
    let clock = Date.parse(NOW);
    store = sessionsOn(memorySessions().db, { now: () => new Date(clock).toISOString() });
    app = await serving(store, compatibility(true));
    const session = await signedIn();
    clock = Date.parse(NOW) + 25 * 3_600_000;
    const response = await mutating(session);
    expect(response.statusCode).toBe(426);
    expect(response.json().error.code).toBe(UPDATE_REQUIRED);
  });

  test('outside a restore’s grace window, an unknown session is refused the ordinary way', async () => {
    app = await serving(store, compatibility(false));
    const response = await mutating(undefined, { cookie: `${SESSION_COOKIE}=${'x'.repeat(43)}` });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe(SESSION_EXPIRED);
  });

  test('a deployment with no compatibility store to ask refuses the ordinary way, exactly as before', async () => {
    app = await serving(store);
    const response = await mutating(undefined, { cookie: `${SESSION_COOKIE}=${'x'.repeat(43)}` });
    expect(response.statusCode).toBe(401);
  });

  test('a request that carries no session at all is not told to update, restore or not', async () => {
    app = await serving(store, compatibility(true));
    const response = await mutating(undefined);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe(SESSION_EXPIRED);
  });

  test('a defect in the store is still a defect, restore or not', async () => {
    const broken: SessionStore = { ...store, read: () => Promise.reject(new SessionError('schema', 'broken')) };
    app = await serving(broken, compatibility(true));
    const response = await mutating(await signedIn());
    expect(response.statusCode).toBe(500);
  });
});

describe('the routes the guard covers', () => {
  test('every route that changes something is behind it, and the exceptions are the declared ones', () => {
    // Claiming a fresh instance and signing in are the only changes a request with no session may make:
    // one creates the first account there could be a session for, the other opens the session. Anything
    // added here is a hole.
    expect(UNGUARDED).toEqual([`POST ${ONBOARDING_PATH}`, `POST ${SESSION_PATH}`]);
    expect(mutatingRoutesOf(app)).toEqual([{ method: 'POST', url: '/api/v1/anything' }]);
  });

  test('an application the guard was never put on reports guarding nothing', () => {
    expect(mutatingRoutesOf(Fastify({ logger: false }))).toEqual([]);
  });

  // The check a later route cannot quietly skip. What the guard saw is compared against what the
  // application registered, and a route registered above the guard is missing from the first list —
  // which is why `buildApp` installs the guard before it registers anything at all.
  test('a route the guard never saw is missing from what it reports, and the comparison says so', async () => {
    const late = Fastify({ logger: false });
    const registered: Route[] = [];
    late.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) {
        if (mutates(method)) registered.push({ method, url: route.url });
      }
    });
    late.post('/api/v1/first', () => ({ ok: true }));
    guardMutations(late, { sessions: store });
    late.post('/api/v1/second', () => ({ ok: true }));
    await late.ready();
    expect(registered).toEqual([
      { method: 'POST', url: '/api/v1/first' },
      { method: 'POST', url: '/api/v1/second' },
    ]);
    expect(mutatingRoutesOf(late)).toEqual([{ method: 'POST', url: '/api/v1/second' }]);
    await late.close();
  });

  // Reading a session the guard never proved is not a request that failed; it is code that skipped the
  // check. It answers as a defect of this server's, which is what a mistake of this kind should cost.
  test('a route the guard is not on cannot ask for a session, and is a defect when it does', async () => {
    const open = Fastify({ logger: false });
    withSafeErrors(open);
    guardMutations(open, { sessions: store, unguarded: ['POST /api/v1/open'] });
    open.post('/api/v1/open', (request) => ({ actor: provenSession(request).record.actor }));
    await open.ready();
    await expect(open.inject({ method: 'POST', url: '/api/v1/open' })).resolves.toMatchObject({ statusCode: 500 });
    await open.close();
  });

  test('a route declared open is reached with no session, and declaring it is the only way past', async () => {
    const open = Fastify({ logger: false });
    guardMutations(open, { sessions: store, unguarded: ['POST /api/v1/open'] });
    open.post('/api/v1/open', () => ({ ok: true }));
    open.post('/api/v1/closed', () => ({ ok: true }));
    await open.ready();
    expect(mutatingRoutesOf(open)).toEqual([{ method: 'POST', url: '/api/v1/closed' }]);
    await expect(open.inject({ method: 'POST', url: '/api/v1/open' })).resolves.toMatchObject({ statusCode: 200 });
    await expect(open.inject({ method: 'POST', url: '/api/v1/closed' })).resolves.toMatchObject({ statusCode: 401 });
    await open.close();
  });

  // A safe route proves its own session rather than being made to change something to get one from the
  // guard above. What it stashes is read back through the same door a mutating route reads its own by.
  test('what a safe route stashes for itself reads back exactly as a mutating route’s own does', async () => {
    const session = await signedIn();
    const guarded = { token: session.token, record: session.record, sessions: store };
    const safe = Fastify({ logger: false });
    guardMutations(safe, { sessions: store });
    safe.get('/api/v1/safe', (request) => {
      rememberProvenSession(request, guarded);
      return { actor: provenSession(request).record.actor };
    });
    await safe.ready();
    const response = await safe.inject({ method: 'GET', url: '/api/v1/safe' });
    expect(response.json()).toEqual({ actor: guarded.record.actor });
    await safe.close();
  });
});
