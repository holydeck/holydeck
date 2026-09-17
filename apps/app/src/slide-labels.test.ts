import { describe, expect, it } from 'vitest';

import { SHORTCUT_KEYS } from '@holydeck/contracts/slide-labels';

import { RECORDS } from './records.js';
import { SlideLabelError, slideLabelContext, slideLabelsOn } from './slide-labels.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { Document } from './repositories.js';
import type { SlideLabelStore } from './slide-labels.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-17T09:30:00.000Z');

const ADMINISTRATOR = `account:${'D'.repeat(22)}`;

const ADMIN = slideLabelContext(ADMINISTRATOR, 'req-7a31c04e');

const LABELS = RECORDS.slideLabels.collection;

const store = (): { db: FakeDb; labels: SlideLabelStore } => {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  return {
    db,
    labels: slideLabelsOn(db, {
      now: () => new Date(START + (tick += 1) * 1000 - 1000).toISOString(),
      newId: () => `label-${(serial += 1)}`,
    }),
  };
};

const rows = (db: FakeDb): Document[] => db.rows.get(LABELS) ?? [];

const refused = async (call: Promise<unknown>): Promise<SlideLabelError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof SlideLabelError) return error;
    throw error;
  }
  throw new Error('the call was allowed');
};

const names = (catalogue: readonly { readonly name: string }[]): string[] => catalogue.map((entry) => entry.name);

describe('managing the global slide-label catalogue', () => {
  it('creates labels, with and without a live shortcut, and offers every one of them', async () => {
    const { db, labels } = store();
    const verse = await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    expect(verse.stamp.kind).toBe('slideLabel');
    expect(verse.stamp.id).toBe('label-1');
    expect(verse.shortcut).toBe('1');

    const bridge = await labels.create(ADMIN, { name: 'Bridge' });
    expect(bridge.shortcut).toBeUndefined();

    expect(names(await labels.catalogue(ADMIN))).toEqual(['Verse', 'Bridge']);
    expect(await labels.get(ADMIN, 'label-1')).toEqual(verse);
    expect(rows(db)).toHaveLength(2);
  });

  it('renames a label, moves its shortcut, and takes a shortcut away, one append each time', async () => {
    const { db, labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });

    const renamed = await labels.edit(ADMIN, 'label-1', { name: 'Verse 1', shortcut: '1' });
    expect(renamed).toMatchObject({ name: 'Verse 1', shortcut: '1' });

    const moved = await labels.edit(ADMIN, 'label-1', { name: 'Verse 1', shortcut: '4' });
    expect(moved?.shortcut).toBe('4');

    const unbound = await labels.edit(ADMIN, 'label-1', { name: 'Verse 1' });
    expect(unbound?.shortcut).toBeUndefined();
    expect((await labels.catalogue(ADMIN))[0]).toEqual({ id: 'label-1', name: 'Verse 1' });

    // One row per change, none rewritten: the standing stamp is the highest ordinal the label has.
    expect(rows(db)).toHaveLength(4);
    expect(rows(db).map((row) => row['sequence'])).toEqual([1, 2, 3, 4]);
    expect((await labels.get(ADMIN, 'label-1'))?.stamp.updatedBy).toBe(ADMINISTRATOR);
  });

  it('stops offering an archived label and frees the key it held, listing it all the same', async () => {
    const { labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });

    const archived = await labels.archive(ADMIN, 'label-1');
    expect(archived?.stamp.archivedAt).toBeDefined();
    expect(archived?.shortcut).toBe('1');
    expect(await labels.catalogue(ADMIN)).toEqual([]);
    expect(names(await labels.list(ADMIN))).toEqual(['Verse']);

    // The whole point of `archive: 'hidden'` here: the key comes back into the space.
    const chorus = await labels.create(ADMIN, { name: 'Chorus', shortcut: '1' });
    expect(chorus.shortcut).toBe('1');
  });

  it('offers an archived label again, and refuses to when its key was given away meanwhile', async () => {
    const { labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    await labels.archive(ADMIN, 'label-1');
    expect((await labels.unarchive(ADMIN, 'label-1'))?.stamp.archivedAt).toBeUndefined();
    expect(names(await labels.catalogue(ADMIN))).toEqual(['Verse']);

    await labels.archive(ADMIN, 'label-1');
    await labels.create(ADMIN, { name: 'Chorus', shortcut: '1' });
    const error = await refused(labels.unarchive(ADMIN, 'label-1'));
    expect(error.kind).toBe('conflict');
    expect(error.conflicts).toEqual([{ field: 'shortcut', claimed: '1', heldBy: 'label-2' }]);
    expect(await labels.catalogue(ADMIN)).toHaveLength(1);
  });

  it('answers with nothing for a label that was never created', async () => {
    const { labels } = store();
    expect(await labels.get(ADMIN, 'label-nope')).toBeUndefined();
    expect(await labels.edit(ADMIN, 'label-nope', { name: 'Verse' })).toBeUndefined();
    expect(await labels.archive(ADMIN, 'label-nope')).toBeUndefined();
    expect(await labels.unarchive(ADMIN, 'label-nope')).toBeUndefined();
    expect(await labels.list(ADMIN)).toEqual([]);
  });

  it('refuses to change an archived label, because archiving is what stops one changing', async () => {
    const { db, labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    await labels.archive(ADMIN, 'label-1');
    const before = rows(db).length;
    const error = await refused(labels.edit(ADMIN, 'label-1', { name: 'Verse 1' }));
    expect(error.kind).toBe('state');
    expect(rows(db)).toHaveLength(before);
  });
});

describe('a conflicting claim is refused by name, and nothing is written', () => {
  it('refuses a second label claiming a shortcut that is already bound', async () => {
    const { db, labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    const error = await refused(labels.create(ADMIN, { name: 'Chorus', shortcut: '1' }));

    expect(error).toBeInstanceOf(SlideLabelError);
    expect(error.name).toBe('SlideLabelError');
    expect(error.kind).toBe('conflict');
    expect(error.conflicts).toEqual([{ field: 'shortcut', claimed: '1', heldBy: 'label-1' }]);
    expect(error.message).toContain('the shortcut 1 is already held by label-1');

    expect(rows(db)).toHaveLength(1);
    expect(names(await labels.catalogue(ADMIN))).toEqual(['Verse']);
  });

  it('refuses an edit that would move a shortcut onto one already bound, leaving the label as it was', async () => {
    const { db, labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    await labels.create(ADMIN, { name: 'Chorus', shortcut: '2' });
    const error = await refused(labels.edit(ADMIN, 'label-2', { name: 'Chorus', shortcut: '1' }));

    expect(error.kind).toBe('conflict');
    expect(error.conflicts).toEqual([{ field: 'shortcut', claimed: '1', heldBy: 'label-1' }]);
    expect(rows(db)).toHaveLength(2);
    expect((await labels.get(ADMIN, 'label-2'))?.shortcut).toBe('2');
  });

  it('refuses a second label called what one is already called, for the same reason', async () => {
    const { db, labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    const error = await refused(labels.create(ADMIN, { name: 'Verse', shortcut: '2' }));
    expect(error.kind).toBe('conflict');
    expect(error.conflicts).toEqual([{ field: 'name', claimed: 'Verse', heldBy: 'label-1' }]);
    expect(rows(db)).toHaveLength(1);
  });

  it('names every rule the claim broke at once, rather than one refusal per attempt', async () => {
    const { labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    await labels.create(ADMIN, { name: 'Chorus', shortcut: '2' });
    const error = await refused(labels.create(ADMIN, { name: 'Verse', shortcut: '2' }));
    expect(error.conflicts).toEqual([
      { field: 'name', claimed: 'Verse', heldBy: 'label-1' },
      { field: 'shortcut', claimed: '2', heldBy: 'label-2' },
    ]);
  });

  it('lets a label keep its own name and key across an edit, which is what renaming one costs nothing', async () => {
    const { labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    expect(await labels.edit(ADMIN, 'label-1', { name: 'Verse', shortcut: '1' })).toMatchObject({ name: 'Verse' });
  });

  it('refuses a shortcut outside the key space this product ships, stamping nothing to hold it', async () => {
    const { db, labels } = store();
    const error = await refused(labels.create(ADMIN, { name: 'Verse', shortcut: 'v' } as never));
    expect(error.kind).toBe('schema');
    expect(error.message).toContain('slideLabel.shortcut');
    expect(error.conflicts).toEqual([]);
    expect(rows(db)).toEqual([]);
  });

  it('refuses a label nobody named, before it reads the catalogue at all', async () => {
    const { db, labels } = store();
    const error = await refused(labels.create(ADMIN, { name: '' }));
    expect(error.kind).toBe('schema');
    expect(error.message).toContain('slideLabel.name');
    expect(rows(db)).toEqual([]);
  });

  it('refuses an identifier another writer stamped first, rather than appending beside it', async () => {
    const { db } = store();
    let tick = 0;
    const labels = slideLabelsOn(db, {
      now: () => new Date(START + (tick += 1) * 1000).toISOString(),
      newId: () => 'label-once',
    });
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    const error = await refused(labels.create(ADMIN, { name: 'Chorus', shortcut: '2' }));
    expect(error.kind).toBe('conflict');
    expect(error.message).toContain('label-once');
    expect(rows(db)).toHaveLength(1);
  });

  it('mints an identifier of its own when nothing hands one in, so a caller never has to', async () => {
    const db = fakeDb();
    const labels = slideLabelsOn(db, { now: () => new Date(START).toISOString() });
    const first = await labels.create(ADMIN, { name: 'Verse' });
    const second = await labels.create(ADMIN, { name: 'Chorus' });

    expect(first.stamp.id).toMatch(/^[\w-]{20,}$/u);
    expect(second.stamp.id).not.toBe(first.stamp.id);
  });

  it('says a stamp the database refused as a duplicate was another writer’s, not a bad claim', async () => {
    const { db, labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    // What a real race looks like from here: the ordinal was free when it was read and taken by the time
    // it was written, which only the unique index can notice.
    db.failOn = (): Error => Object.assign(new Error('E11000 duplicate key: label-1#2'), { code: 11_000 });

    const error = await refused(labels.edit(ADMIN, 'label-1', { name: 'Verse 1' }));
    expect(error.kind).toBe('conflict');
    expect(error.message).toContain('another writer stamped this label first');
    expect(rows(db)).toHaveLength(1);
  });

  it('keeps the whole key space usable at once, and refuses the eleventh claim on any of it', async () => {
    const { labels } = store();
    for (const key of SHORTCUT_KEYS) await labels.create(ADMIN, { name: `Label ${key}`, shortcut: key });
    expect(await labels.catalogue(ADMIN)).toHaveLength(SHORTCUT_KEYS.length);
    for (const key of SHORTCUT_KEYS) {
      const error = await refused(labels.create(ADMIN, { name: `Another ${key}`, shortcut: key }));
      expect(error.kind, key).toBe('conflict');
      expect(error.conflicts.map((conflict) => conflict.field), key).toEqual(['shortcut']);
    }
    // A label with no key is still a label: the space bounds jumping, never the size of the catalogue.
    expect((await labels.create(ADMIN, { name: 'Reading' })).shortcut).toBeUndefined();
  });
});

describe('an Editor assigns a label the catalogue already held', () => {
  it('reads back the whole entry, so what jumps to the slide is known where it is chosen', async () => {
    const { labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    expect(await labels.assign(ADMIN, 'Verse')).toEqual({ id: 'label-1', name: 'Verse', shortcut: '1' });
  });

  it('refuses an ad-hoc label nobody added to the catalogue', async () => {
    const { labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    const error = await refused(labels.assign(ADMIN, 'Verse 4'));
    expect(error.kind).toBe('schema');
    expect(error.message).toContain('must name a label of the global slide-label catalogue');
  });

  it('refuses a label that has been archived, because an archived one is no longer offered', async () => {
    const { labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    await labels.archive(ADMIN, 'label-1');
    expect((await refused(labels.assign(ADMIN, 'Verse'))).kind).toBe('schema');
  });
});

describe('a stored label this build cannot read is corrupt, not absent', () => {
  it('refuses a row stamped with a name or an ordinal it cannot read', async () => {
    const { db, labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    const [row] = rows(db);
    db.rows.set(LABELS, [{ ...row, name: 7 }]);
    expect((await refused(labels.get(ADMIN, 'label-1'))).kind).toBe('corrupt');
  });

  it('refuses a row holding a stamp it cannot read', async () => {
    const { db, labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    const [row] = rows(db);
    db.rows.set(LABELS, [{ ...row, stamp: { id: 'label-1' } }]);
    const error = await refused(labels.catalogue(ADMIN));
    expect(error.kind).toBe('corrupt');
    expect(error.message).toContain('entity.kind');
  });

  it('refuses a row that is missing the identifier a catalogue is grouped by', async () => {
    const { db, labels } = store();
    await labels.create(ADMIN, { name: 'Verse', shortcut: '1' });
    const [row] = rows(db);
    db.rows.set(LABELS, [{ ...row, labelId: 7 }]);
    expect((await refused(labels.list(ADMIN))).kind).toBe('corrupt');
  });
});
