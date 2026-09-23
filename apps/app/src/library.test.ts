import { describe, expect, it } from 'vitest';

import { LIBRARY_KINDS } from '@holydeck/contracts/library';

import { requestContext } from './context.js';
import {
  LIBRARY_INDEXES,
  LIBRARY_PERMISSIONS,
  LibraryError,
  libraryContext,
  libraryOn,
  subjectFor,
} from './library.js';
import { RECORDS } from './records.js';
import { RepositoryError } from './repositories.js';
import { serviceContext, servicesOn } from './services.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { ServiceSection } from '@holydeck/contracts/services';

import type { Document } from './repositories.js';
import type { LibraryStore } from './library.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-13T09:30:00.000Z');
const LIBRARIAN = `account:${'L'.repeat(22)}`;
const CTX = libraryContext(LIBRARIAN, 'req-9a41c2f0');
const STAMPS = RECORDS.contentLibrary.collection;

const store = (): { db: FakeDb; library: LibraryStore } => {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  return {
    db,
    library: libraryOn(db, {
      now: () => new Date(START + (tick += 1) * 1000 - 1000).toISOString(),
      newId: () => `library-${(serial += 1)}`,
    }),
  };
};

const rows = (db: FakeDb, collection: string): Document[] => db.rows.get(collection) ?? [];
const duplicateKey = (): Error => Object.assign(new Error('E11000 duplicate key'), { code: 11_000 });

const refused = async (call: Promise<unknown>): Promise<LibraryError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof LibraryError) return error;
    throw error;
  }
  throw new Error('the call was allowed');
};

describe('discovering content the instant it is created', () => {
  it('resolves a freshly created item through both get and list before anything else references it', async () => {
    const { library } = store();
    const created = await library.create(CTX, { kind: 'song', title: 'Amazing Grace' });
    expect(created.title).toBe('Amazing Grace');
    expect(created.stamp.kind).toBe('song');
    const id = created.stamp.id;
    expect(await library.get(CTX, id)).toEqual(created);
    expect(await library.list(CTX)).toEqual([created]);
  });
});

describe('the library store has no promotion verb', () => {
  it('exposes exactly create, get, and list, nothing that moves an item from local to global', () => {
    const { library } = store();
    expect(Object.keys(library).sort()).toEqual(['create', 'get', 'list']);
  });

  it.each(LIBRARY_KINDS)('accepts %s as a kind create() can mint', async (kind) => {
    const { library } = store();
    const created = await library.create(CTX, { kind, title: `A ${kind}` });
    expect(created.stamp.kind).toBe(kind);
    expect(created.title).toBe(`A ${kind}`);
  });
});

describe('listing the library', () => {
  it('filters to one kind rather than promoting anything', async () => {
    const { library } = store();
    const sermon = await library.create(CTX, { kind: 'sermon', title: 'Grace Abounding' });
    await library.create(CTX, { kind: 'song', title: 'Amazing Grace' });
    expect(await library.list(CTX, { kind: 'sermon' })).toEqual([sermon]);
  });

  it('filters titles by a case-insensitive partial query', async () => {
    const { library } = store();
    const matched = await library.create(CTX, { kind: 'song', title: 'Amazing Grace' });
    await library.create(CTX, { kind: 'sermon', title: 'Grace Abounding' });
    expect(await library.list(CTX, { q: 'MAZING' })).toEqual([matched]);
    expect(await library.list(CTX, { q: 'missing' })).toEqual([]);
  });

  it('excludes archived rows by default and includes them when asked', async () => {
    const { db, library } = store();
    const stamp = {
      id: 'archived-1', kind: 'song', schemaVersion: 1,
      createdAt: '2026-09-13T09:30:00.000Z', createdBy: LIBRARIAN,
      updatedAt: '2026-09-13T09:30:01.000Z', updatedBy: LIBRARIAN,
      archivedAt: '2026-09-13T09:30:02.000Z', archivedBy: LIBRARIAN,
    };
    db.rows.set(STAMPS, [{ _id: 'archived-1#1', contentId: 'archived-1', sequence: 1, at: stamp.updatedAt, title: 'Archived Song', stamp, actor: LIBRARIAN, correlationId: CTX.correlationId }]);
    expect(await library.list(CTX)).toEqual([]);
    expect((await library.list(CTX, { archived: true })).map((row) => row.title)).toEqual(['Archived Song']);
  });

  it('reduces a standing row by highest sequence via a Map, not by row order or a database sort', async () => {
    const { db, library } = store();
    const stamp = {
      id: 'content-1', kind: 'song', schemaVersion: 1,
      createdAt: '2026-09-13T09:30:00.000Z', createdBy: LIBRARIAN,
      updatedAt: '2026-09-13T09:30:01.000Z', updatedBy: LIBRARIAN,
      archivedAt: undefined, archivedBy: undefined,
    };
    // The higher sequence is pushed first, which is the order a naive first-row-wins reduction (or a
    // fake DB whose sort only honours the first key of a compound sort) would get wrong.
    db.rows.set(STAMPS, [
      { _id: 'content-1#2', contentId: 'content-1', sequence: 2, at: stamp.updatedAt, title: 'Newer Title', stamp, actor: LIBRARIAN, correlationId: CTX.correlationId },
      { _id: 'content-1#1', contentId: 'content-1', sequence: 1, at: stamp.createdAt, title: 'Older Title', stamp, actor: LIBRARIAN, correlationId: CTX.correlationId },
    ]);
    expect((await library.get(CTX, 'content-1'))?.title).toBe('Newer Title');
    expect((await library.list(CTX))[0]?.title).toBe('Newer Title');
  });
});

describe('content survives the deletion of every service that referenced it', () => {
  it('still resolves the same title after the referencing service is archived', async () => {
    const db = fakeDb();
    let tick = 0;
    const now = (): string => new Date(START + (tick += 1) * 1000 - 1000).toISOString();
    const library = libraryOn(db, { now, newId: () => 'song-1' });
    const services = servicesOn(db, { now, newId: () => 'service-1' });

    const song = await library.create(libraryContext(LIBRARIAN, 'req-lib'), { kind: 'song', title: 'Amazing Grace' });
    const sections: readonly ServiceSection[] = [
      {
        id: 'section-1', name: 'Worship',
        items: [{ id: 'item-1', kind: 'song', title: 'Amazing Grace', enabled: true, content: { id: song.stamp.id, revision: 1, hash: 'fnv1a-6fe1d1e9' } }],
      },
    ];
    const created = await services.create(serviceContext(LIBRARIAN, 'req-svc'), {
      title: 'Sunday Morning', date: '2026-09-13', site: 'Main Hall', sections,
    });
    await services.archive(serviceContext(LIBRARIAN, 'req-svc'), created.stamp.id);

    expect(await library.get(libraryContext(LIBRARIAN, 'req-lib'), song.stamp.id)).toEqual(song);
  });
});

describe('refusing a bad call', () => {
  it('surfaces a colliding stamp write as a conflict', async () => {
    const { db, library } = store();
    db.failOn = (collection) => (collection === STAMPS ? duplicateKey() : undefined);
    const error = await refused(library.create(CTX, { kind: 'song', title: 'Amazing Grace' }));
    expect(error.kind).toBe('conflict');
    db.failOn = undefined;
    expect(rows(db, STAMPS)).toEqual([]);
  });

  it('refuses an identifier another writer already named, without restamping it', async () => {
    const { db, library } = store();
    const first = await library.create(CTX, { kind: 'song', title: 'Amazing Grace' });
    const collision = libraryOn(db, { now: () => new Date(START).toISOString(), newId: () => first.stamp.id });
    const error = await refused(collision.create(CTX, { kind: 'sermon', title: 'Another item' }));
    expect(error.kind).toBe('conflict');
    expect(await library.get(CTX, first.stamp.id)).toEqual(first);
    expect(rows(db, STAMPS)).toHaveLength(1);
  });

  it('refuses a draft this is not a library kind', async () => {
    const { db, library } = store();
    const error = await refused(library.create(CTX, { kind: 'nonsense', title: 'x' } as never));
    expect(error.kind).toBe('schema');
    expect(rows(db, STAMPS)).toEqual([]);
  });

  it('refuses a listed row with no identifier of its own', async () => {
    const { db, library } = store();
    db.rows.set(STAMPS, [
      { _id: 'broken#1', sequence: 1, at: '2026-09-13T09:30:00.000Z', title: 'Broken', stamp: { id: 'broken' }, actor: LIBRARIAN, correlationId: CTX.correlationId },
    ]);
    expect((await refused(library.list(CTX))).kind).toBe('corrupt');
  });

  it('refuses a row whose stamp this code cannot read, from both get and list', async () => {
    const { db, library } = store();
    db.rows.set(STAMPS, [
      { _id: 'content-1#1', contentId: 'content-1', sequence: 1, at: '2026-09-13T09:30:00.000Z', title: 'Broken', stamp: { id: 'content-1' }, actor: LIBRARIAN, correlationId: CTX.correlationId },
    ]);
    expect((await refused(library.get(CTX, 'content-1'))).kind).toBe('corrupt');
    expect((await refused(library.list(CTX))).kind).toBe('corrupt');
  });

  it('passes through repository permission and context refusals untouched', async () => {
    const { library } = store();
    const reader = requestContext({ actor: LIBRARIAN, permissions: [LIBRARY_PERMISSIONS.read], correlationId: 'req-1' });
    await expect(library.create(reader, { kind: 'song', title: 'x' })).rejects.toBeInstanceOf(RepositoryError);
    await expect(library.get(undefined, 'content-1')).rejects.toMatchObject({ kind: 'context' });
  });
});

describe('what the library store is reached through', () => {
  it('declares its permissions and audit subject shape', () => {
    expect(LIBRARY_PERMISSIONS).toEqual({ read: 'contentLibrary.read', append: 'contentLibrary.append' });
    expect(subjectFor('content-1')).toBe('library:content-1');
    expect(CTX.permissions).toEqual(['contentLibrary.read', 'contentLibrary.append']);
  });

  it('declares the unique content library stamp index its standing reads use', () => {
    expect(LIBRARY_INDEXES).toEqual([
      { name: 'content_library_stamp', keys: { contentId: 1, sequence: -1 }, options: { unique: true } },
    ]);
  });

  it('generates an unpredictable id when no id factory is supplied', async () => {
    const library = libraryOn(fakeDb(), { now: () => new Date(START).toISOString() });
    expect((await library.create(CTX, { kind: 'song', title: 'x' })).stamp.id).toMatch(/^[\w-]{22}$/u);
  });
});
