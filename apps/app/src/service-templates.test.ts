import { describe, expect, it } from 'vitest';

import { serviceTemplateContext, ServiceTemplateError, serviceTemplatesOn, subjectFor } from './service-templates.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { ServiceTemplateBody } from '@holydeck/contracts/service-templates';

import type { ServiceTemplateStore } from './service-templates.js';

const START = Date.parse('2026-09-17T09:00:00.000Z');

const ADMINISTRATOR = `account:${'E'.repeat(22)}`;

const ADMIN = serviceTemplateContext(ADMINISTRATOR, 'req-41-service-templates');

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

const DRAFT = { name: 'Sunday Service', body: BODY };

const store = (newId?: () => string): ServiceTemplateStore => {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  return serviceTemplatesOn(db, {
    now: () => new Date(START + (tick += 1) * 1000 - 1000).toISOString(),
    newId: newId ?? ((): string => `template-${(serial += 1)}`),
  });
};

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
  it('defines a Service Template and reads its entries back at revision 1', async () => {
    const templates = store();
    const created = await templates.create(ADMIN, DRAFT);
    expect(created.name).toBe('Sunday Service');
    expect(created.revision).toBe(1);
    expect(created.body).toEqual(BODY);
    expect(created.createdBy).toBe(ADMINISTRATOR);
  });

  it('refuses a draft that is not a Service Template', async () => {
    const templates = store();
    const error = await refused(templates.create(ADMIN, { name: '', body: { sections: [] } }));
    expect(error.kind).toBe('schema');
  });

  it('gives each Service Template its own identifier, unaffected by another one already defined', async () => {
    const templates = store();
    const first = await templates.create(ADMIN, DRAFT);
    const second = await templates.create(ADMIN, { name: 'Evening Service', body: { sections: [] } });
    expect(second.id).not.toBe(first.id);
    expect(await templates.preview(ADMIN, first.id)).toMatchObject({ name: 'Sunday Service' });
    expect(await templates.preview(ADMIN, second.id)).toMatchObject({ name: 'Evening Service' });
  });

  it('refuses a second Service Template claiming an identifier another writer already took', async () => {
    const templates = store(() => 'template-1');
    await templates.create(ADMIN, DRAFT);
    const error = await refused(templates.create(ADMIN, { name: 'Evening Service', body: { sections: [] } }));
    expect(error.kind).toBe('conflict');
  });
});

describe('preview', () => {
  it('is nothing for a Service Template never defined', async () => {
    const templates = store();
    expect(await templates.preview(ADMIN, 'template-none')).toBeUndefined();
  });

  it('reads back exactly the entries a Service Template was created with', async () => {
    const templates = store();
    const created = await templates.create(ADMIN, DRAFT);
    const previewed = await templates.preview(ADMIN, created.id);
    expect(previewed).toEqual(created);
  });
});
