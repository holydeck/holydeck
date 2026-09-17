import { describe, expect, it } from 'vitest';

import { requestContext } from './context.js';
import { LIBRARY_PERMISSIONS } from './library.js';
import { RECORDS } from './records.js';
import { RepositoryError } from './repositories.js';
import { addressOf } from './revisions.js';
import { SlideGroupError, slideGroupContext, slideGroupsOn } from './slide-groups.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { Slide, SlideGroupBody } from '@holydeck/contracts/slide-groups';

import type { Document } from './repositories.js';
import type { SlideGroupStore } from './slide-groups.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-17T09:30:00.000Z');

const ADMINISTRATOR = `account:${'C'.repeat(22)}`;

const ADMIN = slideGroupContext(ADMINISTRATOR, 'req-3b7a19de');

const STAMPS = RECORDS.contentLibrary.collection;

const REVISIONS = RECORDS.contentRevisions.collection;

const AUDIT = RECORDS.auditEvents.collection;

const SLIDE_A: Slide = { id: 'slide-1', enabled: true, label: 'Welcome' };

const SLIDE_B: Slide = { id: 'slide-2', enabled: true, label: 'Verse' };

const CUSTOM: SlideGroupBody = { mode: 'custom', enabled: true, slides: [SLIDE_A, SLIDE_B] };

const GENERATED: SlideGroupBody = {
  mode: 'generated',
  enabled: true,
  slides: [SLIDE_A],
  generatedFrom: { songId: 'song-1' },
};

const store = (): { db: FakeDb; groups: SlideGroupStore } => {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  return {
    db,
    groups: slideGroupsOn(db, {
      now: () => new Date(START + (tick += 1) * 1000 - 1000).toISOString(),
      newId: () => `id-${(serial += 1)}`,
    }),
  };
};

const rows = (db: FakeDb, collection: string): Document[] => db.rows.get(collection) ?? [];

const refused = async (call: Promise<unknown>): Promise<SlideGroupError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof SlideGroupError) return error;
    throw error;
  }
  throw new Error('the call was allowed');
};

describe('the lifecycle of a slide group or a reusable slide', () => {
  it('creates a slideGroup, edits, duplicates, enables/disables, and reorders it', async () => {
    const { db, groups } = store();
    const created = await groups.create(ADMIN, 'slideGroup', 'Welcome sequence', CUSTOM);
    expect(created.stamp.kind).toBe('slideGroup');
    expect(created.title).toBe('Welcome sequence');
    expect(created.body).toEqual(CUSTOM);
    expect(rows(db, STAMPS)).toHaveLength(1);
    expect(rows(db, REVISIONS)).toHaveLength(1);
    const id = created.stamp.id;

    const edited = await groups.edit(ADMIN, id, { mode: 'custom', enabled: true, slides: [SLIDE_A] });
    expect(edited?.body.slides).toEqual([SLIDE_A]);
    expect((await groups.current(ADMIN, id))?.body.slides).toEqual([SLIDE_A]);

    const disabledGroup = await groups.disable(ADMIN, id);
    expect(disabledGroup?.body.enabled).toBe(false);
    const enabledGroup = await groups.enable(ADMIN, id);
    expect(enabledGroup?.body.enabled).toBe(true);

    const disabledSlide = await groups.disableSlide(ADMIN, id, SLIDE_A.id);
    expect(disabledSlide?.body.slides).toEqual([{ ...SLIDE_A, enabled: false }]);
    const enabledSlide = await groups.enableSlide(ADMIN, id, SLIDE_A.id);
    expect(enabledSlide?.body.slides).toEqual([SLIDE_A]);

    const duplicatedSlide = await groups.duplicateSlide(ADMIN, id, SLIDE_A.id);
    expect(duplicatedSlide?.body.slides.map((slide) => slide.label)).toEqual(['Welcome', 'Welcome']);
    const copyId = duplicatedSlide?.body.slides[1]?.id;
    expect(copyId).not.toBe(SLIDE_A.id);

    const reordered = await groups.reorderSlides(ADMIN, id, [copyId!, SLIDE_A.id]);
    expect(reordered?.body.slides.map((slide) => slide.id)).toEqual([copyId, SLIDE_A.id]);

    const duplicatedGroup = await groups.duplicate(ADMIN, id);
    expect(duplicatedGroup?.stamp.id).not.toBe(id);
    expect(duplicatedGroup?.body).toEqual(reordered?.body);
  });

  it('creates a reusableSlide the same way, as a one-Slide group', async () => {
    const { groups } = store();
    const body: SlideGroupBody = { mode: 'custom', enabled: true, slides: [SLIDE_A] };
    const created = await groups.create(ADMIN, 'reusableSlide', 'Scripture card', body);
    expect(created.stamp.kind).toBe('reusableSlide');
    expect(created.body.slides).toEqual([SLIDE_A]);
  });

  it('answers nothing for an id nobody created', async () => {
    const { groups } = store();
    expect(await groups.current(ADMIN, 'nope')).toBeUndefined();
    expect(await groups.edit(ADMIN, 'nope', CUSTOM)).toBeUndefined();
    expect(await groups.duplicate(ADMIN, 'nope')).toBeUndefined();
    expect(await groups.enable(ADMIN, 'nope')).toBeUndefined();
    expect(await groups.disable(ADMIN, 'nope')).toBeUndefined();
    expect(await groups.enableSlide(ADMIN, 'nope', SLIDE_A.id)).toBeUndefined();
    expect(await groups.disableSlide(ADMIN, 'nope', SLIDE_A.id)).toBeUndefined();
    expect(await groups.duplicateSlide(ADMIN, 'nope', SLIDE_A.id)).toBeUndefined();
    expect(await groups.reorderSlides(ADMIN, 'nope', [])).toBeUndefined();
    expect(await groups.regenerate(ADMIN, 'nope', GENERATED)).toBeUndefined();
    expect(await groups.history(ADMIN, 'nope')).toEqual([]);
  });
});

describe('a generated group is a deterministic projection', () => {
  it('regenerating with a byte-identical body appends nothing, twice over', async () => {
    const { db, groups } = store();
    const created = await groups.create(ADMIN, 'slideGroup', 'Song words', GENERATED);
    const id = created.stamp.id;
    expect(rows(db, REVISIONS)).toHaveLength(1);

    const first = await groups.regenerate(ADMIN, id, GENERATED);
    const second = await groups.regenerate(ADMIN, id, GENERATED);

    expect(first?.body).toEqual(GENERATED);
    expect(second?.body).toEqual(GENERATED);
    expect(rows(db, REVISIONS)).toHaveLength(1);
  });

  it('regenerating with a changed body appends a new revision on top', async () => {
    const { db, groups } = store();
    const created = await groups.create(ADMIN, 'slideGroup', 'Song words', GENERATED);
    const id = created.stamp.id;
    const changed: SlideGroupBody = { ...GENERATED, slides: [SLIDE_A, SLIDE_B] };
    const regenerated = await groups.regenerate(ADMIN, id, changed);
    expect(regenerated?.body).toEqual(changed);
    expect(rows(db, REVISIONS)).toHaveLength(2);
  });
});

describe('a custom group is never overwritten by regeneration, symmetrically', () => {
  it('regenerate refuses a custom group, writing no new revision', async () => {
    const { db, groups } = store();
    const created = await groups.create(ADMIN, 'slideGroup', 'Hand built', CUSTOM);
    const before = rows(db, REVISIONS).length;
    const error = await refused(groups.regenerate(ADMIN, created.stamp.id, GENERATED));
    expect(error.kind).toBe('state');
    expect(error.message).toContain('never overwritten by regeneration');
    expect(rows(db, REVISIONS)).toHaveLength(before);
  });

  it('edit refuses a generated group, writing no new revision', async () => {
    const { db, groups } = store();
    const created = await groups.create(ADMIN, 'slideGroup', 'Song words', GENERATED);
    const before = rows(db, REVISIONS).length;
    const error = await refused(groups.edit(ADMIN, created.stamp.id, CUSTOM));
    expect(error.kind).toBe('state');
    expect(error.message).toContain('only changed by regenerating it');
    expect(rows(db, REVISIONS)).toHaveLength(before);
  });

  it('duplicate always produces a custom copy, dropping generatedFrom, regardless of source mode', async () => {
    const { groups } = store();
    const created = await groups.create(ADMIN, 'slideGroup', 'Song words', GENERATED);
    const duplicated = await groups.duplicate(ADMIN, created.stamp.id);
    expect(duplicated?.body).toEqual({ mode: 'custom', enabled: true, slides: GENERATED.slides });
    expect(duplicated?.body.generatedFrom).toBeUndefined();
  });
});

describe('reordering slides', () => {
  it('refuses a reorder that does not name exactly the current slides, once each', async () => {
    const { groups } = store();
    const created = await groups.create(ADMIN, 'slideGroup', 'Two slides', CUSTOM);
    const id = created.stamp.id;

    const missing = await refused(groups.reorderSlides(ADMIN, id, [SLIDE_A.id]));
    expect(missing.kind).toBe('schema');

    const duped = await refused(groups.reorderSlides(ADMIN, id, [SLIDE_A.id, SLIDE_A.id]));
    expect(duped.kind).toBe('schema');

    const foreign = await refused(groups.reorderSlides(ADMIN, id, [SLIDE_A.id, 'nope']));
    expect(foreign.kind).toBe('schema');
  });

  it('refuses naming a slide the group does not hold', async () => {
    const { groups } = store();
    const created = await groups.create(ADMIN, 'slideGroup', 'Two slides', CUSTOM);
    const error = await refused(groups.enableSlide(ADMIN, created.stamp.id, 'nope'));
    expect(error.kind).toBe('schema');
    expect(error.message).toContain('nope');
  });
});

describe('a stamp with no body is corrupt, not missing', () => {
  it('refuses reading a slide group whose revision was never written', async () => {
    const { db, groups } = store();
    const created = await groups.create(ADMIN, 'slideGroup', 'Orphaned', CUSTOM);
    db.rows.set(REVISIONS, []);
    const error = await refused(groups.current(ADMIN, created.stamp.id));
    expect(error.kind).toBe('corrupt');
    expect(error.message).toContain(created.stamp.id);
  });

  it('refuses a body this build cannot read, rather than serving it', async () => {
    const { db, groups } = store();
    const created = await groups.create(ADMIN, 'slideGroup', 'Malformed', CUSTOM);
    const [revision] = rows(db, REVISIONS);
    const body = { mode: 'custom' };
    db.rows.set(REVISIONS, [{ ...revision, body, hash: addressOf(body) }]);
    const error = await refused(groups.current(ADMIN, created.stamp.id));
    expect(error.kind).toBe('corrupt');
    expect(error.message).toContain('group.enabled');
  });
});

describe('the permission boundary between naming an item and holding its body', () => {
  it.each([
    'current',
    'edit',
    'duplicate',
    'enable',
    'disable',
    'enableSlide',
    'disableSlide',
    'duplicateSlide',
    'reorderSlides',
    'regenerate',
    'history',
  ] as const)('refuses %s without contentRevisions permission', async (verb) => {
    const { db, groups } = store();
    const created = await groups.create(ADMIN, 'slideGroup', 'Guarded', CUSTOM);
    const id = created.stamp.id;
    const reader = requestContext({
      actor: ADMINISTRATOR,
      permissions: Object.values(LIBRARY_PERMISSIONS),
      correlationId: ADMIN.correlationId,
    });
    const stamps = [...rows(db, STAMPS)];
    const revisions = [...rows(db, REVISIONS)];

    const calls = {
      current: () => groups.current(reader, id),
      edit: () => groups.edit(reader, id, CUSTOM),
      duplicate: () => groups.duplicate(reader, id),
      enable: () => groups.enable(reader, id),
      disable: () => groups.disable(reader, id),
      enableSlide: () => groups.enableSlide(reader, id, SLIDE_A.id),
      disableSlide: () => groups.disableSlide(reader, id, SLIDE_A.id),
      duplicateSlide: () => groups.duplicateSlide(reader, id, SLIDE_A.id),
      reorderSlides: () => groups.reorderSlides(reader, id, [SLIDE_A.id, SLIDE_B.id]),
      regenerate: () => groups.regenerate(reader, id, GENERATED),
      history: () => groups.history(reader, id),
    } as const;

    await expect(calls[verb]()).rejects.toMatchObject({
      name: 'RepositoryError',
      kind: 'permission',
      message: expect.stringContaining('contentRevisions') as unknown as string,
    });
    expect(rows(db, STAMPS)).toEqual(stamps);
    expect(rows(db, REVISIONS)).toEqual(revisions);
  });
});

describe('this store never touches the audit trail', () => {
  it('leaves audit_events empty across the whole lifecycle', async () => {
    const { db, groups } = store();
    const created = await groups.create(ADMIN, 'slideGroup', 'Quiet', CUSTOM);
    const id = created.stamp.id;
    await groups.edit(ADMIN, id, { mode: 'custom', enabled: true, slides: [SLIDE_A] });
    await groups.enable(ADMIN, id);
    await groups.disable(ADMIN, id);
    await groups.enableSlide(ADMIN, id, SLIDE_A.id);
    await groups.disableSlide(ADMIN, id, SLIDE_A.id);
    const dup = await groups.duplicateSlide(ADMIN, id, SLIDE_A.id);
    await groups.reorderSlides(ADMIN, id, dup!.body.slides.map((slide) => slide.id).reverse());
    await groups.duplicate(ADMIN, id);
    await groups.history(ADMIN, id);
    expect(rows(db, AUDIT)).toEqual([]);
  });
});

describe('what the Slide Group store is reached through', () => {
  it('grants both the library and the revision permissions together', () => {
    expect(ADMIN.permissions).toContain('contentLibrary.append');
    expect(ADMIN.permissions).toContain('contentRevisions.append');
  });

  it('refuses an actor the records layer would not let append at all', async () => {
    const { groups } = store();
    const reader = requestContext({ actor: ADMINISTRATOR, permissions: [], correlationId: 'req-3b7a19de' });
    await expect(groups.create(reader, 'slideGroup', 'Nope', CUSTOM)).rejects.toBeInstanceOf(RepositoryError);
  });
});
