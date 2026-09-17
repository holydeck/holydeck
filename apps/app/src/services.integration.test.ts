import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { repositoryDb } from './repositories.js';
import { serviceContext, servicesOn } from './services.js';
import { startTestMongo } from '../test/helpers/mongo.js';

import type { ServiceStore } from './services.js';
import type { TestMongo } from '../test/helpers/mongo.js';

const START = Date.parse('2026-09-13T09:30:00.000Z');
const ADMIN = serviceContext(`account:${'C'.repeat(22)}`, 'req-0f9c2a41');

const clock = (): (() => string) => {
  let tick = 0;
  return () => new Date(START + tick++ * 1000).toISOString();
};

let mongo: TestMongo;
let services: ServiceStore;

beforeAll(async () => {
  mongo = await startTestMongo();
  services = servicesOn(repositoryDb(mongo.db), { now: clock() });
});

afterAll(async () => {
  await mongo.stop();
});

describe('Services in a real database', () => {
  it('reloads a freshly created service with its unarchived stamp intact', async () => {
    const created = await services.create(ADMIN, {
      title: 'Sunday Morning', date: '2026-09-13', site: 'Main Hall', sections: [],
    });

    await expect(services.current(ADMIN, created.stamp.id)).resolves.toEqual(created);
  });

  it('keeps a disabled item after reloading through a real database', async () => {
    const created = await services.create(ADMIN, {
      title: 'Sunday Morning', date: '2026-09-13', site: 'Main Hall',
      sections: [
        {
          id: 'section-1', name: 'Worship',
          items: [{ id: 'item-1', kind: 'custom-slide', title: 'Welcome', enabled: true, content: undefined }],
        },
      ],
    });

    await services.disableItem(ADMIN, created.stamp.id, 'item-1');

    const current = await services.current(ADMIN, created.stamp.id);
    expect(current?.sections[0]?.items[0]).toEqual({ id: 'item-1', kind: 'custom-slide', title: 'Welcome', enabled: false });
  });
});
