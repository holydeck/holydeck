import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { shelfKey } from '@holydeck/contracts/collaboration';
import { ENTITY_CONFLICT, VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { CONFLICTS_PATH, CONFLICT_RESOLVE_PATH, serveConflictRoutes } from './conflict-routes.js';
import { ConflictError, SHELF_PERMISSIONS, conflictShelfOn } from './conflicts.js';
import { requestContext } from './context.js';
import { guardMutations } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { RECORDS } from './records.js';
import { REVISION_PERMISSIONS, revisionsOn } from './revisions.js';
import { CONTENT_EDIT, LAYOUTS_MANAGE } from './roles.js';
import { passkeysOn } from './passkeys.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { RevisedKind } from './content-kind.js';
import type { ConflictShelf } from './conflicts.js';
import type { Identity } from './onboarding.js';
import type { Document } from './repositories.js';
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

// One id stands for a Slide Layout; everything else is ordinary content, as it is in a deployment.
const kindOf = (contentId: string): Promise<RevisedKind> =>
  Promise.resolve(contentId === 'layout:1' ? 'slideLayout' : 'content');

let trail: FakeDb;
let identity: Identity;
const entriesIn = (): Document[] => trail.rows.get('audit_events') ?? [];

const serving = async (
  shelf: ConflictShelf | undefined,
  store: RevisionStore | undefined,
  held: Identity | undefined = undefined,
): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: held });
  serveConflictRoutes(app, { conflictShelf: shelf, revisions: store, identity: held, kindOf });
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
  trail = fakeDb();
  identity = {
    accounts: accountsOn(memoryAccounts().db, {
      now,
      newId: () => 'A'.repeat(22),
      hash: async (password) => `test-hash:${password}`,
      verify: async (password, stored) => stored === `test-hash:${password}`,
    }),
    audit: auditOn(trail, { now, newId: (() => { let n = 0; return () => `e${n++}`; })() }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
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

describe('resolving a conflict, with an identity to audit against', () => {
  beforeEach(async () => {
    await app.close();
    await serving(conflictShelf, revisions, identity);
  });

  test('records a content.conflict.resolve entry naming who settled it and which revision won', async () => {
    await revisions.save(direct(), { contentId: 'song:1', body: { title: 'held' }, origin: 'autosave' });
    await seedShelved('song:1', 1, { title: 'mine' });
    const response = await resolving('song:1', shelfKey('song:1', 1), { strategy: 'keep-mine' });
    expect(response.statusCode).toBe(200);
    expect(entriesIn()).toEqual([
      expect.objectContaining({ actor: EDITOR, action: 'content.conflict.resolve', subject: 'song:1', outcome: 'allowed' }),
    ]);
    expect(entriesIn()[0]?.['detail']).toBe('keep-mine: revision 2 over revision 1');
  });

  test('records nothing for a resolve that was refused', async () => {
    const response = await resolving('song:1', 'does-not-exist', { strategy: 'keep-theirs' });
    expect(response.statusCode).toBe(404);
    expect(entriesIn()).toEqual([]);
  });

  test('a trail that refuses an entry does not cost the resolution', async () => {
    await app.close();
    await serving(conflictShelf, revisions, {
      ...identity,
      audit: { record: () => Promise.reject(new Error('the trail is unavailable')), list: () => Promise.resolve({ entries: [] }) },
    });
    await revisions.save(direct(), { contentId: 'song:1', body: { title: 'held' }, origin: 'autosave' });
    await seedShelved('song:1', 1, { title: 'mine' });
    expect((await resolving('song:1', shelfKey('song:1', 1), { strategy: 'keep-mine' })).statusCode).toBe(200);
  });
});

describe('a shelf this code cannot read', () => {
  test('answers the resolve as a conflict the editor can see, not a server fault', async () => {
    await app.close();
    await serving({
      ...conflictShelf,
      resolveConflict: () => Promise.reject(new ConflictError('corrupt', 'song:1 has a shelved conflict and no revision')),
    }, revisions);
    const response = await resolving('song:1', shelfKey('song:1', 1), { strategy: 'combine', resolvedBody: { title: 'x' } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
  });
});

describe('the content kind a conflict belongs to', () => {
  test('keeps an Editor off a Slide Layout\'s shelf, listing and resolving alike', async () => {
    await seedShelved('layout:1', 1, { title: 'mine' });
    expect((await listing('layout:1')).statusCode).toBe(403);
    const combined = await resolving('layout:1', shelfKey('layout:1', 1), { strategy: 'combine', resolvedBody: { title: 'x' } });
    expect(combined.statusCode).toBe(403);
    expect(await revisions.history(direct(), 'layout:1')).toEqual([]);
  });

  test('lets the Layout\'s own administrator in', async () => {
    const admin = await sessions.start(sessionContext(CORRELATION), { actor: 'account:' + 'F'.repeat(22), permissions: [LAYOUTS_MANAGE] });
    expect((await listing('layout:1', admin)).statusCode).toBe(200);
  });
});
