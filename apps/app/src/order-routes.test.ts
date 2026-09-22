import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ORDER_PATH } from '@holydeck/contracts/order';
import { sessionCookie } from '@holydeck/contracts/sessions';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildApp } from './app.js';
import { PRESENTATION_CONTROL, SETTINGS_MANAGE } from './roles.js';
import { serviceContext, servicesOn } from './services.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { loadSettings } from './settings.js';
import { slideLabelContext, slideLabelsOn } from './slide-labels.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { ServiceSection, ServiceState } from '@holydeck/contracts/services';

import type { OrderRoutesOptions } from './order-routes.js';
import type { ServiceStore } from './services.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { SlideLabelStore } from './slide-labels.js';
import type { FastifyInstance } from 'fastify';

const NOW = '2026-09-22T09:30:00.000Z';
const OPERATOR = actorFor('C'.repeat(22));
const CORRELATION = 'req-0f9c2a41';
const SERVICE_CONTEXT = serviceContext(OPERATOR, CORRELATION);
const LABEL_CONTEXT = slideLabelContext(OPERATOR, CORRELATION);
const SECTIONS: readonly ServiceSection[] = [
  {
    id: 'section-2', name: 'Welcome', items: [
      { id: 'item-3', kind: 'custom-slide', title: 'Welcome', enabled: true, content: undefined },
      { id: 'item-1', kind: 'custom-slide', title: 'Skipped', enabled: false, content: undefined },
    ],
  },
  {
    id: 'section-1', name: 'Closing', items: [
      { id: 'item-2', kind: 'custom-slide', title: 'Blessing', enabled: true, content: undefined },
    ],
  },
];

let app: FastifyInstance;
let services: ServiceStore;
let slideLabels: SlideLabelStore;
let sessions: SessionStore;
let operator: StartedSession;

const building = async (stores: OrderRoutesOptions): Promise<void> => {
  app = buildApp({
    settings: loadSettings({ env: {} }),
    logger: false,
    fetching: () => Promise.reject(new Error('this route must not ask the corpus')),
    sessions,
    ...stores,
  });
  await app.ready();
};

const asking = (held: StartedSession | 'anonymous' = operator) => app.inject({
  method: 'GET',
  url: ORDER_PATH,
  headers: {
    [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
    ...(held === 'anonymous' ? {} : { cookie: sessionCookie(held.token, 60) }),
  },
});

const createService = async (state: ServiceState, sections = SECTIONS): Promise<void> => {
  const created = await services.create(SERVICE_CONTEXT, {
    title: 'Sunday Morning', date: '2026-09-27', site: 'Main Hall', sections,
  });
  if (state === 'upcoming') return;
  await services.transition(SERVICE_CONTEXT, created.stamp.id, 'presenting');
  if (state === 'presenting') return;
  await services.transition(SERVICE_CONTEXT, created.stamp.id, 'completed');
  if (state === 'archived') await services.transition(SERVICE_CONTEXT, created.stamp.id, 'archived');
};

beforeEach(async () => {
  const db = fakeDb();
  let serial = 0;
  services = servicesOn(db, { now: () => NOW, newId: () => `service-${++serial}` });
  slideLabels = slideLabelsOn(db, { now: () => NOW, newId: () => `label-${++serial}` });
  sessions = sessionsOn(memorySessions().db, { now: () => NOW });
  operator = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [PRESENTATION_CONTROL] });
  await building({ services, slideLabels });
});

afterEach(async () => {
  await app.close();
});

describe('the operator order and shortcut catalogue', () => {
  test('answers enabled items in section and item order, with the offered catalogue', async () => {
    await createService('upcoming');
    await createService('presenting');
    const verse = await slideLabels.create(LABEL_CONTEXT, { name: 'Verse', shortcut: '1' });
    const bridge = await slideLabels.create(LABEL_CONTEXT, { name: 'Bridge' });
    const archived = await slideLabels.create(LABEL_CONTEXT, { name: 'Retired', shortcut: '2' });
    await slideLabels.archive(LABEL_CONTEXT, archived.stamp.id);

    const response = await asking();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        items: [{ id: 'item-3', label: 'Welcome' }, { id: 'item-2', label: 'Blessing' }],
        catalogue: [{ id: verse.stamp.id, name: 'Verse', shortcut: '1' }, { id: bridge.stamp.id, name: 'Bridge' }],
      },
      meta: { requestId: expect.any(String), version: CLIENT_WINDOW.current },
    });
    expect(Object.keys(response.json().data)).toEqual(['items', 'catalogue']);
  });

  test('refuses anonymous and unauthorized sessions before reading either store', async () => {
    const list = vi.spyOn(services, 'list');
    const catalogue = vi.spyOn(slideLabels, 'catalogue');
    const bystander = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [SETTINGS_MANAGE] });
    for (const [caller, status] of [[bystander, 403], ['anonymous', 401]] as const) {
      const response = await asking(caller);
      expect(response.statusCode).toBe(status);
      expect(response.json().data).toBeUndefined();
    }
    expect(list).not.toHaveBeenCalled();
    expect(catalogue).not.toHaveBeenCalled();
  });

  test.each(['services', 'slideLabels', 'both'] as const)('returns a gated 404 with %s missing', async (missing) => {
    await app.close();
    await building({
      services: missing === 'slideLabels' ? services : undefined,
      slideLabels: missing === 'services' ? slideLabels : undefined,
    });
    const list = vi.spyOn(services, 'list');
    const catalogue = vi.spyOn(slideLabels, 'catalogue');
    const response = await asking();
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('resource.not_found');
    expect(response.json().data).toBeUndefined();
    const bystander = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [] });
    expect((await asking(bystander)).statusCode).toBe(403);
    expect((await asking('anonymous')).statusCode).toBe(401);
    expect(list).not.toHaveBeenCalled();
    expect(catalogue).not.toHaveBeenCalled();
  });

  test('returns an empty order and the catalogue when no service is presenting', async () => {
    await createService('upcoming');
    await createService('completed');
    await createService('archived');
    const verse = await slideLabels.create(LABEL_CONTEXT, { name: 'Verse', shortcut: '1' });
    const response = await asking();
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ items: [], catalogue: [{ id: verse.stamp.id, name: 'Verse', shortcut: '1' }] });
  });

  test('returns an honest empty state when both stores are empty', async () => {
    const response = await asking();
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ items: [], catalogue: [] });
  });

  test('takes the first presenting service when more than one exists', async () => {
    await createService('presenting');
    await createService('presenting', [{
      id: 'other-section', name: 'Other', items: [
        { id: 'other-item', kind: 'custom-slide', title: 'Other', enabled: true, content: undefined },
      ],
    }]);
    expect((await asking()).json().data.items).toEqual([
      { id: 'item-3', label: 'Welcome' }, { id: 'item-2', label: 'Blessing' },
    ]);
  });

  test.each(['services', 'slideLabels'] as const)('returns no partial data when %s fails', async (failing) => {
    if (failing === 'services') vi.spyOn(services, 'list').mockRejectedValue(new Error('private store detail'));
    else vi.spyOn(slideLabels, 'catalogue').mockRejectedValue(new Error('private store detail'));
    const response = await asking();
    expect(response.statusCode).toBe(500);
    expect(response.json().data).toBeUndefined();
    expect(response.body).not.toContain('private store detail');
  });
});
