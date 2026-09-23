import { describe, expect, it } from 'vitest';

import { requestContext } from './context.js';
import { RECORDS } from './records.js';
import { RepositoryError } from './repositories.js';
import { serviceContext, servicesOn } from './services.js';
import {
  SERVICE_TEMPLATE_INDEXES,
  SERVICE_TEMPLATE_PERMISSIONS,
  ServiceTemplateError,
  serviceTemplateContext,
  serviceTemplatesOn,
  subjectFor,
} from './service-templates.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { ServiceTemplateBody } from '@holydeck/contracts/service-templates';

import type { Document } from './repositories.js';
import type { ServiceStore } from './services.js';
import type { ServiceTemplateStore } from './service-templates.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-17T09:00:00.000Z');

const ADMINISTRATOR = `account:${'E'.repeat(22)}`;

const ADMIN = serviceTemplateContext(ADMINISTRATOR, 'req-41-service-templates');

const STAMPS = RECORDS.serviceTemplates.collection;

const REVISIONS = RECORDS.contentRevisions.collection;

const BODY: ServiceTemplateBody = {
  sections: [
    {
      id: 'welcome',
      name: 'Welcome',
      entries: [
        { id: 'opener', slot: 'fixed', itemKind: 'custom-slide', title: 'Welcome slide', content: undefined },
        { id: 'song-1', slot: 'typed', itemKind: 'song', required: true },
      ],
    },
  ],
};

const OTHER_BODY: ServiceTemplateBody = { sections: [] };

const DRAFT = { name: 'Sunday Service', body: BODY };

const store = (db: FakeDb = fakeDb()): { db: FakeDb; templates: ServiceTemplateStore; services: ServiceStore } => {
  let tick = 0;
  let serial = 0;
  const now = (): string => new Date(START + (tick += 1) * 1000 - 1000).toISOString();
  const services = servicesOn(db, { now, newId: () => `service-${(serial += 1)}` });
  return { db, services, templates: serviceTemplatesOn(db, { now, newId: () => `template-${(serial += 1)}`, services }) };
};

const rows = (db: FakeDb, collection: string): Document[] => db.rows.get(collection) ?? [];

const duplicateKey = (): Error => Object.assign(new Error('E11000 duplicate key'), { code: 11_000 });

const refused = async (call: Promise<unknown>): Promise<ServiceTemplateError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof ServiceTemplateError) return error;
    throw error;
  }
  throw new Error('the call was allowed');
};

describe('subjectFor', () => {
  it('names a Service Template for the audit trail', () => {
    expect(subjectFor('template-1')).toBe('serviceTemplate:template-1');
  });
});

describe('create', () => {
  it('stamps a live entity, appends its first revision, and hands both back', async () => {
    const { db, templates } = store();
    const created = await templates.create(ADMIN, DRAFT);
    expect(created).toEqual({
      stamp: {
        id: 'template-1',
        kind: 'serviceTemplate',
        schemaVersion: 1,
        createdAt: '2026-09-17T09:00:00.000Z',
        createdBy: ADMINISTRATOR,
        updatedAt: '2026-09-17T09:00:00.000Z',
        updatedBy: ADMINISTRATOR,
        archivedAt: undefined,
        archivedBy: undefined,
      },
      name: 'Sunday Service',
      revision: 1,
      at: '2026-09-17T09:00:01.000Z',
      body: BODY,
    });
    expect(rows(db, STAMPS)).toHaveLength(1);
    expect(rows(db, REVISIONS)).toHaveLength(1);
  });

  it('refuses a draft that is not a Service Template', async () => {
    const { templates } = store();
    const error = await refused(templates.create(ADMIN, { name: '', body: OTHER_BODY }));
    expect(error.kind).toBe('schema');
  });

  it('gives each Service Template its own identifier, unaffected by another one already defined', async () => {
    const { templates } = store();
    const first = await templates.create(ADMIN, DRAFT);
    const second = await templates.create(ADMIN, { name: 'Evening Service', body: OTHER_BODY });
    expect(second.stamp.id).not.toBe(first.stamp.id);
    expect(await templates.preview(ADMIN, first.stamp.id)).toMatchObject({ name: 'Sunday Service' });
    expect(await templates.preview(ADMIN, second.stamp.id)).toMatchObject({ name: 'Evening Service' });
  });

  it('refuses a second Service Template claiming an identifier another writer already took', async () => {
    const { db, templates } = store();
    const first = await templates.create(ADMIN, DRAFT);
    const twice = serviceTemplatesOn(db, {
      now: () => new Date(START).toISOString(),
      newId: () => first.stamp.id,
      services: servicesOn(db, { now: () => new Date(START).toISOString() }),
    });

    const error = await refused(twice.create(ADMIN, { name: 'Evening Service', body: OTHER_BODY }));
    expect(error.kind).toBe('conflict');
  });

  it('refuses an actor the records layer would not let append', async () => {
    const { templates } = store();
    const reader = requestContext({ actor: ADMINISTRATOR, permissions: [], correlationId: 'req-41-service-templates' });
    await expect(templates.create(reader, DRAFT)).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe('preview', () => {
  it('is nothing for a Service Template never defined', async () => {
    const { templates } = store();
    expect(await templates.preview(ADMIN, 'template-none')).toBeUndefined();
  });

  it('reads back exactly the entries a Service Template was created with', async () => {
    const { templates } = store();
    const created = await templates.create(ADMIN, DRAFT);
    expect(await templates.preview(ADMIN, created.stamp.id)).toEqual(created);
  });

  it('reads a named earlier revision, which is what previewing history is', async () => {
    const { templates } = store();
    const created = await templates.create(ADMIN, DRAFT);
    await templates.version(ADMIN, created.stamp.id, { name: created.name, body: OTHER_BODY });
    expect((await templates.preview(ADMIN, created.stamp.id))?.body).toEqual(OTHER_BODY);
    expect((await templates.preview(ADMIN, created.stamp.id, 1))?.body).toEqual(BODY);
    expect(await templates.preview(ADMIN, created.stamp.id, 9)).toBeUndefined();
  });
});

describe('list', () => {
  it('is empty before any Service Template is defined', async () => {
    const { templates } = store();
    expect(await templates.list(ADMIN)).toEqual([]);
  });

  it('lists every defined Service Template without its entries', async () => {
    const { templates } = store();
    const first = await templates.create(ADMIN, DRAFT);
    const second = await templates.create(ADMIN, { name: 'Evening Service', body: OTHER_BODY });
    const listed = await templates.list(ADMIN);
    expect(listed).toHaveLength(2);
    expect(listed).toContainEqual({ stamp: first.stamp, name: first.name });
    expect(listed).toContainEqual({ stamp: second.stamp, name: second.name });
  });
});

describe('version', () => {
  it('appends a second revision when the entries changed, and touches the stamp that owns them', async () => {
    const { db, templates } = store();
    const created = await templates.create(ADMIN, DRAFT);
    expect(await templates.version(ADMIN, created.stamp.id, { name: created.name, body: OTHER_BODY })).toEqual({
      appended: true,
      renamed: false,
      revision: 2,
    });
    expect(rows(db, REVISIONS)).toHaveLength(2);
    expect(rows(db, STAMPS)).toHaveLength(2);
    const preview = await templates.preview(ADMIN, created.stamp.id);
    expect(preview?.stamp.updatedAt).toBe('2026-09-17T09:00:02.000Z');
    expect(preview?.stamp.createdAt).toBe('2026-09-17T09:00:00.000Z');
    expect(preview?.name).toBe('Sunday Service');
  });

  it('appends nothing at all when neither the name nor the entries changed, not even a stamp', async () => {
    const { db, templates } = store();
    const created = await templates.create(ADMIN, DRAFT);
    expect(await templates.version(ADMIN, created.stamp.id, { name: created.name, body: BODY })).toEqual({
      appended: false,
      renamed: false,
      revision: 1,
    });
    expect(rows(db, REVISIONS)).toHaveLength(1);
    expect(rows(db, STAMPS)).toHaveLength(1);
  });

  it('saves a new name onto a new stamp row even when the entries did not change', async () => {
    const { db, templates } = store();
    const created = await templates.create(ADMIN, DRAFT);
    expect(await templates.version(ADMIN, created.stamp.id, { name: 'Sunday Service v2', body: BODY })).toEqual({
      appended: false,
      renamed: true,
      revision: 1,
    });
    expect(rows(db, REVISIONS)).toHaveLength(1);
    expect(rows(db, STAMPS)).toHaveLength(2);
    expect((await templates.preview(ADMIN, created.stamp.id))?.name).toBe('Sunday Service v2');
  });

  it('answers nothing for a Service Template nobody defined', async () => {
    const { templates } = store();
    expect(await templates.version(ADMIN, 'template-404', DRAFT)).toBeUndefined();
    expect(await templates.archive(ADMIN, 'template-404')).toBeUndefined();
    expect(await templates.unarchive(ADMIN, 'template-404')).toBeUndefined();
    expect(await templates.history(ADMIN, 'template-404')).toEqual([]);
    expect(await templates.fromService(ADMIN, 'service-404', 'Anything')).toBeUndefined();
  });

  it('refuses entries it could not read back, and refuses a Service Template that has been archived', async () => {
    const { templates } = store();
    const created = await templates.create(ADMIN, DRAFT);
    const badBody = { sections: [{ id: 's', name: 'S', entries: [{ id: 'x' }] }] } as unknown as ServiceTemplateBody;
    expect((await refused(templates.version(ADMIN, created.stamp.id, { name: created.name, body: badBody }))).kind).toBe(
      'schema',
    );
    await templates.archive(ADMIN, created.stamp.id);
    const archived = await refused(templates.version(ADMIN, created.stamp.id, { name: created.name, body: OTHER_BODY }));
    expect(archived.kind).toBe('state');
    expect(archived.message).toContain(created.stamp.id);
  });

  it('publishes nothing at all when it loses the race for the ordinal it was stamping', async () => {
    const { db, templates } = store();
    const created = await templates.create(ADMIN, DRAFT);
    const before = await templates.history(ADMIN, created.stamp.id);
    db.failOn = (collection) => (collection === STAMPS ? duplicateKey() : undefined);

    const error = await refused(templates.version(ADMIN, created.stamp.id, { name: created.name, body: OTHER_BODY }));

    expect(error.kind).toBe('conflict');
    db.failOn = undefined;
    expect(await templates.history(ADMIN, created.stamp.id)).toEqual(before);
    expect((await templates.preview(ADMIN, created.stamp.id))?.body).toEqual(BODY);
  });
});

describe('archiving a Service Template and bringing it back', () => {
  it('hides it by stamping it archived, which is what its kind says archiving does', async () => {
    const { db, templates } = store();
    const created = await templates.create(ADMIN, DRAFT);
    const archived = await templates.archive(ADMIN, created.stamp.id);
    expect(archived?.stamp).toMatchObject({
      archivedAt: '2026-09-17T09:00:02.000Z',
      archivedBy: ADMINISTRATOR,
      updatedAt: '2026-09-17T09:00:02.000Z',
    });
    expect(rows(db, STAMPS)).toHaveLength(2);
    expect(rows(db, REVISIONS)).toHaveLength(1);
  });

  it('refuses to archive one that is already archived, rather than stamping it twice', async () => {
    const { templates } = store();
    const created = await templates.create(ADMIN, DRAFT);
    await templates.archive(ADMIN, created.stamp.id);
    const error = await refused(templates.archive(ADMIN, created.stamp.id));
    expect(error.kind).toBe('state');
    expect(error.message).toContain('is already archived');
  });

  it('brings an archived Service Template back live, and refuses to bring back one that never left', async () => {
    const { templates } = store();
    const created = await templates.create(ADMIN, DRAFT);
    await templates.archive(ADMIN, created.stamp.id);
    const restored = await templates.unarchive(ADMIN, created.stamp.id);
    expect(restored?.stamp.archivedAt).toBeUndefined();
    expect(restored?.stamp.archivedBy).toBeUndefined();
    const error = await refused(templates.unarchive(ADMIN, created.stamp.id));
    expect(error.kind).toBe('state');
    expect(error.message).toContain('is not archived');
  });
});

describe('history', () => {
  it('is every revision a Service Template has been saved forward with', async () => {
    const { templates } = store();
    const created = await templates.create(ADMIN, DRAFT);
    await templates.version(ADMIN, created.stamp.id, { name: created.name, body: OTHER_BODY });
    const history = await templates.history(ADMIN, created.stamp.id);
    expect(history.map((revision) => revision.revision)).toEqual([1, 2]);
  });
});

describe('fromService', () => {
  const SERVICE_DRAFT = {
    title: 'Sunday Gathering',
    date: '2026-09-20',
    site: 'main',
    sections: [
      {
        id: 'welcome',
        name: 'Welcome',
        items: [
          { id: 'opener', kind: 'custom-slide' as const, title: 'Welcome slide', enabled: true, content: undefined },
          {
            id: 'song-1',
            kind: 'song' as const,
            title: 'Amazing Grace',
            enabled: true,
            content: { id: 'song-amazing-grace', revision: 3, hash: undefined },
          },
        ],
      },
    ],
  };

  it('converts an existing Service into a new Service Template, one fixed entry per item', async () => {
    const { templates, services } = store();
    const service = await services.create(serviceContext(ADMINISTRATOR, 'req-41-service-templates'), SERVICE_DRAFT);
    const templated = await templates.fromService(ADMIN, service.stamp.id, 'From Sunday Gathering');
    expect(templated?.name).toBe('From Sunday Gathering');
    expect(templated?.body).toEqual({
      sections: [
        {
          id: 'welcome',
          name: 'Welcome',
          entries: [
            { id: 'opener', slot: 'fixed', itemKind: 'custom-slide', title: 'Welcome slide', content: undefined },
            {
              id: 'song-1',
              slot: 'fixed',
              itemKind: 'song',
              title: 'Amazing Grace',
              content: { id: 'song-amazing-grace', revision: 3, hash: undefined },
            },
          ],
        },
      ],
    });
    expect(await templates.preview(ADMIN, templated!.stamp.id)).toEqual(templated);
  });

  it('answers nothing for a Service that was never created', async () => {
    const { templates } = store();
    expect(await templates.fromService(ADMIN, 'service-404', 'Anything')).toBeUndefined();
  });

  it('refuses a blank name, before minting an identifier for it', async () => {
    const { db, templates, services } = store();
    const service = await services.create(serviceContext(ADMINISTRATOR, 'req-41-service-templates'), SERVICE_DRAFT);
    const before = rows(db, STAMPS).length;
    const error = await refused(templates.fromService(ADMIN, service.stamp.id, ''));
    expect(error.kind).toBe('schema');
    expect(rows(db, STAMPS)).toHaveLength(before);
  });
});

describe('what the Service Template store is reached through', () => {
  it('names its own permissions after its record class, and a Service Template after its kind', () => {
    expect(SERVICE_TEMPLATE_PERMISSIONS).toEqual({ read: 'serviceTemplates.read', append: 'serviceTemplates.append' });
    expect(subjectFor('template-1')).toBe('serviceTemplate:template-1');
    expect(ADMIN.permissions).toContain('contentRevisions.append');
    expect(ADMIN.permissions).toContain('services.read');
  });

  it('names a Service Template with an identifier nobody guesses, when nothing names one for it', async () => {
    const db = fakeDb();
    const templates = serviceTemplatesOn(db, {
      now: () => new Date(START).toISOString(),
      services: servicesOn(db, { now: () => new Date(START).toISOString() }),
    });
    const created = await templates.create(ADMIN, DRAFT);
    expect(created.stamp.id).toMatch(/^[\w-]{22}$/u);
  });

  it('declares the one index its own reads are served by, and no other', () => {
    expect(SERVICE_TEMPLATE_INDEXES.map((index) => index.name)).toEqual(['service_template_stamp']);
    expect(SERVICE_TEMPLATE_INDEXES[0]).toMatchObject({ keys: { templateId: 1, sequence: -1 }, options: { unique: true } });
  });

  it('refuses a second writer that claimed the same place in the stamp history', async () => {
    const { db, templates } = store();
    const created = await templates.create(ADMIN, DRAFT);
    const [row] = rows(db, STAMPS);
    db.rows.set(STAMPS, [{ ...row, _id: `${created.stamp.id}#2` }, ...rows(db, STAMPS)]);
    const error = await refused(templates.archive(ADMIN, created.stamp.id));
    expect(error.kind).toBe('conflict');
  });
});
