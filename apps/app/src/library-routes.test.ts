import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { LIBRARY_PATH } from '@holydeck/contracts/library';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { FORBIDDEN, guardMutations } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { libraryContext, libraryOn } from './library.js';
import { RECORDS } from './records.js';
import { passkeysOn } from './passkeys.js';
import { CONTENT_EDIT } from './roles.js';
import { LIBRARY_ID_PATH, serveLibraryRoutes } from './library-routes.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { LibraryStore } from './library.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const START = Date.parse('2026-09-22T09:30:00.000Z');
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const ACTOR = `account:${'C'.repeat(22)}`;

let app: FastifyInstance;
let sessions: SessionStore;
let identity: Identity;
let library: LibraryStore;
let db: FakeDb;
let admin: StartedSession;
let tick: number;

const now = (): string => new Date(START + (tick += 1) * 1000 - 1000).toISOString();
const at = (path: string, id: string): string => path.replace(':id', id);
const headers = (held: StartedSession = admin) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, 'x-forwarded-proto': 'https', origin: ORIGIN,
  cookie: sessionCookie(held.token, 60), [CSRF_HEADER]: held.record.csrf,
});
const ask = (url: string, held: StartedSession = admin) => app.inject({ method: 'GET', url, headers: headers(held) });
const created = async (kind: 'song' | 'sermon' = 'song', title = 'Amazing Grace') =>
  library.create(libraryContext(ACTOR, 'library-test'), { kind, title });

const serving = async (held: Identity | undefined, store: LibraryStore | undefined = library): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveLibraryRoutes(app, { library: store, identity: held });
  await app.ready();
};

beforeEach(async () => {
  tick = 0;
  db = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now: () => new Date(START).toISOString() });
  identity = {
    accounts: accountsOn(memoryAccounts().db, { now, newId: () => 'A'.repeat(22), hash: async (password) => `test-hash:${password}`, verify: async (password, stored) => stored === `test-hash:${password}` }),
    audit: auditOn(db, { now, newId: () => 'audit' }), attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }), passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  let serial = 0;
  library = libraryOn(db, { now, newId: () => `library-${(serial += 1)}` });
  await serving(identity);
  admin = await sessions.start(sessionContext('request'), { actor: ACTOR, permissions: [CONTENT_EDIT] });
});

afterEach(async () => app.close());

describe('library routes', () => {
  test('lists without a filter, by kind, and by query', async () => {
    const song = await created('song', 'Amazing Grace');
    await created('sermon', 'Grace Abounding');
    expect((await ask(LIBRARY_PATH)).json().data).toEqual([song, expect.anything()]);
    expect((await ask(`${LIBRARY_PATH}?kind=sermon`)).json().data).toHaveLength(1);
    expect((await ask(`${LIBRARY_PATH}?q=MAZING`)).json().data).toEqual([song]);
    expect((await ask(`${LIBRARY_PATH}?q=missing`)).json().data).toEqual([]);
  });

  test('excludes archived rows by default and includes them when asked', async () => {
    const archived = await created('song', 'Archived Grace');
    const collection = RECORDS.contentLibrary.collection;
    const rows = db.rows.get(collection) ?? [];
    rows[0] = { ...rows[0], stamp: { ...archived.stamp, archivedAt: now(), archivedBy: ACTOR } };
    expect((await ask(LIBRARY_PATH)).json().data).toEqual([]);
    expect((await ask(`${LIBRARY_PATH}?archived=true`)).json().data).toHaveLength(1);
  });

  test('gets one item or not-found', async () => {
    const item = await created();
    expect((await ask(at(LIBRARY_ID_PATH, item.stamp.id))).json().data).toEqual(item);
    expect((await ask(at(LIBRARY_ID_PATH, 'missing'))).statusCode).toBe(404);
  });

  test('requires content.edit and a session', async () => {
    const guest = await sessions.start(sessionContext('request'), { actor: ACTOR, permissions: [] });
    expect((await ask(LIBRARY_PATH, guest)).statusCode).toBe(403);
    const response = await app.inject({ method: 'GET', url: LIBRARY_PATH, headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, origin: ORIGIN } });
    expect(response.statusCode).toBe(401);
    expect((await ask(LIBRARY_PATH, guest)).json().error.code).toBe(FORBIDDEN);
  });
});

test.each([LIBRARY_PATH, LIBRARY_ID_PATH])('answers not-found for %s without a store', async (path) => {
  await app.close();
  await serving(undefined, undefined);
  expect((await ask(at(path, 'library-1'))).statusCode).toBe(404);
});
