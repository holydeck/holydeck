import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import {
  CSRF_HEADER,
  TICKET_SECONDS,
  clearedSessionCookie,
  isOpaqueToken,
  sessionCookie,
} from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { SESSION_PATH, TICKET_PATH, serveSessionRoutes } from './session-routes.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { FastifyInstance } from 'fastify';
import type { SessionStore, StartedSession } from './sessions.js';

const NOW = '2026-09-13T09:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';

let app: FastifyInstance;
let store: SessionStore;

const serving = async (sessions: SessionStore | undefined): Promise<FastifyInstance> => {
  const built = Fastify({ logger: false });
  withSafeErrors(built);
  guardMutations(built, { sessions });
  serveSessionRoutes(built, { sessions });
  await built.ready();
  return built;
};

const signedIn = async (): Promise<StartedSession> =>
  store.start(sessionContext('req-0f9c2a41'), { actor: 'account:7f3a', permissions: ['services.read'] });

const asking = (method: 'GET' | 'DELETE' | 'POST', url: string, session: StartedSession | undefined) =>
  app.inject({
    method,
    url,
    headers: {
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      host: HOST,
      'x-forwarded-proto': 'https',
      origin: ORIGIN,
      ...(session === undefined
        ? {}
        : { cookie: sessionCookie(session.token, 60), [CSRF_HEADER]: session.record.csrf }),
    },
  });

beforeEach(async () => {
  store = sessionsOn(memorySessions().db, { now: () => NOW });
  app = await serving(store);
});

afterEach(async () => {
  await app.close();
});

describe('what an operator can ask about their own session', () => {
  test('answers who the session is for and what it may do, without the identifier it travels as', async () => {
    const session = await signedIn();
    const response = await asking('GET', SESSION_PATH, session);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(session.record);
    // The identifier is a cookie the browser sends and script cannot read. It is not in this
    // answer, and there is no route that puts it in a URL either.
    expect(response.body).not.toContain(session.token);
  });

  test('is answered as a request with no session when there is none, and reading one changes nothing', async () => {
    const response = await asking('GET', SESSION_PATH, undefined);
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBe(clearedSessionCookie());
  });

  test('is a safe method, and so is not one the guard is on', async () => {
    expect(mutatingRoutesOf(app)).toEqual([
      { method: 'DELETE', url: SESSION_PATH },
      { method: 'POST', url: TICKET_PATH },
    ]);
  });
});

describe('ending a session', () => {
  test('ends it, clears the cookie, and the identifier that was ended opens nothing afterwards', async () => {
    const session = await signedIn();
    const response = await asking('DELETE', SESSION_PATH, session);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ ended: true });
    expect(response.headers['set-cookie']).toBe(clearedSessionCookie());
    expect((await asking('GET', SESSION_PATH, session)).statusCode).toBe(401);
  });

  test('is behind the guard, so a page on another site cannot sign an operator out', async () => {
    const session = await signedIn();
    const response = await app.inject({
      method: 'DELETE',
      url: SESSION_PATH,
      headers: { host: HOST, origin: 'https://elsewhere.example.invalid', cookie: sessionCookie(session.token, 60) },
    });
    expect(response.statusCode).toBe(403);
    expect((await asking('GET', SESSION_PATH, session)).statusCode).toBe(200);
  });
});

describe('the ticket a socket handshake carries', () => {
  test('is issued to the session that asked for it, and says how long it is worth having', async () => {
    const session = await signedIn();
    const response = await asking('POST', TICKET_PATH, session);
    expect(response.statusCode).toBe(200);
    const { ticket, expiresInSeconds } = response.json().data;
    expect(isOpaqueToken(String(ticket))).toBe(true);
    expect(expiresInSeconds).toBe(TICKET_SECONDS);
    expect(String(ticket)).not.toBe(session.token);
  });

  test('is refused to a request that carries no session, because a ticket is a session speaking', async () => {
    expect((await asking('POST', TICKET_PATH, undefined)).statusCode).toBe(401);
  });
});

describe('a deployment that keeps no sessions', () => {
  test('serves the surface and answers every part of it the same way', async () => {
    app = await serving(undefined);
    expect((await asking('GET', SESSION_PATH, undefined)).statusCode).toBe(401);
    expect((await asking('DELETE', SESSION_PATH, undefined)).statusCode).toBe(401);
    expect((await asking('POST', TICKET_PATH, undefined)).statusCode).toBe(401);
  });
});
