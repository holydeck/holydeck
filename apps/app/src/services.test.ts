import { parseService } from '@holydeck/contracts/services';
import { describe, expect, it } from 'vitest';

import { CATEGORY_OF } from './audit.js';
import { requestContext } from './context.js';
import { RECORDS } from './records.js';
import { RepositoryError } from './repositories.js';
import {
  SERVICE_INDEXES,
  SERVICE_PERMISSIONS,
  ServiceError,
  serviceContext,
  servicesOn,
  subjectFor,
} from './services.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { ServiceDraft, ServiceSection } from '@holydeck/contracts/services';

import type { Document } from './repositories.js';
import type { ServiceStore } from './services.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-13T09:30:00.000Z');
const ADMINISTRATOR = `account:${'C'.repeat(22)}`;
const ADMIN = serviceContext(ADMINISTRATOR, 'req-0f9c2a41');
const STAMPS = RECORDS.services.collection;
const AUDIT = RECORDS.auditEvents.collection;

const SECTIONS: readonly ServiceSection[] = [
  {
    id: 'section-2', name: 'Worship', items: [
      { id: 'item-3', kind: 'song', title: 'Amazing Grace', enabled: true, content: { id: 'song-4', revision: 'rev-5', hash: 'fnv1a-6fe1d1e9' } },
      { id: 'item-1', kind: 'custom-slide', title: 'Welcome', enabled: true, content: undefined },
    ],
  },
  {
    id: 'section-1', name: 'Word', items: [
      { id: 'item-4', kind: 'sermon', title: 'Grace', enabled: true, content: { id: 'sermon-2', revision: 'rev-9', hash: undefined } },
      { id: 'item-2', kind: 'reading', title: 'John 1', enabled: true, content: { id: 'reading-1', revision: 'rev-2', hash: 'fnv1a-12345678' } },
    ],
  },
];
const DRAFT: ServiceDraft = { title: 'Sunday Morning', date: '2026-09-13', site: 'Main Hall', sections: SECTIONS };

const store = (): { db: FakeDb; services: ServiceStore } => {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  return {
    db,
    services: servicesOn(db, {
      now: () => new Date(START + (tick += 1) * 1000 - 1000).toISOString(),
      newId: () => `service-${(serial += 1)}`,
    }),
  };
};

const rows = (db: FakeDb, collection: string): Document[] => db.rows.get(collection) ?? [];
const actions = (db: FakeDb): unknown[] => rows(db, AUDIT).map((row) => row['action']);
const duplicateKey = (): Error => Object.assign(new Error('E11000 duplicate key'), { code: 11_000 });

const refused = async (call: Promise<unknown>): Promise<ServiceError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof ServiceError) return error;
    throw error;
  }
  throw new Error('the call was allowed');
};

describe('creating a Service', () => {
  it('persists an upcoming service, round-trips it, and records who created it', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    expect(created).toEqual({
      ...DRAFT, state: 'upcoming',
      stamp: {
        id: 'service-1', kind: 'service', schemaVersion: 1,
        createdAt: '2026-09-13T09:30:00.000Z', createdBy: ADMINISTRATOR,
        updatedAt: '2026-09-13T09:30:00.000Z', updatedBy: ADMINISTRATOR,
        archivedAt: undefined, archivedBy: undefined,
      },
    });
    const { stamp, ...fields } = created;
    expect(parseService({ id: stamp.id, ...fields }).ok).toBe(true);
    expect(await services.current(ADMIN, stamp.id)).toEqual(created);
    expect(rows(db, STAMPS)).toEqual([{
      _id: 'service-1#1', serviceId: stamp.id, sequence: 1, at: stamp.updatedAt,
      ...created, actor: ADMINISTRATOR, correlationId: ADMIN.correlationId,
    }]);
    expect(actions(db)).toEqual(['service.create']);
    expect(rows(db, AUDIT)[0]).toMatchObject({
      subject: 'service:service-1', outcome: 'allowed', actor: ADMINISTRATOR,
      correlationId: ADMIN.correlationId, at: '2026-09-13T09:30:01.000Z',
    });
    expect(rows(db, RECORDS.contentRevisions.collection)).toEqual([]);
  });

  it('refuses an invalid draft before appending a stamp or audit entry', async () => {
    const { db, services } = store();
    const error = await refused(services.create(ADMIN, { ...DRAFT, date: '2026-09-31' }));
    expect(error.kind).toBe('schema');
    expect(error.message).toContain('service.date');
    expect(rows(db, STAMPS)).toEqual([]);
    expect(actions(db)).toEqual([]);
  });

  it('refuses an identifier already taken without changing the existing service', async () => {
    const { db, services } = store();
    const first = await services.create(ADMIN, DRAFT);
    const twice = servicesOn(db, { now: () => new Date(START).toISOString(), newId: () => first.stamp.id });
    expect((await refused(twice.create(ADMIN, { ...DRAFT, title: 'Another service' }))).kind).toBe('conflict');
    expect(await services.current(ADMIN, first.stamp.id)).toEqual(first);
    expect(rows(db, STAMPS)).toHaveLength(1);
    expect(actions(db)).toEqual(['service.create']);
  });

  it('passes through repository permission and context refusals', async () => {
    const { db, services } = store();
    const reader = requestContext({ actor: ADMINISTRATOR, permissions: [SERVICE_PERMISSIONS.read, 'auditEvents.append'], correlationId: ADMIN.correlationId });
    const writer = requestContext({ actor: ADMINISTRATOR, permissions: Object.values(SERVICE_PERMISSIONS), correlationId: ADMIN.correlationId });
    await expect(services.create(reader, DRAFT)).rejects.toBeInstanceOf(RepositoryError);
    await expect(services.create(writer, DRAFT)).rejects.toMatchObject({
      name: 'RepositoryError', kind: 'permission',
      message: 'auditEvents: the actor may not append, which needs auditEvents.append',
    });
    await expect(services.create(undefined, DRAFT)).rejects.toMatchObject({ kind: 'context' });
    expect(rows(db, STAMPS)).toEqual([]);
    expect(actions(db)).toEqual([]);
  });
});

describe('duplicating a Service', () => {
  it('keeps ordered sections, item ids, and pinned references under a fresh id and stamp', async () => {
    const { db, services } = store();
    const source = await services.create(ADMIN, DRAFT);
    const copy = await services.duplicate(ADMIN, source.stamp.id);
    expect(copy?.stamp.id).toBe('service-2');
    expect(copy?.stamp.createdAt).not.toBe(source.stamp.createdAt);
    expect(copy).toMatchObject({ ...DRAFT, state: 'upcoming' });
    const reloaded = await services.current(ADMIN, copy!.stamp.id);
    expect(reloaded).toEqual(copy);
    expect(reloaded?.sections).toEqual(SECTIONS);
    for (const [sectionIndex, section] of source.sections.entries()) {
      for (const [itemIndex, item] of section.items.entries()) {
        const content = reloaded?.sections[sectionIndex]?.items[itemIndex]?.content;
        expect(content?.id).toBe(item.content?.id);
        expect(content?.revision).toBe(item.content?.revision);
        expect(content?.hash).toBe(item.content?.hash);
      }
    }
    expect(rows(db, STAMPS).map((row) => row['sequence'])).toEqual([1, 1]);
    expect(actions(db)).toEqual(['service.create', 'service.duplicate']);
    expect(rows(db, AUDIT)[1]?.['subject']).toBe('service:service-2');
    expect(rows(db, RECORDS.contentRevisions.collection)).toEqual([]);
  });

  it('starts upcoming and unarchived even when the source has another state and is archived', async () => {
    const { db, services } = store();
    const source = await services.create(ADMIN, { ...DRAFT, sections: [] });
    const [row] = rows(db, STAMPS);
    db.rows.set(STAMPS, [{ ...row, state: 'completed' }]);
    await services.archive(ADMIN, source.stamp.id);
    const copy = await services.duplicate(ADMIN, source.stamp.id);
    expect(copy?.state).toBe('upcoming');
    expect(copy?.stamp.archivedAt).toBeUndefined();
    expect(copy?.sections).toEqual([]);
    expect((await services.current(ADMIN, source.stamp.id))?.state).toBe('completed');
    expect(actions(db)).toEqual(['service.create', 'service.archive', 'service.duplicate']);
  });
});

describe('scheduling and editing a Service', () => {
  it('schedules a new date while carrying every other field forward and auditing the change', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    const scheduled = await services.schedule(ADMIN, created.stamp.id, '2026-09-20');
    expect(scheduled).toEqual({
      ...created, date: '2026-09-20',
      stamp: { ...created.stamp, updatedAt: '2026-09-13T09:30:02.000Z' },
    });
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(scheduled);
    expect(rows(db, STAMPS).map((row) => row['sequence'])).toEqual([1, 2]);
    expect(actions(db)).toEqual(['service.create', 'service.schedule']);
  });

  it.each(['2026-09-31', '', 'next Sunday'])('refuses the invalid schedule %s without writing', async (date) => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    expect((await refused(services.schedule(ADMIN, created.stamp.id, date))).kind).toBe('schema');
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(created);
    expect(rows(db, STAMPS)).toHaveLength(1);
    expect(actions(db)).toEqual(['service.create']);
  });

  it('edits ordered sections and items, preserving order after reload and duplication', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    const reordered = [...SECTIONS].reverse().map((section) => ({ ...section, items: [...section.items].reverse() }));
    const edited = await services.edit(ADMIN, created.stamp.id, reordered);
    expect(edited).toEqual({
      ...created, sections: reordered,
      stamp: { ...created.stamp, updatedAt: '2026-09-13T09:30:02.000Z' },
    });
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(edited);
    const copy = await services.duplicate(ADMIN, created.stamp.id);
    expect(copy?.sections).toEqual(reordered);
    expect((await services.current(ADMIN, copy!.stamp.id))?.sections).toEqual(reordered);
    expect(rows(db, STAMPS).map((row) => row['sequence'])).toEqual([1, 2, 1]);
    expect(rows(db, STAMPS)[0]?.['sections']).toEqual(SECTIONS);
    expect(actions(db)).toEqual(['service.create', 'service.edit', 'service.duplicate']);
  });

  it('appends another sequence and audit entry even when an edit changes nothing', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    await services.edit(ADMIN, created.stamp.id, SECTIONS);
    expect(rows(db, STAMPS).map((row) => row['sequence'])).toEqual([1, 2]);
    expect(actions(db)).toEqual(['service.create', 'service.edit']);
  });

  it('refuses repeated item ids in an edit without writing', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    const repeated = [...SECTIONS, { id: 'another-section', name: 'Again', items: SECTIONS[0]!.items }];
    const error = await refused(services.edit(ADMIN, created.stamp.id, repeated));
    expect(error.kind).toBe('schema');
    expect(error.message).toContain('must not repeat an item');
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(created);
    expect(rows(db, STAMPS)).toHaveLength(1);
    expect(actions(db)).toEqual(['service.create']);
  });

  it('preserves an existing lifecycle state through every change', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    const [row] = rows(db, STAMPS);
    db.rows.set(STAMPS, [{ ...row, state: 'presenting' }]);
    await services.schedule(ADMIN, created.stamp.id, '2026-09-20');
    await services.edit(ADMIN, created.stamp.id, []);
    await services.archive(ADMIN, created.stamp.id);
    await services.unarchive(ADMIN, created.stamp.id);
    expect(rows(db, STAMPS).map((row) => row['state'])).toEqual(Array(5).fill('presenting'));
  });
});

describe('changing items within a Service', () => {
  it('appends a caller-supplied item to the named section and reloads the new stamp', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    const item = { ...SECTIONS[0]!.items[1]!, id: 'item-5' };
    const added = await services.addItem(ADMIN, created.stamp.id, 'section-1', item);
    expect(added).toEqual({
      ...created,
      sections: [SECTIONS[0], { ...SECTIONS[1], items: [...SECTIONS[1]!.items, item] }],
      stamp: { ...created.stamp, updatedAt: '2026-09-13T09:30:02.000Z' },
    });
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(added);
    expect(rows(db, STAMPS).map((row) => row['sequence'])).toEqual([1, 2]);
    expect(rows(db, STAMPS)[0]?.['sections']).toEqual(SECTIONS);
    expect(actions(db)).toEqual(['service.create', 'service.item.add']);
    expect(rows(db, AUDIT)[1]).toMatchObject({
      subject: subjectFor(created.stamp.id), outcome: 'allowed', actor: ADMINISTRATOR,
      correlationId: ADMIN.correlationId, detail: 'Added an item to a Service',
    });
  });

  it.each([
    SECTIONS[0]!.items[0]!,
    { ...SECTIONS[0]!.items[1]!, id: 'item-5', content: SECTIONS[0]!.items[0]!.content },
  ])('refuses an added item that violates a draft invariant: %j', async (item) => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    expect((await refused(services.addItem(ADMIN, created.stamp.id, 'section-1', item))).kind).toBe('schema');
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(created);
    expect(rows(db, STAMPS)).toHaveLength(1);
    expect(actions(db)).toEqual(['service.create']);
  });

  it('removes an item wherever it lives without disturbing the other items', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    const removed = await services.removeItem(ADMIN, created.stamp.id, 'item-4');
    expect(removed?.sections).toEqual([
      SECTIONS[0], { ...SECTIONS[1], items: [SECTIONS[1]!.items[1]] },
    ]);
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(removed);
    expect(rows(db, STAMPS)[0]?.['sections']).toEqual(SECTIONS);
    expect(actions(db)).toEqual(['service.create', 'service.item.remove']);
  });

  it('never touches any content-storing collection when an item is removed', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    await services.removeItem(ADMIN, created.stamp.id, 'item-3');
    expect([...db.rows.keys()].sort()).toEqual(['audit_events', 'services']);
  });

  it('retains the referenced global content when its item is removed', async () => {
    const { db, services } = store();
    const content = [{ _id: 'rev-5', entityId: 'song-4', body: { title: 'Amazing Grace' } }];
    db.rows.set(RECORDS.contentRevisions.collection, structuredClone(content));
    const created = await services.create(ADMIN, DRAFT);
    await services.removeItem(ADMIN, created.stamp.id, 'item-3');
    expect(rows(db, RECORDS.contentRevisions.collection)).toEqual(content);
  });

  it('disables and enables an item in place without removing or reordering it', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    const disabled = await services.disableItem(ADMIN, created.stamp.id, 'item-2');
    expect(disabled?.sections[1]?.items).toHaveLength(SECTIONS[1]!.items.length);
    expect(disabled?.sections).toEqual([
      SECTIONS[0],
      { ...SECTIONS[1], items: [SECTIONS[1]!.items[0], { ...SECTIONS[1]!.items[1], enabled: false }] },
    ]);
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(disabled);
    const enabled = await services.enableItem(ADMIN, created.stamp.id, 'item-2');
    expect(enabled?.sections[1]?.items).toHaveLength(SECTIONS[1]!.items.length);
    expect(enabled?.sections[1]?.items[1]?.enabled).toBe(true);
    expect(enabled?.sections).toEqual(SECTIONS);
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(enabled);
    expect(rows(db, STAMPS).map((row) => row['sequence'])).toEqual([1, 2, 3]);
    expect(actions(db)).toEqual(['service.create', 'service.item.disable', 'service.item.enable']);
  });

  it('duplicates a disabled item adjacent to its original with a fresh id and the same pinned reference', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    const disabled = await services.disableItem(ADMIN, created.stamp.id, 'item-3');
    const source = disabled!.sections[0]!.items[0]!;
    const duplicated = await services.duplicateItem(ADMIN, created.stamp.id, source.id);
    const copy = duplicated?.sections[0]?.items[1];
    expect(copy?.id).not.toBe(source.id);
    expect(copy).toEqual({ ...source, id: 'service-2' });
    expect(copy?.content).toEqual(source.content);
    expect(duplicated?.sections).toEqual([
      { ...SECTIONS[0], items: [source, copy, SECTIONS[0]!.items[1]] }, SECTIONS[1],
    ]);
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(duplicated);
    expect(actions(db)).toEqual(['service.create', 'service.item.disable', 'service.item.duplicate']);
    expect([...db.rows.keys()].sort()).toEqual(['audit_events', 'services']);
  });

  it('refuses a duplicate whose minted id is already an item in another section', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    const collision = servicesOn(db, { now: () => new Date(START).toISOString(), newId: () => 'item-4' });
    expect((await refused(collision.duplicateItem(ADMIN, created.stamp.id, 'item-3'))).kind).toBe('schema');
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(created);
    expect(rows(db, STAMPS)).toHaveLength(1);
    expect(actions(db)).toEqual(['service.create']);
  });

  it('reorders exactly the items in one section and preserves the others', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    const reordered = await services.reorderItems(ADMIN, created.stamp.id, 'section-2', ['item-1', 'item-3']);
    expect(reordered?.sections).toEqual([
      { ...SECTIONS[0], items: [...SECTIONS[0]!.items].reverse() }, SECTIONS[1],
    ]);
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(reordered);
    expect(actions(db)).toEqual(['service.create', 'service.item.reorder']);
  });

  it.each([
    ['item-3'], ['item-3', 'item-3'], ['item-3', 'item-404'], ['item-3', 'item-4'],
  ])('refuses an incomplete or repeated item order: %j', async (...itemIds) => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    expect((await refused(services.reorderItems(ADMIN, created.stamp.id, 'section-2', itemIds))).kind).toBe('schema');
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(created);
    expect(rows(db, STAMPS)).toHaveLength(1);
    expect(actions(db)).toEqual(['service.create']);
  });

  it.each(['addItem', 'removeItem', 'enableItem', 'disableItem', 'duplicateItem', 'reorderItems'] as const)(
    'refuses %s with an unknown section or item without writing', async (change) => {
      const { db, services } = store();
      const created = await services.create(ADMIN, DRAFT);
      const id = created.stamp.id;
      const changes = {
        addItem: () => services.addItem(ADMIN, id, 'section-404', SECTIONS[0]!.items[0]!),
        removeItem: () => services.removeItem(ADMIN, id, 'item-404'),
        enableItem: () => services.enableItem(ADMIN, id, 'item-404'),
        disableItem: () => services.disableItem(ADMIN, id, 'item-404'),
        duplicateItem: () => services.duplicateItem(ADMIN, id, 'item-404'),
        reorderItems: () => services.reorderItems(ADMIN, id, 'section-404', []),
      };
      expect((await refused(changes[change]())).kind).toBe('schema');
      expect(await services.current(ADMIN, id)).toEqual(created);
      expect(rows(db, STAMPS)).toHaveLength(1);
      expect(actions(db)).toEqual(['service.create']);
    },
  );
});

describe('archiving a Service and bringing it back', () => {
  it('appends archive and unarchive stamps and audits both as service.archive', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    const archived = await services.archive(ADMIN, created.stamp.id);
    expect(archived).toEqual({
      ...created, stamp: {
        ...created.stamp, updatedAt: '2026-09-13T09:30:02.000Z',
        archivedAt: '2026-09-13T09:30:02.000Z', archivedBy: ADMINISTRATOR,
      },
    });
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(archived);
    const restored = await services.unarchive(ADMIN, created.stamp.id);
    expect(restored).toEqual({
      ...created, stamp: { ...created.stamp, updatedAt: '2026-09-13T09:30:04.000Z' },
    });
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(restored);
    expect(rows(db, STAMPS).map((row) => row['sequence'])).toEqual([1, 2, 3]);
    expect(actions(db)).toEqual(['service.create', 'service.archive', 'service.archive']);
  });

  it('refuses repeated archival, restoring a live service, and editing or scheduling an archived one', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    expect((await refused(services.unarchive(ADMIN, created.stamp.id))).kind).toBe('state');
    await services.archive(ADMIN, created.stamp.id);
    expect((await refused(services.archive(ADMIN, created.stamp.id))).kind).toBe('state');
    expect((await refused(services.edit(ADMIN, created.stamp.id, []))).kind).toBe('state');
    expect((await refused(services.schedule(ADMIN, created.stamp.id, '2026-09-20'))).kind).toBe('state');
    expect(rows(db, STAMPS)).toHaveLength(2);
    expect(actions(db)).toEqual(['service.create', 'service.archive']);
  });
});

describe('reading and refusing Service changes', () => {
  it.each([
    'duplicate', 'schedule', 'edit', 'archive', 'unarchive',
    'addItem', 'removeItem', 'enableItem', 'disableItem', 'duplicateItem', 'reorderItems',
  ] as const)(
    'refuses %s without audit permission before writing a service row', async (change) => {
      const { db, services } = store();
      const created = await services.create(ADMIN, DRAFT);
      const id = created.stamp.id;
      if (change === 'unarchive') await services.archive(ADMIN, id);
      const writer = requestContext({ actor: ADMINISTRATOR, permissions: Object.values(SERVICE_PERMISSIONS), correlationId: ADMIN.correlationId });
      const stamps = [...rows(db, STAMPS)];
      const audit = [...rows(db, AUDIT)];
      const changes = {
        duplicate: () => services.duplicate(writer, id),
        schedule: () => services.schedule(writer, id, '2026-09-20'),
        edit: () => services.edit(writer, id, []),
        addItem: () => services.addItem(writer, id, 'section-1', { ...SECTIONS[0]!.items[0]!, id: 'item-5' }),
        removeItem: () => services.removeItem(writer, id, 'item-3'),
        enableItem: () => services.enableItem(writer, id, 'item-3'),
        disableItem: () => services.disableItem(writer, id, 'item-3'),
        duplicateItem: () => services.duplicateItem(writer, id, 'item-3'),
        reorderItems: () => services.reorderItems(writer, id, 'section-2', ['item-1', 'item-3']),
        archive: () => services.archive(writer, id),
        unarchive: () => services.unarchive(writer, id),
      };

      await expect(changes[change]()).rejects.toMatchObject({
        name: 'RepositoryError', kind: 'permission',
        message: 'auditEvents: the actor may not append, which needs auditEvents.append',
      });
      expect(rows(db, STAMPS)).toEqual(stamps);
      expect(rows(db, AUDIT)).toEqual(audit);
    },
  );

  it('returns nothing for every verb on an unknown id without auditing or writing', async () => {
    const { db, services } = store();
    expect(await services.current(ADMIN, 'service-404')).toBeUndefined();
    expect(await services.duplicate(ADMIN, 'service-404')).toBeUndefined();
    expect(await services.schedule(ADMIN, 'service-404', '2026-09-20')).toBeUndefined();
    expect(await services.edit(ADMIN, 'service-404', [])).toBeUndefined();
    expect(await services.addItem(ADMIN, 'service-404', 'section-2', SECTIONS[0]!.items[0]!)).toBeUndefined();
    expect(await services.removeItem(ADMIN, 'service-404', 'item-3')).toBeUndefined();
    expect(await services.enableItem(ADMIN, 'service-404', 'item-3')).toBeUndefined();
    expect(await services.disableItem(ADMIN, 'service-404', 'item-3')).toBeUndefined();
    expect(await services.duplicateItem(ADMIN, 'service-404', 'item-3')).toBeUndefined();
    expect(await services.reorderItems(ADMIN, 'service-404', 'section-2', [])).toBeUndefined();
    expect(await services.archive(ADMIN, 'service-404')).toBeUndefined();
    expect(await services.unarchive(ADMIN, 'service-404')).toBeUndefined();
    expect(rows(db, STAMPS)).toEqual([]);
    expect(actions(db)).toEqual([]);
  });

  it.each([
    { sequence: 'second' },
    { stamp: { id: 'service-1' } },
    { title: 7 },
    { sections: 'missing' },
    { state: 'live' },
  ])('refuses unreadable stored fields: %j', async (corrupt) => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    const [row] = rows(db, STAMPS);
    db.rows.set(STAMPS, [{ ...row, ...corrupt }]);
    expect((await refused(services.current(ADMIN, created.stamp.id))).kind).toBe('corrupt');
    expect((await refused(services.edit(ADMIN, created.stamp.id, []))).kind).toBe('corrupt');
    expect(rows(db, STAMPS)).toHaveLength(1);
    expect(actions(db)).toEqual(['service.create']);
  });

  it('refuses a lost sequence race without publishing the edit or an audit entry', async () => {
    const { db, services } = store();
    const created = await services.create(ADMIN, DRAFT);
    db.failOn = (collection) => collection === STAMPS ? duplicateKey() : undefined;
    expect((await refused(services.edit(ADMIN, created.stamp.id, []))).kind).toBe('conflict');
    db.failOn = undefined;
    expect(await services.current(ADMIN, created.stamp.id)).toEqual(created);
    expect(rows(db, STAMPS)).toHaveLength(1);
    expect(actions(db)).toEqual(['service.create']);
  });

  it('passes through a storage failure without appending an audit entry', async () => {
    const { db, services } = store();
    db.failOn = (collection) => collection === STAMPS ? new Error('the disk went away') : undefined;
    await expect(services.create(ADMIN, DRAFT)).rejects.toThrow('the disk went away');
    expect(rows(db, STAMPS)).toEqual([]);
    expect(actions(db)).toEqual([]);
  });
});

describe('what the Service store is reached through', () => {
  it('declares its permissions, audit subject, and the content-category actions', () => {
    expect(SERVICE_PERMISSIONS).toEqual({ read: 'services.read', append: 'services.append' });
    expect(ADMIN.permissions).toEqual(['services.read', 'services.append', 'auditEvents.append']);
    expect(subjectFor('service-1')).toBe('service:service-1');
    for (const action of [
      'service.create', 'service.duplicate', 'service.schedule', 'service.archive', 'service.edit',
      'service.item.add', 'service.item.remove', 'service.item.enable', 'service.item.disable',
      'service.item.duplicate', 'service.item.reorder',
    ] as const) {
      expect(CATEGORY_OF[action]).toBe('content');
    }
  });

  it('generates an unpredictable id when no id factory is supplied', async () => {
    const services = servicesOn(fakeDb(), { now: () => new Date(START).toISOString() });
    expect((await services.create(ADMIN, DRAFT)).stamp.id).toMatch(/^[\w-]{22}$/u);
  });

  it('declares the unique service stamp index used by its standing reads', () => {
    expect(SERVICE_INDEXES).toEqual([
      { name: 'service_stamp', keys: { serviceId: 1, sequence: -1 }, options: { unique: true } },
    ]);
  });
});
