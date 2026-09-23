import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT } from '@holydeck/contracts/http';
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
import { LIBRARY_DEPENDENTS_PATH, LIBRARY_ID_PATH, LIBRARY_STATUS_PATH, serveLibraryRoutes } from './library-routes.js';
import { serviceTemplateContext, serviceTemplatesOn } from './service-templates.js';
import { serviceContext, servicesOn } from './services.js';
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
import type { ServiceTemplateStore } from './service-templates.js';
import type { ServiceStore } from './services.js';
import type { ServiceSection } from '@holydeck/contracts/services';
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
let services: ServiceStore;
let templates: ServiceTemplateStore;
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
const statusing = (id: string, archived: unknown, held: StartedSession = admin) =>
  app.inject({ method: 'PATCH', url: at(LIBRARY_STATUS_PATH, id), headers: headers(held), payload: { archived } });
const entries = () => db.rows.get(RECORDS.auditEvents.collection) ?? [];
const worship = (id: string): readonly ServiceSection[] => [
  { id: 'section-1', name: 'Worship', items: [{ id: 'item-1', kind: 'song', title: 'Amazing Grace', enabled: true, content: { id, revision: 1, hash: 'fnv1a-6fe1d1e9' } }] },
];
const created = async (kind: 'song' | 'sermon' = 'song', title = 'Amazing Grace') =>
  library.create(libraryContext(ACTOR, 'library-test'), { kind, title });

const serving = async (held: Identity | undefined, store: LibraryStore | undefined = library): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveLibraryRoutes(app, { library: store, identity: held, services, serviceTemplates: templates });
  await app.ready();
};

beforeEach(async () => {
  tick = 0;
  db = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now: () => new Date(START).toISOString() });
  identity = {
    accounts: accountsOn(memoryAccounts().db, { now, newId: () => 'A'.repeat(22), hash: async (password) => `test-hash:${password}`, verify: async (password, stored) => stored === `test-hash:${password}` }),
    audit: auditOn(db, { now, newId: () => `audit-${entries().length}` }), attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }), passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  let serial = 0;
  library = libraryOn(db, { now, newId: () => `library-${(serial += 1)}` });
  services = servicesOn(db, { now, newId: () => `service-${(serial += 1)}` });
  templates = serviceTemplatesOn(db, { now, newId: () => `template-${(serial += 1)}`, services });
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

  test('rejects an unrecognised kind filter', async () => {
    const response = await ask(`${LIBRARY_PATH}?kind=bogus`);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields).toEqual([expect.objectContaining({ path: 'library.kind' })]);
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

describe('archiving and restoring from the library (DELT-01, COLAB-14)', () => {
  test('archives an item out of the default list, restores it, and audits both', async () => {
    const item = await created();
    const archived = await statusing(item.stamp.id, true);
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.stamp.archivedBy).toBe(ACTOR);
    expect((await ask(LIBRARY_PATH)).json().data).toEqual([]);
    expect((await ask(`${LIBRARY_PATH}?archived=true`)).json().data).toHaveLength(1);
    expect((await statusing(item.stamp.id, false)).json().data.stamp.archivedAt).toBeUndefined();
    expect((await ask(LIBRARY_PATH)).json().data).toHaveLength(1);
    expect(entries().filter((entry) => entry['action'] === 'content.change').map((entry) => entry['detail'])).toEqual(['archived', 'restored']);
    expect(entries().map((entry) => entry['subject'])).toEqual([`library:${item.stamp.id}`, `library:${item.stamp.id}`]);
  });

  test('answers 409 for a second archive, 404 for a missing item, and 422 for a bad body', async () => {
    const item = await created();
    await statusing(item.stamp.id, true);
    const again = await statusing(item.stamp.id, true);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe(ENTITY_CONFLICT);
    expect((await statusing('missing', true)).statusCode).toBe(404);
    expect((await statusing(item.stamp.id, 'yes')).statusCode).toBe(422);
  });

  test('counts the live services and templates holding an entry that points at the item', async () => {
    const song = await created();
    const other = await created('sermon', 'Grace Abounding');
    const call = serviceContext(ACTOR, 'library-test');
    await services.create(call, { title: 'Sunday Morning', date: '2026-09-13', site: 'Main Hall', sections: worship(song.stamp.id) });
    await services.create(call, { title: 'Sunday Evening', date: '2026-09-13', site: 'Main Hall', sections: worship(song.stamp.id) });
    const gone = await services.create(call, { title: 'Last Year', date: '2025-09-13', site: 'Main Hall', sections: worship(song.stamp.id) });
    await services.archive(call, gone.stamp.id);
    await services.create(call, { title: 'Elsewhere', date: '2026-09-13', site: 'Main Hall', sections: worship(other.stamp.id) });
    await templates.create(serviceTemplateContext(ACTOR, 'library-test'), {
      name: 'Sunday', body: { sections: [{ id: 's', name: 'Worship', entries: [{ id: 'e', slot: 'fixed', itemKind: 'song', title: 'Amazing Grace', content: { id: song.stamp.id, revision: 1, hash: 'fnv1a-6fe1d1e9' } }] }] },
    });
    expect((await ask(at(LIBRARY_DEPENDENTS_PATH, song.stamp.id))).json().data).toEqual({ count: 3, approximate: false, services: 2, templates: 1 });
    expect((await ask(at(LIBRARY_DEPENDENTS_PATH, other.stamp.id))).json().data).toEqual({ count: 1, approximate: false, services: 1, templates: 0 });
    expect((await ask(at(LIBRARY_DEPENDENTS_PATH, 'missing'))).statusCode).toBe(404);
  });

  test('refuses archiving to a session without content.edit', async () => {
    const item = await created();
    const guest = await sessions.start(sessionContext('request'), { actor: ACTOR, permissions: [] });
    expect((await statusing(item.stamp.id, true, guest)).statusCode).toBe(403);
  });
});

test.each([LIBRARY_PATH, LIBRARY_ID_PATH, LIBRARY_DEPENDENTS_PATH])('answers not-found for %s without a store', async (path) => {
  await app.close();
  await serving(undefined, undefined);
  expect((await ask(at(path, 'library-1'))).statusCode).toBe(404);
});

test('answers not-found for the status route without a store', async () => {
  await app.close();
  await serving(undefined, undefined);
  expect((await statusing('library-1', true)).statusCode).toBe(404);
});
