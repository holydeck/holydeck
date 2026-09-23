import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization, needsOf } from './authorization.js';
import { guardMutations, provenSession } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { passkeysOn } from './passkeys.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { Document } from './repositories.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';
import type { SessionStore, StartedSession } from './sessions.js';

const NOW = '2026-09-13T09:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';

let app: FastifyInstance;
let store: SessionStore;

const version = { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current) };

const PUBLIC: RouteNeed = { kind: 'public' };
const SESSION: RouteNeed = { kind: 'session' };
const permission = (need: string): RouteNeed => ({ kind: 'permission', need });

/** Built fresh per test that needs one: only `audit` is asked of it here, the rest stays unused. */
const identityWith = (trail: FakeDb): Identity => ({
  accounts: accountsOn(memoryAccounts().db, {
    now: () => NOW,
    newId: () => 'A'.repeat(22),
    hash: async (password) => `test-hash:${password}`,
    verify: async (password, stored) => stored === `test-hash:${password}`,
  }),
  audit: auditOn(trail, { now: () => NOW, newId: (() => { let n = 0; return () => `e${n++}`; })() }),
  attempts: attemptsOn(memoryAttempts().db, { now: () => NOW }),
  totp: totpsOn(memoryTotp().db, { now: () => NOW }),
  passkeys: passkeysOn(memoryPasskeys().db, { now: () => NOW }),
});

const entries = (trail: FakeDb): Document[] => trail.rows.get('audit_events') ?? [];

const serving = async (sessions: SessionStore | undefined, identity?: Identity): Promise<FastifyInstance> => {
  const built = Fastify({ logger: false });
  withSafeErrors(built);
  guardMutations(built, { sessions });
  enforceAuthorization(built, { sessions, identity });

  built.get('/api/v1/open', { config: { need: PUBLIC } }, () => ({ open: true }));
  built.get('/api/v1/mine', { config: { need: SESSION } }, (request) => ({
    actor: provenSession(request).record.actor,
  }));
  built.post('/api/v1/change', { config: { need: SESSION } }, (request) => ({
    actor: provenSession(request).record.actor,
  }));
  built.patch(
    '/api/v1/admin-only',
    { config: { need: permission('accounts.manage') } },
    (request) => ({ actor: provenSession(request).record.actor }),
  );

  await built.ready();
  return built;
};

const signedIn = async (permissions: readonly string[] = []): Promise<StartedSession> =>
  store.start(sessionContext('req-0f9c2a41'), { actor: 'account:7f3a', permissions });

const withSession = (session: StartedSession | undefined, headers: Record<string, string> = {}) => ({
  ...version,
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  ...(session === undefined ? {} : { cookie: sessionCookie(session.token, 60), [CSRF_HEADER]: session.record.csrf }),
  ...headers,
});

beforeEach(async () => {
  store = sessionsOn(memorySessions().db, { now: () => NOW });
  app = await serving(store);
});

afterEach(async () => {
  await app.close();
});

describe('a route declared public', () => {
  test('is reached with no session at all', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/open', headers: version });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ open: true });
  });
});

describe('a route declared session', () => {
  test('a safe one proves its own session, and hands the handler what it proved', async () => {
    const session = await signedIn();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/mine',
      headers: withSession(session),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ actor: 'account:7f3a' });
  });

  test('a safe one refuses a request that carries none, exactly as `sessionFor` already does', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/mine', headers: version });
    expect(response.statusCode).toBe(401);
  });

  test('a mutating one reads the session the guard already proved, and asks the store no second time', async () => {
    const session = await signedIn();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/change',
      headers: withSession(session),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ actor: 'account:7f3a' });
  });

  test('a mutating one is refused by the guard above before this check is ever asked', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/change', headers: withSession(undefined) });
    expect(response.statusCode).toBe(401);
  });
});

describe('a route declared permission', () => {
  test('is reached by a session whose record carries the named permission', async () => {
    const session = await signedIn(['accounts.manage']);
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin-only',
      headers: withSession(session),
    });
    expect(response.statusCode).toBe(200);
  });

  // A client that never shows the control still has the route to call directly, and calling it directly
  // is exactly what this check exists to refuse: the server, not the client, is what decides this.
  test('refuses a session that carries no such permission, however the client hid the control', async () => {
    const session = await signedIn([]);
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin-only',
      headers: withSession(session),
    });
    expect(response.statusCode).toBe(403);
  });

  test('refuses a session carrying a different permission just as plainly as carrying none', async () => {
    const session = await signedIn(['presentation.control']);
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin-only',
      headers: withSession(session),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('a permission refusal, with an identity to audit against', () => {
  let trail: FakeDb;

  beforeEach(async () => {
    trail = fakeDb();
    app = await serving(store, identityWith(trail));
  });

  test('records exactly one authorization.refuse entry naming the actor and the missing permission', async () => {
    const session = await signedIn([]);
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin-only',
      headers: withSession(session),
    });
    expect(response.statusCode).toBe(403);
    expect(entries(trail)).toEqual([
      expect.objectContaining({
        actor: 'account:7f3a',
        action: 'authorization.refuse',
        subject: 'PATCH /api/v1/admin-only',
        outcome: 'refused',
      }),
    ]);
    expect(entries(trail)[0]?.['detail']).toContain('accounts.manage');
  });

  test('records nothing when the session carries the needed permission', async () => {
    const session = await signedIn(['accounts.manage']);
    await app.inject({ method: 'PATCH', url: '/api/v1/admin-only', headers: withSession(session) });
    expect(entries(trail)).toEqual([]);
  });

  test('records nothing for a session-kind refusal — no session to name, and session.signIn already covers it', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/mine', headers: version });
    expect(response.statusCode).toBe(401);
    expect(entries(trail)).toEqual([]);
  });

  test('still refuses with 403 even when the trail itself refuses the entry', async () => {
    app = await serving(store, {
      ...identityWith(trail),
      audit: {
        record: () => Promise.reject(new Error('the trail is unavailable')),
        list: () => Promise.reject(new Error('the trail is unavailable')),
      },
    });
    const session = await signedIn([]);
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin-only',
      headers: withSession(session),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('a permission refusal, with no identity to audit against', () => {
  test('still refuses with 403, even though nothing here can be audited', async () => {
    app = await serving(store, undefined);
    const session = await signedIn([]);
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin-only',
      headers: withSession(session),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('what this check declares', () => {
  test('names the need of every route it was put on, keyed the way it looks one up', () => {
    // Fastify exposes a HEAD alongside every GET unless told not to, and it carries the same declared
    // need: a caller allowed to read a resource is allowed to ask whether it is there.
    expect(needsOf(app)).toEqual(
      new Map([
        ['GET /api/v1/open', PUBLIC],
        ['HEAD /api/v1/open', PUBLIC],
        ['GET /api/v1/mine', SESSION],
        ['HEAD /api/v1/mine', SESSION],
        ['POST /api/v1/change', SESSION],
        ['PATCH /api/v1/admin-only', permission('accounts.manage')],
      ]),
    );
  });

  test('an application this check was never put on declares nothing', () => {
    expect(needsOf(Fastify({ logger: false }))).toEqual(new Map());
  });

  test('throws the moment a route is registered with no declared need, before the application ever serves', async () => {
    const broken = Fastify({ logger: false });
    enforceAuthorization(broken, { sessions: store, identity: undefined });
    expect(() => broken.get('/api/v1/undeclared', () => ({ ok: true }))).toThrow(
      /declares no authorization need/u,
    );
  });
});

describe('a request no route matched', () => {
  // Fastify still runs this hook for it, with no URL a need could have been declared for. Answered by
  // the not-found handler, the same way any other path this server never served is — not by this check.
  test('is not this check’s to answer, and reaches the not-found handler undisturbed', async () => {
    const open = Fastify({ logger: false });
    withSafeErrors(open);
    guardMutations(open, { sessions: store });
    enforceAuthorization(open, { sessions: store, identity: undefined });
    open.setNotFoundHandler((request, reply) => reply.code(404).send({ notFound: true }));
    await open.ready();
    const response = await open.inject({ method: 'GET', url: '/api/v1/nope', headers: version });
    expect(response.statusCode).toBe(404);
    await open.close();
  });
});
