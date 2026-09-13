// The revision store against a real MongoDB, because the promises it makes are the database's: a revision
// that is already there cannot be written a second time under any key, and a revision that is there cannot
// be changed or removed at all by a product holding the privileges this record class declares.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { requestContext } from './context.js';
import { privilegesFor, RECORDS } from './records.js';
import { repositoriesOn, repositoryDb, RepositoryError } from './repositories.js';
import {
  addressOf,
  createRevisionIndexOn,
  REVISION_INDEXES,
  REVISION_PERMISSIONS,
  RevisionError,
  revisionsOn,
} from './revisions.js';
import { startRestrictedMongo, startTestMongo } from '../test/helpers/mongo.js';

import type { RestrictedMongo, TestMongo } from '../test/helpers/mongo.js';
import type { RepositoryDb } from './repositories.js';
import type { RevisionStore } from './revisions.js';

const START = Date.parse('2026-09-13T09:30:00.000Z');
const COLLECTION = RECORDS.contentRevisions.collection;
const PRIVILEGES = privilegesFor('contentRevisions');

const EDITOR = requestContext({
  actor: 'account:7f3a',
  permissions: [REVISION_PERMISSIONS.append, REVISION_PERMISSIONS.read],
  correlationId: 'req-0f9c2a41',
});

const FIRST = { title: 'Andru', stanzas: ['Andru varum naal'] };
const SECOND = { title: 'Andru', stanzas: ['Andru varum naal', 'Ennai meetka vanthaar'] };
const TAMIL = { title: 'அன்று', stanzas: ['அன்று வரும் நாள்'], meta: { language: 'ta', verses: [1, 2] } };

// The documents as the driver sees them: keyed by the revision key this store writes, and otherwise read
// loosely, because the point of these tests is what the database refuses rather than what it holds.
interface StoredRevision {
  _id: string;
  contentId?: string;
  revision?: number;
  hash?: string;
  body?: unknown;
}

const clock = (): (() => string) => {
  let tick = 0;
  return () => new Date(START + tick++ * 1000).toISOString();
};

let mongo: TestMongo;
let db: RepositoryDb;
let revisions: RevisionStore;

beforeAll(async () => {
  mongo = await startTestMongo();
  db = repositoryDb(mongo.db);
  revisions = revisionsOn(db, { now: clock() });
});

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.collection(COLLECTION).deleteMany({});
  for (const index of REVISION_INDEXES) await createRevisionIndexOn(db, index);
});

describe('history in a real database', () => {
  it('appends a change, brings a body back by appending it again, and reads the run of it', async () => {
    await revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' });
    await revisions.save(EDITOR, { contentId: 'song-1', body: SECOND, origin: 'manual-checkpoint' });
    const restored = await revisions.restore(EDITOR, { contentId: 'song-1', revision: 1 });

    expect(restored).toMatchObject({ appended: true, from: 1, revision: { revision: 3 } });
    const history = await revisions.history(EDITOR, 'song-1');
    expect(history.map((revision) => revision.revision)).toEqual([1, 2, 3]);
    expect(history.map((revision) => revision.hash)).toEqual([addressOf(FIRST), addressOf(SECOND), addressOf(FIRST)]);
    expect(history.map((revision) => revision.origin)).toEqual(['autosave', 'manual-checkpoint', 'manual-checkpoint']);
    expect(await revisions.count(EDITOR, 'song-1')).toBe(3);
  });

  it('writes nothing at all for a save that changed nothing, with the database doing the counting', async () => {
    await revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' });
    const again = await revisions.save(EDITOR, { contentId: 'song-1', body: { stanzas: FIRST.stanzas, title: FIRST.title }, origin: 'autosave' });
    expect(again.appended).toBe(false);
    expect(await mongo.db.collection(COLLECTION).countDocuments({})).toBe(1);
  });

  it('addresses a body the same after the database has stored and returned it', async () => {
    const { revision } = await revisions.save(EDITOR, { contentId: 'song-2', body: TAMIL, origin: 'autosave' });
    const read = await revisions.read(EDITOR, 'song-2', 1);
    expect(read?.body).toEqual(TAMIL);
    expect(read?.hash).toBe(revision.hash);
    expect(addressOf(read?.body ?? {})).toBe(revision.hash);
  });

  it('refuses a second revision written under the key one is already stored at', async () => {
    const { revision } = await revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' });
    const rewritten = {
      _id: 'song-1#1',
      ...revision,
      body: { title: 'Edited in place' },
      hash: addressOf({ title: 'Edited in place' }),
    };
    await expect(repositoriesOn(db).contentRevisions.append(EDITOR, rewritten)).rejects.toMatchObject({
      name: 'RepositoryError',
      kind: 'duplicate',
    });
    expect(await mongo.db.collection(COLLECTION).countDocuments({})).toBe(1);
  });

  it('refuses a rewritten revision smuggled in under a key of its own', async () => {
    const { revision } = await revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' });
    const smuggled = { ...revision, _id: 'song-1#1-corrected', body: { title: 'Edited beside it' } };
    const error: unknown = await repositoriesOn(db)
      .contentRevisions.append(EDITOR, smuggled)
      .catch((refusal: unknown) => refusal);
    expect(error).toBeInstanceOf(RepositoryError);
    expect((error as RepositoryError).kind).toBe('duplicate');
    expect(await mongo.db.collection(COLLECTION).countDocuments({})).toBe(1);
  });

  it('leaves history append-only when two writers save the same content at once', async () => {
    const outcomes = await Promise.allSettled([
      revisions.save(EDITOR, { contentId: 'song-3', body: FIRST, origin: 'autosave' }),
      revisions.save(EDITOR, { contentId: 'song-3', body: SECOND, origin: 'autosave' }),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(RevisionError);
    }
    const history = await revisions.history(EDITOR, 'song-3');
    expect(history.map((revision) => revision.revision)).toEqual(history.map((_, index) => index + 1));
    expect(history.length).toBeGreaterThan(0);
  });
});

describe('what the database lets this product do to history', () => {
  let restricted: RestrictedMongo;
  let store: RevisionStore;

  beforeAll(async () => {
    restricted = await startRestrictedMongo(PRIVILEGES);
    const limited = repositoryDb(restricted.db);
    store = revisionsOn(limited, { now: clock() });
    for (const index of REVISION_INDEXES) await createRevisionIndexOn(limited, index);
    await store.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'manual-checkpoint' });
  });

  afterAll(async () => {
    await restricted.stop();
  });

  it('appends, reads and indexes with the privileges the record class declares, and needs no more', async () => {
    const appended = await store.save(EDITOR, { contentId: 'song-1', body: SECOND, origin: 'autosave' });
    expect(appended).toMatchObject({ appended: true, revision: { revision: 2 } });
    expect((await store.history(EDITOR, 'song-1')).map((revision) => revision.revision)).toEqual([1, 2]);
  });

  it('cannot change or remove a revision, because the database refuses the product rather than the code', async () => {
    const collection = restricted.db.collection<StoredRevision>(COLLECTION);
    const attempts = {
      update: () => collection.updateOne({ _id: 'song-1#1' }, { $set: { body: { title: 'Edited in place' } } }),
      replace: () => collection.replaceOne({ _id: 'song-1#1' }, { contentId: 'song-1', revision: 1 }),
      remove: () => collection.deleteOne({ _id: 'song-1#1' }),
      drop: () => collection.drop(),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      await expect(attempt(), name).rejects.toThrow(/not authorized/u);
    }
    const [stored] = await restricted.root.collection<StoredRevision>(COLLECTION).find({ _id: 'song-1#1' }).toArray();
    expect(stored?.body).toEqual(FIRST);
    expect(stored?.hash).toBe(addressOf(FIRST));
  });
});
