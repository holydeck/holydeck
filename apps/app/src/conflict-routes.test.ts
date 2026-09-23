import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { shelfKey } from '@holydeck/contracts/collaboration';
import { VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { enforceAuthorization } from './authorization.js';
import { CONFLICTS_PATH, CONFLICT_RESOLVE_PATH, serveConflictRoutes } from './conflict-routes.js';
import { SHELF_PERMISSIONS, conflictShelfOn } from './conflicts.js';
import { requestContext } from './context.js';
import { guardMutations } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { RECORDS } from './records.js';
import { REVISION_PERMISSIONS, revisionsOn } from './revisions.js';
import { CONTENT_EDIT } from './roles.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { ConflictShelf } from './conflicts.js';
import type { RevisionBody } from '@holydeck/contracts/revisions';
import type { RevisionStore } from './revisions.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const START = Date.parse('2026-09-23T09:30:00.000Z');
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-3a41c0f9';
const EDITOR = 'account:' + 'C'.repeat(22);

const SHELF_COLLECTION = RECORDS.conflictShelf.collection;

let app: FastifyInstance;
let sessions: SessionStore;
let db: FakeDb;
let revisions: RevisionStore;
let conflictShelf: ConflictShelf;
let editor: StartedSession;

const now = (): string => new Date(START).toISOString();

/** A context that may write revisions and the shelf directly, bypassing HTTP — for seeding fixtures. */
const direct = () =>
  requestContext({
    actor: EDITOR,
    correlationId: CORRELATION,
    permissions: [...Object.values(REVISION_PERMISSIONS), ...Object.values(SHELF_PERMISSIONS)],
  });

const withHeaders = (held: StartedSession = editor) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  cookie: sessionCookie(held.token, 60),
  [CSRF_HEADER]: held.record.csrf,
});

const listing = (contentId: string, held: StartedSession = editor) =>
  app.inject({ method: 'GET', url: CONFLICTS_PATH.replace(':contentId', contentId), headers: withHeaders(held) });

const resolving = (contentId: string, shelfEntryId: string, payload: unknown, held: StartedSession = editor) =>
  app.inject({
    method: 'POST',
    url: CONFLICT_RESOLVE_PATH.replace(':contentId', encodeURIComponent(contentId)).replace(
      ':shelfEntryId', encodeURIComponent(shelfEntryId),
    ),
    headers: withHeaders(held),
    payload: payload as never,
  });

const serving = async (
  shelf: ConflictShelf | undefined,
  store: RevisionStore | undefined,
): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveConflictRoutes(app, { conflictShelf: shelf, revisions: store });
  await app.ready();
};

/** A shelved conflict, written straight to the shelf's own collection rather than raced into existence. */
const seedShelved = async (contentId: string, sequence: number, body: RevisionBody): Promise<void> => {
  await db.collection(SHELF_COLLECTION).insertOne({
    _id: shelfKey(contentId, sequence),
    contentId,
    sequence,
    kind: 'shelved',
    attempted: sequence + 1,
    origin: 'autosave',
    body,
    at: now(),
    actor: EDITOR,
    correlationId: CORRELATION,
  });
};

beforeEach(async () => {
  sessions = sessionsOn(memorySessions().db, { now });
  db = fakeDb();
  revisions = revisionsOn(db, { now });
  conflictShelf = conflictShelfOn(db, { now });
  await serving(conflictShelf, revisions);
  editor = await sessions.start(sessionContext(CORRELATION), {
    actor: EDITOR,
    permissions: [CONTENT_EDIT, ...Object.values(REVISION_PERMISSIONS), ...Object.values(SHELF_PERMISSIONS)],
  });
});

afterEach(async () => {
  await app.close();
});

describe('listing a content\'s conflicts', () => {
  test('answers empty when nothing was ever shelved', async () => {
    const response = await listing('song:1');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ outstanding: [], entries: [] });
  });

  test('answers every shelved entry, outstanding until something settles it', async () => {
    await seedShelved('song:1', 1, { title: 'A' });
    const response = await listing('song:1');
    expect(response.statusCode).toBe(200);
    expect(response.json().data.entries).toHaveLength(1);
    expect(response.json().data.outstanding).toHaveLength(1);
    expect(response.json().data.entries[0]).toMatchObject({ contentId: 'song:1', sequence: 1, body: { title: 'A' } });
  });

  test('is answered not-found in a deployment with nowhere to keep a shelf', async () => {
    await app.close();
    await serving(undefined, undefined);
    expect((await listing('song:1')).statusCode).toBe(404);
  });

  test('refuses a session granted none of the permissions this surface accepts', async () => {
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: 'account:' + 'D'.repeat(22), permissions: [] });
    expect((await listing('song:1', guest)).statusCode).toBe(403);
  });
});

describe('resolving a conflict', () => {
  test('422s a resolve body missing strategy', async () => {
    const response = await resolving('song:1', 'does-not-exist', {});
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
  });

  test('404s a shelf entry that does not exist', async () => {
    const response = await resolving('song:1', 'does-not-exist', { strategy: 'keep-theirs' });
    expect(response.statusCode).toBe(404);
  });

  test('keep-mine saves the shelved body forward as the next revision', async () => {
    await revisions.save(direct(), { contentId: 'song:1', body: { title: 'held' }, origin: 'autosave' });
    await seedShelved('song:1', 1, { title: 'mine' });
    const response = await resolving('song:1', shelfKey('song:1', 1), { strategy: 'keep-mine' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ revision: { revision: 2, body: { title: 'mine' } } });
    expect(await conflictShelf.outstanding(direct(), 'song:1')).toEqual([]);
  });

  test('keep-theirs saves the standing revision forward, unchanged', async () => {
    await revisions.save(direct(), { contentId: 'song:1', body: { title: 'held' }, origin: 'autosave' });
    await seedShelved('song:1', 1, { title: 'mine' });
    const response = await resolving('song:1', shelfKey('song:1', 1), { strategy: 'keep-theirs' });
    expect(response.statusCode).toBe(200);
    // Resolving to the exact body already standing is a save that changed nothing: no new revision.
    expect(response.json().data).toMatchObject({ revision: { revision: 1, body: { title: 'held' } } });
  });

  test('combine saves the client-supplied body forward', async () => {
    await revisions.save(direct(), { contentId: 'song:1', body: { title: 'held' }, origin: 'autosave' });
    await seedShelved('song:1', 1, { title: 'mine' });
    const response = await resolving('song:1', shelfKey('song:1', 1), {
      strategy: 'combine',
      resolvedBody: { title: 'combined' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ revision: { revision: 2, body: { title: 'combined' } } });
  });

  test('409s settling the same conflict twice', async () => {
    await revisions.save(direct(), { contentId: 'song:1', body: { title: 'held' }, origin: 'autosave' });
    await seedShelved('song:1', 1, { title: 'mine' });
    await resolving('song:1', shelfKey('song:1', 1), { strategy: 'keep-mine' });
    const response = await resolving('song:1', shelfKey('song:1', 1), { strategy: 'keep-mine' });
    expect(response.statusCode).toBe(409);
  });

  test('is answered not-found in a deployment with nowhere to keep a shelf', async () => {
    await app.close();
    await serving(undefined, undefined);
    const response = await resolving('song:1', 'does-not-exist', { strategy: 'keep-theirs' });
    expect(response.statusCode).toBe(404);
  });

  test('refuses a session granted none of the permissions this surface accepts', async () => {
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: 'account:' + 'D'.repeat(22), permissions: [] });
    const response = await resolving('song:1', 'does-not-exist', { strategy: 'keep-theirs' }, guest);
    expect(response.statusCode).toBe(403);
  });
});
