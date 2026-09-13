import { describe, expect, it } from 'vitest';

import { requestContext } from './context.js';
import { privilegesFor, RECORDS } from './records.js';
import { RepositoryError } from './repositories.js';
import {
  addressOf,
  createRevisionIndexOn,
  REVISION_INDEXES,
  REVISION_PERMISSIONS,
  RevisionError,
  revisionsOn,
} from './revisions.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { RevisionOrigin } from '@holydeck/contracts/revisions';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { RevisionStore } from './revisions.js';

const START = Date.parse('2026-09-13T09:30:00.000Z');

const EDITOR = requestContext({
  actor: 'account:7f3a',
  permissions: [REVISION_PERMISSIONS.append, REVISION_PERMISSIONS.read],
  correlationId: 'req-0f9c2a41',
});

const COLLECTION = RECORDS.contentRevisions.collection;

const FIRST = { title: 'Andru', stanzas: ['Andru varum naal'] };
const SECOND = { title: 'Andru', stanzas: ['Andru varum naal', 'Ennai meetka vanthaar'] };

const store = (): { db: FakeDb; revisions: RevisionStore } => {
  const db = fakeDb();
  let tick = 0;
  return { db, revisions: revisionsOn(db, { now: () => new Date(START + tick++ * 1000).toISOString() }) };
};

const rows = (db: FakeDb): Record<string, unknown>[] => (db.rows.get(COLLECTION) ?? []) as Record<string, unknown>[];

const refused = async (call: Promise<unknown>): Promise<RevisionError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof RevisionError) return error;
    throw error;
  }
  throw new Error('the call was allowed');
};

const rejected = async (call: Promise<unknown>): Promise<RepositoryError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof RepositoryError) return error;
    throw error;
  }
  throw new Error('the call was allowed');
};

describe('appending a revision', () => {
  it('appends exactly one hash-addressed revision when the body changed', async () => {
    const { db, revisions } = store();
    const first = await revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' });
    expect(first).toMatchObject({ appended: true, revision: { revision: 1, hash: addressOf(FIRST) } });
    expect(rows(db)).toHaveLength(1);

    const second = await revisions.save(EDITOR, { contentId: 'song-1', body: SECOND, origin: 'autosave' });
    expect(second).toMatchObject({ appended: true, revision: { revision: 2, hash: addressOf(SECOND) } });
    expect(rows(db)).toHaveLength(2);
  });

  it('keys a revision by its content and ordinal, so a second revision 1 is a duplicate key', async () => {
    const { db, revisions } = store();
    await revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' });
    expect(rows(db)[0]).toMatchObject({ _id: 'song-1#1' });
  });

  it('records who saved it, under which request, and when, from the context and one clock', async () => {
    const { revisions } = store();
    const { revision } = await revisions.save(EDITOR, {
      contentId: 'song-1',
      body: FIRST,
      origin: 'manual-checkpoint',
    });
    expect(revision).toMatchObject({
      contentId: 'song-1',
      origin: 'manual-checkpoint',
      actor: EDITOR.actor,
      correlationId: EDITOR.correlationId,
      at: new Date(START).toISOString(),
    });
  });

  it('appends nothing when the save changed nothing, and answers with the revision that stands', async () => {
    const { db, revisions } = store();
    await revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' });
    const again = await revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' });
    expect(again.appended).toBe(false);
    expect(again.revision.revision).toBe(1);
    expect(rows(db)).toHaveLength(1);
  });

  it('treats a body written in another order as the same body, because the address is canonical', async () => {
    const { db, revisions } = store();
    await revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' });
    const reordered = { stanzas: [...FIRST.stanzas], title: FIRST.title };
    const again = await revisions.save(EDITOR, { contentId: 'song-1', body: reordered, origin: 'manual-checkpoint' });
    expect(again.appended).toBe(false);
    expect(rows(db)).toHaveLength(1);
  });

  it('keeps one content’s history apart from another’s', async () => {
    const { revisions } = store();
    await revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' });
    const other = await revisions.save(EDITOR, { contentId: 'song-2', body: SECOND, origin: 'autosave' });
    expect(other.revision.revision).toBe(1);
    expect(await revisions.count(EDITOR, 'song-1')).toBe(1);
  });

  it('refuses a revision it could not read back, rather than writing one', async () => {
    const { db, revisions } = store();
    const separator = await refused(revisions.save(EDITOR, { contentId: 'song#1', body: FIRST, origin: 'autosave' }));
    expect(separator.kind).toBe('schema');
    const origin = await refused(
      revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'restore' as RevisionOrigin }),
    );
    expect(origin.message).toContain('origin');
    expect(rows(db)).toHaveLength(0);
  });

  it('refuses an ordinal another writer reached first, because the database refused the key', async () => {
    const { db, revisions } = store();
    db.failOn = () => Object.assign(new Error('E11000 duplicate key'), { code: 11_000 });
    const error = await refused(revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' }));
    expect(error.kind).toBe('conflict');
    expect(error.message).toContain('song-1');
  });

  it('refuses a caller the record class does not let read its own history', async () => {
    const { revisions } = store();
    const stranger = requestContext({ actor: 'account:0001', permissions: [], correlationId: 'req-1111' });
    const error = await rejected(revisions.save(stranger, { contentId: 'song-1', body: FIRST, origin: 'autosave' }));
    expect(error.kind).toBe('permission');
  });

  it('passes a reader who may not append back to the repository that refused them', async () => {
    const { db, revisions } = store();
    const reader = requestContext({
      actor: 'account:0002',
      permissions: [REVISION_PERMISSIONS.read],
      correlationId: 'req-2222',
    });
    const error = await rejected(revisions.save(reader, { contentId: 'song-1', body: FIRST, origin: 'autosave' }));
    expect(error.kind).toBe('permission');
    expect(rows(db)).toHaveLength(0);
  });

  it('leaves a context it cannot read to the repository, which refuses it before anything is written', async () => {
    const { db, revisions } = store();
    const error = await rejected(revisions.save({}, { contentId: 'song-1', body: FIRST, origin: 'autosave' }));
    expect(error.kind).toBe('context');
    expect(rows(db)).toHaveLength(0);
  });

  it('lets a failure that is not a conflict reach the caller as it came', async () => {
    const { db, revisions } = store();
    db.failOn = () => new Error('the connection dropped mid-write');
    await expect(revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' })).rejects.toThrow(
      'the connection dropped mid-write',
    );
  });
});

describe('reading history back', () => {
  const written = async (): Promise<{ db: FakeDb; revisions: RevisionStore }> => {
    const made = store();
    await made.revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' });
    await made.revisions.save(EDITOR, { contentId: 'song-1', body: SECOND, origin: 'manual-checkpoint' });
    return made;
  };

  it('reads the whole history in the order it was appended', async () => {
    const { revisions } = await written();
    expect((await revisions.history(EDITOR, 'song-1')).map((revision) => revision.revision)).toEqual([1, 2]);
  });

  it('reads the revision that stands, and nothing for content that has no history yet', async () => {
    const { revisions } = await written();
    expect(await revisions.current(EDITOR, 'song-1')).toMatchObject({ revision: 2, hash: addressOf(SECOND) });
    expect(await revisions.current(EDITOR, 'song-2')).toBeUndefined();
  });

  it('reads one revision by its ordinal, and nothing for an ordinal that was never written', async () => {
    const { revisions } = await written();
    expect(await revisions.read(EDITOR, 'song-1', 1)).toMatchObject({ body: FIRST });
    expect(await revisions.read(EDITOR, 'song-1', 9)).toBeUndefined();
  });

  it('counts what is there', async () => {
    const { revisions } = await written();
    expect(await revisions.count(EDITOR, 'song-1')).toBe(2);
  });

  it('refuses a body that no longer matches the address it was written under', async () => {
    const { db, revisions } = await written();
    const [stored] = rows(db);
    if (stored !== undefined) stored['body'] = { title: 'Edited in place' };
    const error = await refused(revisions.history(EDITOR, 'song-1'));
    expect(error.kind).toBe('corrupt');
    expect(error.message).toContain('no longer addresses its body');
  });

  it('refuses a record it cannot read as a revision at all', async () => {
    const { db, revisions } = await written();
    rows(db).push({ _id: 'song-1#3', contentId: 'song-1' });
    const error = await refused(revisions.history(EDITOR, 'song-1'));
    expect(error.kind).toBe('corrupt');
  });

  it('refuses a record stored under a key that is not its own', async () => {
    const { db, revisions } = await written();
    const [stored] = rows(db);
    if (stored !== undefined) stored['_id'] = 'song-1#9';
    const error = await refused(revisions.history(EDITOR, 'song-1'));
    expect(error.kind).toBe('corrupt');
    expect(error.message).toContain('song-1#9');
  });

  it('refuses a history with a gap in it, because nothing is ever removed', async () => {
    const { db, revisions } = await written();
    rows(db).splice(0, 1);
    const error = await refused(revisions.history(EDITOR, 'song-1'));
    expect(error.kind).toBe('corrupt');
    expect(error.message).toContain('history starts at revision 1');
  });
});

describe('restoring an earlier revision', () => {
  it('appends the restored body as a new revision and leaves history where it was', async () => {
    const { db, revisions } = store();
    await revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' });
    await revisions.save(EDITOR, { contentId: 'song-1', body: SECOND, origin: 'autosave' });
    const before = JSON.stringify(rows(db));

    const restored = await revisions.restore(EDITOR, { contentId: 'song-1', revision: 1 });
    expect(restored).toMatchObject({
      appended: true,
      from: 1,
      revision: { revision: 3, hash: addressOf(FIRST), origin: 'manual-checkpoint' },
    });
    expect(rows(db)).toHaveLength(3);
    expect(JSON.stringify(rows(db).slice(0, 2))).toBe(before);
    expect((await revisions.history(EDITOR, 'song-1')).map((revision) => revision.hash)).toEqual([
      addressOf(FIRST),
      addressOf(SECOND),
      addressOf(FIRST),
    ]);
  });

  it('appends nothing when the revision being restored is the one that already stands', async () => {
    const { db, revisions } = store();
    await revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' });
    const restored = await revisions.restore(EDITOR, { contentId: 'song-1', revision: 1 });
    expect(restored).toMatchObject({ appended: false, from: 1 });
    expect(rows(db)).toHaveLength(1);
  });

  it('refuses to restore a revision that was never written', async () => {
    const { revisions } = store();
    await revisions.save(EDITOR, { contentId: 'song-1', body: FIRST, origin: 'autosave' });
    const error = await refused(revisions.restore(EDITOR, { contentId: 'song-1', revision: 4 }));
    expect(error.kind).toBe('missing');
    expect(error.message).toContain('song-1');
  });
});

describe('what the store asks of the database', () => {
  it('builds the index its reads are sorted by, and refuses one it does not declare', async () => {
    const { db } = store();
    for (const index of REVISION_INDEXES) expect(await createRevisionIndexOn(db, index)).toBe(index.name);
    expect(db.indexes.get(COLLECTION)).toEqual(['content_revision']);
    const undeclared = (): unknown => createRevisionIndexOn(db, { name: 'by_actor', keys: { actor: 1 }, options: {} });
    expect(undeclared).toThrow(RevisionError);
    expect(undeclared).toThrow('is not an index the revision store declares');
  });

  it('needs the append permission of its own record class, and nothing invented beside it', () => {
    expect(REVISION_PERMISSIONS).toEqual({ read: 'contentRevisions.read', append: 'contentRevisions.append' });
  });

  it('needs no privilege that could change or remove what is already there', () => {
    const privileges = privilegesFor('contentRevisions');
    expect(privileges.collection).toBe(COLLECTION);
    expect([...privileges.actions]).toEqual(['createIndex', 'dropIndex', 'find', 'insert', 'listIndexes']);
  });
});
