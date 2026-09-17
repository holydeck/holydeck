import { beforeEach, describe, expect, test } from 'vitest';

import { shelfKey } from '@holydeck/contracts/collaboration';

import {
  ConflictError,
  RESOLUTION_ORIGIN,
  SHELF_INDEXES,
  SHELF_PERMISSIONS,
  SHELF_RECORD,
  conflictShelfOn,
} from './conflicts.js';
import { requestContext } from './context.js';
import { RECORDS } from './records.js';
import { REVISION_PERMISSIONS, RevisionError, revisionsOn } from './revisions.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { RevisionBody } from '@holydeck/contracts/revisions';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { ConflictShelf } from './conflicts.js';
import type { Document, RepositoryCollection, RepositoryDb } from './repositories.js';
import type { RevisionStore } from './revisions.js';

const START = Date.parse('2026-09-17T09:30:00.000Z');

const SONG = 'song-1';

const HELD = { title: 'Andru', stanzas: ['Andru varum naal'] };
const ADAS = { title: 'Andru', stanzas: ['Andru varum naal', 'Ennai meetka vanthaar'] };
const GRACES = { title: 'Andru', stanzas: ['Andru varum naal', 'Ennai thedi vanthaar'] };
const SETTLED = { title: 'Andru', stanzas: ['Andru varum naal', 'Ennai meetka vanthaar', 'Ennai thedi vanthaar'] };

const editor = (actor: string): unknown =>
  requestContext({
    actor,
    permissions: [
      REVISION_PERMISSIONS.append,
      REVISION_PERMISSIONS.read,
      SHELF_PERMISSIONS.append,
      SHELF_PERMISSIONS.read,
    ],
    correlationId: `req-${actor.slice(-4)}`,
  });

const ADA = editor('account:7f3a');
const GRACE = editor('account:b2c9');

const REVISIONS = RECORDS.contentRevisions.collection;
const SHELF = RECORDS.conflictShelf.collection;

let db: FakeDb;
let revisions: RevisionStore;
let shelf: ConflictShelf;
let tick: number;

const now = (): string => new Date(START + tick++ * 1000).toISOString();

const rows = (collection: string): Document[] => db.rows.get(collection) ?? [];

/**
 * A database that lets one writer land in the middle of another's save, which is the only way a duplicate
 * ordinal happens in real life: both writers read the same standing revision, and the second one to insert
 * finds the key taken. Everything else about it is the ordinary fake.
 */
const racing = (run: () => Promise<unknown>): RepositoryDb => {
  let pending: (() => Promise<unknown>) | undefined = run;
  return {
    collection(name: string): RepositoryCollection {
      const inner = db.collection(name);
      if (name !== REVISIONS) return inner;
      return {
        ...inner,
        async insertOne(document: Document) {
          const other = pending;
          pending = undefined;
          if (other !== undefined) await other();
          return inner.insertOne(document);
        },
      };
    },
  };
};

/** Ada saves through the wrapper while Grace's save lands underneath her. Ada loses the ordinal. */
const lose = async (body: RevisionBody = ADAS, winner: RevisionBody = GRACES): Promise<RevisionError> => {
  const contested = revisionsOn(racing(() => revisions.save(GRACE, { contentId: SONG, body: winner, origin: 'autosave' })), {
    now,
  });
  try {
    await shelf.saveWithConflictPreservation(ADA, contested, { contentId: SONG, body, origin: 'autosave' });
  } catch (error) {
    if (error instanceof RevisionError) return error;
    throw error;
  }
  throw new Error('the save was allowed');
};

beforeEach(() => {
  db = fakeDb();
  tick = 0;
  revisions = revisionsOn(db, { now });
  shelf = conflictShelfOn(db, { now });
});

describe('what the conflict shelf owns', () => {
  test('is a record class of its own, append-only, reached through its own permissions', () => {
    expect(SHELF_RECORD).toBe('conflictShelf');
    expect(RECORDS.conflictShelf.kind).toBe('append-only');
    expect(SHELF_PERMISSIONS).toEqual({ read: 'conflictShelf.read', append: 'conflictShelf.append' });
    expect(SHELF).toBe('conflict_shelf');
  });

  test('declares one index, unique, so a shelf grows by one whichever writer is appending', () => {
    expect(SHELF_INDEXES).toEqual([
      { name: 'conflict_shelf_entry', keys: { contentId: 1, sequence: 1 }, options: { unique: true } },
    ]);
  });
});

describe('an edit that wins its race', () => {
  test('is the ordinary save, and nothing is shelved', async () => {
    const outcome = await shelf.saveWithConflictPreservation(ADA, revisions, {
      contentId: SONG,
      body: HELD,
      origin: 'autosave',
    });
    expect(outcome).toMatchObject({ appended: true, revision: { revision: 1 } });
    expect(rows(SHELF)).toEqual([]);
  });

  test('is still the ordinary save when it changed nothing at all', async () => {
    await revisions.save(ADA, { contentId: SONG, body: HELD, origin: 'autosave' });
    const again = await shelf.saveWithConflictPreservation(ADA, revisions, {
      contentId: SONG,
      body: HELD,
      origin: 'autosave',
    });
    expect(again.appended).toBe(false);
    expect(rows(SHELF)).toEqual([]);
  });
});

describe('an edit that loses its race', () => {
  beforeEach(async () => {
    await revisions.save(ADA, { contentId: SONG, body: HELD, origin: 'autosave' });
  });

  test('is refused exactly as it was before this shelf existed, with the revision store’s own error', async () => {
    const error = await lose();
    expect(error).toBeInstanceOf(RevisionError);
    expect(error.kind).toBe('conflict');
    expect(error.message).toContain(SONG);
    expect(error.name).toBe('RevisionError');
  });

  test('keeps the body it was carrying, the ordinal it wanted, and who was writing it', async () => {
    await lose();
    const [entry] = await shelf.entries(ADA, SONG);
    expect(entry).toEqual({
      kind: 'shelved',
      contentId: SONG,
      sequence: 1,
      attempted: 2,
      origin: 'autosave',
      body: ADAS,
      at: expect.any(String) as unknown as string,
      actor: 'account:7f3a',
      correlationId: 'req-7f3a',
    });
  });

  test('leaves both edits readable: the winner in history, the loser on the shelf', async () => {
    await lose();
    const history = await revisions.history(ADA, SONG);
    expect(history.map((revision) => revision.body)).toEqual([HELD, GRACES]);
    expect((await shelf.outstanding(ADA, SONG)).map((entry) => entry.body)).toEqual([ADAS]);
  });

  test('keys each shelved row by its content and its place, so a second row at one place collides', async () => {
    await lose();
    expect(rows(SHELF)[0]).toMatchObject({ _id: shelfKey(SONG, 1) });
  });

  test('shelves a second loss beside the first rather than over it', async () => {
    await lose();
    await lose({ title: 'Andru', stanzas: ['Andru varum naal', 'Yaar ivar'] }, { title: 'Andru', stanzas: ['Yaar ivar'] });
    const held = await shelf.entries(ADA, SONG);
    expect(held.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(await shelf.outstanding(ADA, SONG)).toHaveLength(2);
  });

  test('shelves one content’s losses apart from another’s', async () => {
    await lose();
    expect(await shelf.entries(ADA, 'song-2')).toEqual([]);
  });

  test('passes on a refusal that was never a conflict, and shelves nothing for it', async () => {
    await expect(
      shelf.saveWithConflictPreservation(ADA, revisions, { contentId: 'song#9', body: ADAS, origin: 'autosave' }),
    ).rejects.toMatchObject({ kind: 'schema' });
    expect(rows(SHELF)).toEqual([]);
  });
});

describe('settling a shelved conflict', () => {
  beforeEach(async () => {
    await revisions.save(ADA, { contentId: SONG, body: HELD, origin: 'autosave' });
    await lose();
  });

  test('appends the settled body as the next ordinary revision, recorded as the checkpoint it is', async () => {
    const outcome = await shelf.resolveConflict(ADA, revisions, {
      contentId: SONG,
      shelfEntryId: shelfKey(SONG, 1),
      resolvedBody: SETTLED,
    });
    expect(outcome).toMatchObject({
      appended: true,
      over: 2,
      revision: { revision: 3, body: SETTLED, origin: RESOLUTION_ORIGIN },
    });
  });

  test('discards neither input: the winner stays where it was and the loser stays on the shelf', async () => {
    await shelf.resolveConflict(ADA, revisions, {
      contentId: SONG,
      shelfEntryId: shelfKey(SONG, 1),
      resolvedBody: SETTLED,
    });
    const history = await revisions.history(ADA, SONG);
    expect(history.map((revision) => revision.body)).toEqual([HELD, GRACES, SETTLED]);

    const held = await shelf.entries(ADA, SONG);
    expect(held[0]).toMatchObject({ kind: 'shelved', sequence: 1, body: ADAS });
  });

  test('marks it settled by appending a note beside it rather than writing over it', async () => {
    const before = [...rows(SHELF)];
    const { marker } = await shelf.resolveConflict(ADA, revisions, {
      contentId: SONG,
      shelfEntryId: shelfKey(SONG, 1),
      resolvedBody: SETTLED,
    });
    expect(marker).toMatchObject({ kind: 'resolved', sequence: 2, resolves: 1, revision: 3, actor: 'account:7f3a' });
    expect(rows(SHELF)).toHaveLength(2);
    expect(rows(SHELF)[0]).toEqual(before[0]);
    expect(await shelf.outstanding(ADA, SONG)).toEqual([]);
  });

  test('records who settled it, which need not be whoever lost it', async () => {
    const { marker } = await shelf.resolveConflict(GRACE, revisions, {
      contentId: SONG,
      shelfEntryId: shelfKey(SONG, 1),
      resolvedBody: SETTLED,
    });
    expect(marker).toMatchObject({ actor: 'account:b2c9', correlationId: 'req-b2c9' });
    expect((await shelf.entries(ADA, SONG))[0]).toMatchObject({ actor: 'account:7f3a' });
  });

  test('settles one conflict and leaves another outstanding', async () => {
    await lose({ title: 'Andru', stanzas: ['Andru varum naal', 'Yaar ivar'] }, { title: 'Andru', stanzas: ['Yaar ivar'] });
    await shelf.resolveConflict(ADA, revisions, {
      contentId: SONG,
      shelfEntryId: shelfKey(SONG, 2),
      resolvedBody: SETTLED,
    });
    expect((await shelf.outstanding(ADA, SONG)).map((entry) => entry.sequence)).toEqual([1]);
  });

  test('refuses a conflict that is not there, and one on another content', async () => {
    const missing = await shelf
      .resolveConflict(ADA, revisions, { contentId: SONG, shelfEntryId: shelfKey(SONG, 9), resolvedBody: SETTLED })
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(ConflictError);
    expect(missing).toMatchObject({ kind: 'missing' });

    await expect(
      shelf.resolveConflict(ADA, revisions, { contentId: 'song-2', shelfEntryId: shelfKey(SONG, 1), resolvedBody: SETTLED }),
    ).rejects.toMatchObject({ kind: 'missing' });
  });

  test('refuses to settle a conflict twice, because a conflict is settled once', async () => {
    const settle = (): Promise<unknown> =>
      shelf.resolveConflict(ADA, revisions, {
        contentId: SONG,
        shelfEntryId: shelfKey(SONG, 1),
        resolvedBody: SETTLED,
      });
    await settle();
    await expect(settle()).rejects.toMatchObject({ kind: 'state' });
  });

  test('refuses to settle the note that settled something, which is not a conflict', async () => {
    await shelf.resolveConflict(ADA, revisions, {
      contentId: SONG,
      shelfEntryId: shelfKey(SONG, 1),
      resolvedBody: SETTLED,
    });
    await expect(
      shelf.resolveConflict(ADA, revisions, { contentId: SONG, shelfEntryId: shelfKey(SONG, 2), resolvedBody: HELD }),
    ).rejects.toMatchObject({ kind: 'state' });
  });
});

describe('what the shelf refuses to read back', () => {
  test('a row it cannot read as an entry at all', async () => {
    await db.collection(SHELF).insertOne({
      _id: shelfKey(SONG, 1),
      contentId: SONG,
      sequence: 1,
      kind: 'shelved',
      at: '2026-09-17T09:30:00.000Z',
      actor: 'account:7f3a',
      correlationId: 'req-7f3a',
    });
    const error = await shelf.entries(ADA, SONG).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toMatchObject({ kind: 'corrupt' });
  });

  test('a shelved conflict standing over a history nothing could have won', async () => {
    await db.collection(SHELF).insertOne({
      _id: shelfKey(SONG, 1),
      contentId: SONG,
      sequence: 1,
      kind: 'shelved',
      attempted: 1,
      origin: 'autosave',
      body: ADAS,
      at: '2026-09-17T09:30:00.000Z',
      actor: 'account:7f3a',
      correlationId: 'req-7f3a',
    });
    await expect(
      shelf.resolveConflict(ADA, revisions, { contentId: SONG, shelfEntryId: shelfKey(SONG, 1), resolvedBody: SETTLED }),
    ).rejects.toMatchObject({ kind: 'corrupt' });
  });

  test('a row stored under a key that is not the place it claims to be', async () => {
    await db.collection(SHELF).insertOne({
      _id: shelfKey(SONG, 7),
      contentId: SONG,
      sequence: 1,
      kind: 'resolved',
      resolves: 1,
      revision: 2,
      at: '2026-09-17T09:30:00.000Z',
      actor: 'account:7f3a',
      correlationId: 'req-7f3a',
    });
    await expect(shelf.entries(ADA, SONG)).rejects.toMatchObject({ kind: 'corrupt' });
  });
});

describe('who may reach the shelf', () => {
  test('nobody without the record class’s own permissions', async () => {
    const stranger = requestContext({
      actor: 'account:7f3a',
      permissions: [REVISION_PERMISSIONS.append, REVISION_PERMISSIONS.read],
      correlationId: 'req-7f3a',
    });
    await expect(shelf.entries(stranger, SONG)).rejects.toMatchObject({ kind: 'permission' });
  });
});
