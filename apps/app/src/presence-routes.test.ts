import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { enforceAuthorization } from './authorization.js';
import { guardMutations } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { presenceOn } from './presence.js';
import { PRESENCE_PATH, servePresenceRoutes } from './presence-routes.js';
import { CONTENT_EDIT, PRESENCE_USE } from './roles.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { memoryPresence } from '../test/helpers/presence.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { RevisedKind } from './content-kind.js';
import type { Identity } from './onboarding.js';
import type { PresenceStore } from './presence.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FastifyInstance } from 'fastify';

const START = Date.parse('2026-09-13T09:30:00.000Z');
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const EDITOR = 'account:' + 'C'.repeat(22);

let app: FastifyInstance;
let sessions: SessionStore;
let presence: PresenceStore;
let editor: StartedSession;

const now = (): string => new Date(START).toISOString();

const withHeaders = (held: StartedSession = editor) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  cookie: sessionCookie(held.token, 60),
  [CSRF_HEADER]: held.record.csrf,
});

const path = (contentId: string): string => PRESENCE_PATH.replace(':contentId', contentId);

const entering = (contentId: string, held: StartedSession = editor) =>
  app.inject({ method: 'POST', url: path(contentId), headers: withHeaders(held) });

const listing = (contentId: string, held: StartedSession = editor) =>
  app.inject({ method: 'GET', url: path(contentId), headers: withHeaders(held) });

const leaving = (contentId: string, held: StartedSession = editor) =>
  app.inject({ method: 'DELETE', url: path(contentId), headers: withHeaders(held) });

// One id stands for a Slide Layout; everything else is ordinary content, as it is in a deployment.
const kindOf = (contentId: string): Promise<RevisedKind> =>
  Promise.resolve(contentId === 'layout:1' ? 'slideLayout' : 'content');

// Only the one read a listing makes of the account store: who the editor's account says they are.
const naming = {
  accounts: {
    read: (_context: unknown, id: string) =>
      Promise.resolve(id === 'C'.repeat(22) ? { id, displayName: 'Chioma Obi' } : undefined),
  },
} as unknown as Identity;

const serving = async (store: PresenceStore | undefined, identity: Identity | undefined = undefined): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  servePresenceRoutes(app, { presence: store, identity, kindOf });
  await app.ready();
};

beforeEach(async () => {
  sessions = sessionsOn(memorySessions().db, { now: () => new Date(START).toISOString() });
  presence = presenceOn(memoryPresence().db, { now });
  await serving(presence);
  editor = await sessions.start(sessionContext(CORRELATION), {
    actor: EDITOR,
    permissions: [PRESENCE_USE, CONTENT_EDIT],
  });
});

afterEach(async () => {
  await app.close();
});

describe('entering presence', () => {
  test('answers the entry, with this actor and this content', async () => {
    const response = await entering('song:1');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ contentId: 'song:1', actor: EDITOR });
  });

  test('refuses a contentId carrying the reserved separator with a 422 naming the field', async () => {
    const response = await entering(encodeURIComponent('song#1'));
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(response.json().error.fields[0].path).toBe('params.contentId');
  });

  test('is answered not-found in a deployment with nowhere to keep an entry', async () => {
    await app.close();
    await serving(undefined);
    expect((await entering('song:1')).statusCode).toBe(404);
  });

  test('refuses a session granted no permission here', async () => {
    const guest = await sessions.start(sessionContext(CORRELATION), {
      actor: 'account:' + 'D'.repeat(22),
      permissions: [],
    });
    expect((await entering('song:1', guest)).statusCode).toBe(403);
  });

  test('refuses a member who may be present but may not edit this content', async () => {
    const member = await sessions.start(sessionContext(CORRELATION), {
      actor: 'account:' + 'D'.repeat(22),
      permissions: [PRESENCE_USE],
    });
    expect((await entering('song:1', member)).statusCode).toBe(403);
    expect((await listing('song:1', member)).statusCode).toBe(403);
  });

  test('refuses an editor on a Slide Layout, which only Admin edits', async () => {
    expect((await entering('layout:1')).statusCode).toBe(403);
    expect((await listing('layout:1')).statusCode).toBe(403);
  });
});

describe('listing presence', () => {
  test('answers every editor still on this content, oldest arrival first', async () => {
    await entering('song:1');
    const response = await listing('song:1');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0]).toMatchObject({ contentId: 'song:1', actor: EDITOR });
  });

  test('names each editor the way their account does, when there is an account to ask', async () => {
    await app.close();
    await serving(presence, naming);
    await entering('song:1');
    expect((await listing('song:1')).json().data[0]).toMatchObject({ actor: EDITOR, displayName: 'Chioma Obi' });
  });

  test('leaves an editor unnamed when no account answers for them', async () => {
    await entering('song:1');
    expect((await listing('song:1')).json().data[0]).not.toHaveProperty('displayName');
  });

  test('answers an empty list for content nobody is editing', async () => {
    const response = await listing('song:2');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });
});

describe('leaving presence', () => {
  test('answers 204 and removes the entry', async () => {
    await entering('song:1');
    const leave = await leaving('song:1');
    expect(leave.statusCode).toBe(204);
    expect((await listing('song:1')).json().data).toEqual([]);
  });

  test('lets anyone leave, whatever they may edit: leaving claims nothing', async () => {
    const member = await sessions.start(sessionContext(CORRELATION), {
      actor: 'account:' + 'D'.repeat(22),
      permissions: [PRESENCE_USE],
    });
    expect((await leaving('song:1', member)).statusCode).toBe(204);
  });

  test('answers 204 even when this actor was never present', async () => {
    expect((await leaving('song:1')).statusCode).toBe(204);
  });
});
