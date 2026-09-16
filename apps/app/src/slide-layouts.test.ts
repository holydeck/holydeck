import { describe, expect, it } from 'vitest';

import { requestContext } from './context.js';
import { RECORDS } from './records.js';
import { RepositoryError } from './repositories.js';
import { addressOf } from './revisions.js';
import {
  LAYOUT_INDEXES,
  LAYOUT_PERMISSIONS,
  SlideLayoutError,
  slideLayoutContext,
  slideLayoutsOn,
  subjectFor,
} from './slide-layouts.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { SlideLayoutBody } from '@holydeck/contracts/layouts';

import type { Document } from './repositories.js';
import type { SlideLayoutStore } from './slide-layouts.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-13T09:30:00.000Z');

const ADMINISTRATOR = `account:${'C'.repeat(22)}`;

const ADMIN = slideLayoutContext(ADMINISTRATOR, 'req-0f9c2a41');

const STAMPS = RECORDS.slideLayouts.collection;

const REVISIONS = RECORDS.contentRevisions.collection;

const text = {
  id: 'lyric',
  kind: 'text',
  importance: 'required',
  frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
  binding: { mode: 'keyed', contentKind: 'song', contentKey: 'lyricLine', languageKey: 'ta' },
  style: {
    fontFamily: 'Inter',
    fontWeight: 600,
    sizeRatio: 0.08,
    lineHeight: 1.25,
    align: 'center',
    verticalAlign: 'center',
  },
} as const;

const backdrop = {
  id: 'backdrop',
  kind: 'media',
  importance: 'decoration',
  frame: { x: 0, y: 0, width: 1, height: 1 },
  style: { fit: 'cover', opacity: 0.4 },
} as const;

const ONE: SlideLayoutBody = { boxes: [text] };

const TWO: SlideLayoutBody = { boxes: [backdrop, text] };

const DRAFT = { name: 'Sermon point', body: ONE };

const store = (): { db: FakeDb; layouts: SlideLayoutStore } => {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  return {
    db,
    layouts: slideLayoutsOn(db, {
      now: () => new Date(START + (tick += 1) * 1000 - 1000).toISOString(),
      newId: () => `layout-${(serial += 1)}`,
    }),
  };
};

const rows = (db: FakeDb, collection: string): Document[] => db.rows.get(collection) ?? [];

/** What the database says when a second writer has already taken the key a write is aimed at. */
const duplicateKey = (): Error => Object.assign(new Error('E11000 duplicate key'), { code: 11_000 });

const refused = async (call: Promise<unknown>): Promise<SlideLayoutError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof SlideLayoutError) return error;
    throw error;
  }
  throw new Error('the call was allowed');
};

describe('creating a Slide Layout', () => {
  it('stamps a live entity, appends its first revision, and hands both back', async () => {
    const { db, layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    expect(created).toEqual({
      stamp: {
        id: 'layout-1',
        kind: 'slideLayout',
        schemaVersion: 1,
        createdAt: '2026-09-13T09:30:00.000Z',
        createdBy: ADMINISTRATOR,
        updatedAt: '2026-09-13T09:30:00.000Z',
        updatedBy: ADMINISTRATOR,
        archivedAt: undefined,
        archivedBy: undefined,
      },
      name: 'Sermon point',
      revision: 1,
      at: '2026-09-13T09:30:01.000Z',
      body: ONE,
    });
    expect(rows(db, STAMPS)).toHaveLength(1);
    expect(rows(db, REVISIONS)).toHaveLength(1);
  });

  it('round-trips the boxes it was given through the revision it wrote', async () => {
    const { layouts } = store();
    const created = await layouts.create(ADMIN, { name: 'Two boxes', body: TWO });
    expect((await layouts.preview(ADMIN, created.stamp.id))?.body).toEqual(TWO);
  });

  it('writes the geometry before the stamp, so nothing is ever a Layout with no boxes', async () => {
    const { db, layouts } = store();
    db.failOn = (collection) => (collection === REVISIONS ? new Error('the disk went away') : undefined);
    await expect(layouts.create(ADMIN, DRAFT)).rejects.toThrow('the disk went away');
    expect(rows(db, REVISIONS)).toHaveLength(0);
    // Had the stamp gone first it would be here now, naming a Layout whose geometry was never written.
    expect(rows(db, STAMPS)).toHaveLength(0);
  });

  it('refuses boxes it could not read back, before anything at all is written', async () => {
    const { db, layouts } = store();
    const unpositioned = { boxes: [{ ...text, frame: { x: 0.1 } }] } as unknown as SlideLayoutBody;
    const error = await refused(layouts.create(ADMIN, { name: 'Unplaced', body: unpositioned }));
    expect(error.kind).toBe('schema');
    expect(error.message).toContain('layout.boxes.0.frame.y');
    expect(rows(db, STAMPS)).toHaveLength(0);
    expect(rows(db, REVISIONS)).toHaveLength(0);
  });

  it('refuses an identifier another Layout already stands on, before writing a box of its own', async () => {
    const { db, layouts } = store();
    const first = await layouts.create(ADMIN, DRAFT);
    const twice = slideLayoutsOn(db, {
      now: () => new Date(START).toISOString(),
      newId: () => first.stamp.id,
    });

    const error = await refused(twice.create(ADMIN, { name: 'Another arrangement', body: TWO }));

    expect(error.kind).toBe('conflict');
    // The Layout that stands on the identifier is the one that was there: its boxes are its own.
    expect((await layouts.preview(ADMIN, first.stamp.id))?.body).toEqual(ONE);
    expect(rows(db, REVISIONS)).toHaveLength(1);
    expect(rows(db, STAMPS)).toHaveLength(1);
  });

  it('refuses an actor the records layer would not let append', async () => {
    const { layouts } = store();
    const reader = requestContext({ actor: ADMINISTRATOR, permissions: [], correlationId: 'req-0f9c2a41' });
    await expect(layouts.create(reader, DRAFT)).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('previewing a Slide Layout', () => {
  it('reads the standing revision back without changing either store', async () => {
    const { db, layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    const before = [rows(db, STAMPS).length, rows(db, REVISIONS).length];
    expect(await layouts.preview(ADMIN, created.stamp.id)).toEqual(created);
    expect([rows(db, STAMPS).length, rows(db, REVISIONS).length]).toEqual(before);
  });

  it('reads a named earlier revision, which is what previewing history is', async () => {
    const { layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    await layouts.version(ADMIN, created.stamp.id, TWO);
    expect((await layouts.preview(ADMIN, created.stamp.id))?.body).toEqual(TWO);
    expect((await layouts.preview(ADMIN, created.stamp.id, 1))?.body).toEqual(ONE);
    expect(await layouts.preview(ADMIN, created.stamp.id, 9)).toBeUndefined();
  });

  it('answers nothing for a Layout nobody made', async () => {
    const { layouts } = store();
    expect(await layouts.preview(ADMIN, 'layout-404')).toBeUndefined();
    expect(await layouts.version(ADMIN, 'layout-404', ONE)).toBeUndefined();
    expect(await layouts.archive(ADMIN, 'layout-404')).toBeUndefined();
    expect(await layouts.unarchive(ADMIN, 'layout-404')).toBeUndefined();
    expect(await layouts.restoreVersion(ADMIN, 'layout-404', 1)).toBeUndefined();
    expect(await layouts.history(ADMIN, 'layout-404')).toEqual([]);
  });

  it('refuses geometry this build cannot read, rather than serving it', async () => {
    const { db, layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    const [revision] = rows(db, REVISIONS);
    const body = { boxes: 'lyric' };
    db.rows.set(REVISIONS, [{ ...revision, body, hash: addressOf(body) }]);
    const error = await refused(layouts.preview(ADMIN, created.stamp.id));
    expect(error.kind).toBe('corrupt');
    expect(error.message).toContain('layout.boxes');
  });

  it('refuses a revision that no longer addresses the body it was written for', async () => {
    const { db, layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    const [revision] = rows(db, REVISIONS);
    db.rows.set(REVISIONS, [{ ...revision, body: { boxes: [{ ...text, importance: 'decoration' }] } }]);
    const error = await refused(layouts.preview(ADMIN, created.stamp.id));
    expect(error.kind).toBe('corrupt');
    expect(error.message).toContain('no longer addresses its body');
  });

  it('refuses a stamp this build cannot read, for the same reason', async () => {
    const { db, layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    const [row] = rows(db, STAMPS);
    db.rows.set(STAMPS, [{ ...row, stamp: { id: created.stamp.id } }]);
    expect((await refused(layouts.preview(ADMIN, created.stamp.id))).message).toContain('entity.kind');
    db.rows.set(STAMPS, [{ ...row, name: 7 }]);
    const error = await refused(layouts.preview(ADMIN, created.stamp.id));
    expect(error.kind).toBe('corrupt');
    expect(error.message).toContain('layout-1');
  });
});

describe('versioning a Slide Layout', () => {
  it('appends a second revision when the boxes changed, and touches the stamp that owns them', async () => {
    const { db, layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    expect(await layouts.version(ADMIN, created.stamp.id, TWO)).toEqual({ appended: true, revision: 2 });
    expect(rows(db, REVISIONS)).toHaveLength(2);
    expect(rows(db, STAMPS)).toHaveLength(2);
    const preview = await layouts.preview(ADMIN, created.stamp.id);
    expect(preview?.stamp.updatedAt).toBe('2026-09-13T09:30:02.000Z');
    expect(preview?.stamp.createdAt).toBe('2026-09-13T09:30:00.000Z');
    expect(preview?.name).toBe('Sermon point');
  });

  it('appends nothing at all when the boxes did not change, not even a stamp', async () => {
    const { db, layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    // The same boxes, written in another key order: the same Layout, and so not a change to it.
    const same = {
      boxes: [{ ...text, style: { ...text.style }, frame: { height: 0.5, width: 0.8, y: 0.2, x: 0.1 } }],
    } as unknown as SlideLayoutBody;
    expect(await layouts.version(ADMIN, created.stamp.id, same)).toEqual({ appended: false, revision: 1 });
    expect(rows(db, REVISIONS)).toHaveLength(1);
    expect(rows(db, STAMPS)).toHaveLength(1);
  });

  it('refuses boxes it could not read back, and refuses a Layout that has been archived', async () => {
    const { layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    expect((await refused(layouts.version(ADMIN, created.stamp.id, { boxes: [] }))).kind).toBe('schema');
    await layouts.archive(ADMIN, created.stamp.id);
    const archived = await refused(layouts.version(ADMIN, created.stamp.id, TWO));
    expect(archived.kind).toBe('state');
    expect(archived.message).toContain(created.stamp.id);
  });

  it('publishes nothing at all when it loses the race for the ordinal it was stamping', async () => {
    const { db, layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    const before = await layouts.history(ADMIN, created.stamp.id);
    // Exactly what a second writer reaching the same ordinal produces, and nothing else: the stamp
    // collides on its unique key while the revision store is untouched.
    db.failOn = (collection) => (collection === STAMPS ? duplicateKey() : undefined);

    const error = await refused(layouts.version(ADMIN, created.stamp.id, TWO));

    expect(error.kind).toBe('conflict');
    db.failOn = undefined;
    // A caller told it lost is a caller nothing of whose was written: the boxes it sent are not standing.
    expect(await layouts.history(ADMIN, created.stamp.id)).toEqual(before);
    expect((await layouts.preview(ADMIN, created.stamp.id))?.body).toEqual(ONE);
  });

  it('refuses a Layout stamped over boxes that are not there, rather than starting them over', async () => {
    const { db, layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    db.rows.set(REVISIONS, []);
    const error = await refused(layouts.version(ADMIN, created.stamp.id, TWO));
    expect(error.kind).toBe('corrupt');
    expect(error.message).toContain(created.stamp.id);
    expect(rows(db, STAMPS)).toHaveLength(1);
  });
});

describe('archiving a Slide Layout and bringing it back', () => {
  it('hides it by stamping it archived, which is what its kind says archiving does', async () => {
    const { db, layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    const archived = await layouts.archive(ADMIN, created.stamp.id);
    expect(archived?.stamp).toMatchObject({
      archivedAt: '2026-09-13T09:30:02.000Z',
      archivedBy: ADMINISTRATOR,
      updatedAt: '2026-09-13T09:30:02.000Z',
    });
    expect(rows(db, STAMPS)).toHaveLength(2);
    // The geometry is untouched by the visibility of the Layout that holds it.
    expect(rows(db, REVISIONS)).toHaveLength(1);
  });

  it('refuses to archive one that is already archived, rather than stamping it twice', async () => {
    const { db, layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    await layouts.archive(ADMIN, created.stamp.id);
    const error = await refused(layouts.archive(ADMIN, created.stamp.id));
    expect(error.kind).toBe('state');
    expect(error.message).toContain('is already archived');
    expect(rows(db, STAMPS)).toHaveLength(2);
  });

  it('brings an archived Layout back live, and refuses to bring back one that never left', async () => {
    const { layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    await layouts.archive(ADMIN, created.stamp.id);
    const restored = await layouts.unarchive(ADMIN, created.stamp.id);
    expect(restored?.stamp.archivedAt).toBeUndefined();
    expect(restored?.stamp.archivedBy).toBeUndefined();
    const error = await refused(layouts.unarchive(ADMIN, created.stamp.id));
    expect(error.kind).toBe('state');
    expect(error.message).toContain('is not archived');
  });
});

describe('restoring an earlier version of the boxes', () => {
  it('appends the earlier body forward and rewrites nothing that was already history', async () => {
    const { layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    await layouts.version(ADMIN, created.stamp.id, TWO);
    const before = await layouts.history(ADMIN, created.stamp.id);
    expect(before).toHaveLength(2);

    expect(await layouts.restoreVersion(ADMIN, created.stamp.id, 1)).toEqual({
      appended: true,
      revision: 3,
      from: 1,
    });

    const after = await layouts.history(ADMIN, created.stamp.id);
    expect(after).toHaveLength(before.length + 1);
    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    expect(after[2]?.body).toEqual(ONE);
    expect(after[2]?.origin).toBe('manual-checkpoint');
    expect((await layouts.preview(ADMIN, created.stamp.id))?.body).toEqual(ONE);
  });

  it('answers nothing for a revision the Layout never had, and refuses one that is archived', async () => {
    const { layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    expect(await layouts.restoreVersion(ADMIN, created.stamp.id, 9)).toBeUndefined();
    await layouts.archive(ADMIN, created.stamp.id);
    expect((await refused(layouts.restoreVersion(ADMIN, created.stamp.id, 1))).kind).toBe('state');
  });

  it('appends nothing when the revision restored is the one already standing', async () => {
    const { db, layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    expect(await layouts.restoreVersion(ADMIN, created.stamp.id, 1)).toEqual({
      appended: false,
      revision: 1,
      from: 1,
    });
    expect(rows(db, REVISIONS)).toHaveLength(1);
    expect(rows(db, STAMPS)).toHaveLength(1);
  });

  it('publishes nothing at all when it loses the race for the ordinal it was stamping', async () => {
    const { db, layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    await layouts.version(ADMIN, created.stamp.id, TWO);
    const before = await layouts.history(ADMIN, created.stamp.id);
    db.failOn = (collection) => (collection === STAMPS ? duplicateKey() : undefined);

    const error = await refused(layouts.restoreVersion(ADMIN, created.stamp.id, 1));

    expect(error.kind).toBe('conflict');
    db.failOn = undefined;
    expect(await layouts.history(ADMIN, created.stamp.id)).toEqual(before);
    expect((await layouts.preview(ADMIN, created.stamp.id))?.body).toEqual(TWO);
  });
});

describe('what the Slide Layout store is reached through', () => {
  it('names its own permissions after its record class, and a Layout after its kind', () => {
    expect(LAYOUT_PERMISSIONS).toEqual({ read: 'slideLayouts.read', append: 'slideLayouts.append' });
    expect(subjectFor('layout-1')).toBe('slideLayout:layout-1');
    expect(ADMIN.permissions).toContain('contentRevisions.append');
  });

  it('names a Layout with an identifier nobody guesses, when nothing names one for it', async () => {
    const layouts = slideLayoutsOn(fakeDb(), { now: () => new Date(START).toISOString() });
    const created = await layouts.create(ADMIN, DRAFT);
    expect(created.stamp.id).toMatch(/^[\w-]{22}$/u);
  });

  it('declares the one index its own reads are served by, and no other', () => {
    expect(LAYOUT_INDEXES.map((index) => index.name)).toEqual(['slide_layout_stamp']);
    expect(LAYOUT_INDEXES[0]).toMatchObject({ keys: { layoutId: 1, sequence: -1 }, options: { unique: true } });
  });

  it('refuses a second writer that claimed the same place in the stamp history', async () => {
    const { db, layouts } = store();
    const created = await layouts.create(ADMIN, DRAFT);
    const [row] = rows(db, STAMPS);
    db.rows.set(STAMPS, [{ ...row, _id: `${created.stamp.id}#2` }, ...rows(db, STAMPS)]);
    const error = await refused(layouts.archive(ADMIN, created.stamp.id));
    expect(error.kind).toBe('conflict');
  });
});
