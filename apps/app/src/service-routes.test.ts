import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildApp } from './app.js';
import { libraryContext, libraryOn } from './library.js';
import { RECORDS } from './records.js';
import { revisionsOn } from './revisions.js';
import { SERVICES_MANAGE, SETTINGS_MANAGE } from './roles.js';
import { ServiceError, serviceContext, servicesOn } from './services.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { loadSettings } from './settings.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { ServiceDraft } from '@holydeck/contracts/services';
import type { ServiceStore } from './services.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const NOW = '2026-09-22T09:30:00.000Z';
const OPERATOR = actorFor('C'.repeat(22));
const CORRELATION = 'req-0f9c2a41';
const CONTEXT = serviceContext(OPERATOR, CORRELATION);
const ITEM = { id: 'item-1', kind: 'custom-slide', title: 'Welcome', enabled: true } as const;
const DRAFT: ServiceDraft = {
  title: 'Sunday Morning', date: '2026-09-27', site: 'Main Hall',
  sections: [{ id: 'section-1', name: 'Welcome', items: [{ ...ITEM, content: undefined }] }],
};
const ROOT = '/api/v1/services/service-1';
const ITEMS = `${ROOT}/sections/section-1/items`;
const ITEM_ACTIONS = `${ROOT}/items`;
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const ROUTES: readonly (readonly [Method, string, unknown])[] = [
  ['POST', '/api/v1/services', DRAFT],
  ['GET', '/api/v1/services', undefined],
  ['GET', '/api/v1/services/current', undefined],
  ['GET', ROOT, undefined],
  ['POST', `${ROOT}/duplicate`, undefined],
  ['POST', `${ROOT}/schedule`, { date: '2026-10-04' }],
  ['POST', `${ROOT}/transition`, { state: 'presenting' }],
  ['PATCH', ROOT, DRAFT],
  ['PATCH', `${ROOT}/status`, { archived: true }],
  ['POST', ITEMS, { ...ITEM, id: 'item-2' }],
  ['DELETE', `${ITEM_ACTIONS}/item-1`, undefined],
  ['POST', `${ITEM_ACTIONS}/item-1/enable`, undefined],
  ['POST', `${ITEM_ACTIONS}/item-1/disable`, undefined],
  ['POST', `${ITEM_ACTIONS}/item-1/duplicate`, undefined],
  ['POST', `${ITEMS}/reorder`, { itemIds: ['item-1'] }],
  ['POST', `${ITEM_ACTIONS}/item-1/revise`, { revision: 2 }],
  ['GET', `${ROOT}/content-drift`, undefined],
] as const;

const store = (): { db: FakeDb; services: ServiceStore } => {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  return {
    db,
    services: servicesOn(db, {
      now: () => new Date(Date.parse(NOW) + tick++ * 1000).toISOString(),
      newId: () => `service-${++serial}`,
    }),
  };
};

let app: FastifyInstance;
let db: FakeDb;
let services: ServiceStore;
let sessions: SessionStore;
let operator: StartedSession;

const building = async (held: ServiceStore | undefined): Promise<void> => {
  app = buildApp({
    settings: loadSettings({ env: {} }),
    logger: false,
    fetching: () => Promise.reject(new Error('this route must not ask the corpus')),
    sessions,
    ...(held === undefined ? {} : { services: held }),
  });
  await app.ready();
};

const asking = (method: Method, url: string, payload?: unknown, held: StartedSession | 'anonymous' = operator) =>
  app.inject({
    method, url,
    ...(payload === undefined ? {} : { payload: payload as never }),
    headers: {
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      host: 'holydeck.example.invalid',
      'x-forwarded-proto': 'https',
      origin: 'https://holydeck.example.invalid',
      ...(held === 'anonymous' ? {} : {
        cookie: sessionCookie(held.token, 60),
        [CSRF_HEADER]: held.record.csrf,
      }),
    },
  });

const creating = async (): Promise<void> => {
  expect((await asking('POST', '/api/v1/services', DRAFT)).statusCode).toBe(201);
};
const entries = () => db.rows.get(RECORDS.auditEvents.collection) ?? [];

beforeEach(async () => {
  ({ db, services } = store());
  sessions = sessionsOn(memorySessions().db, { now: () => NOW });
  operator = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [SERVICES_MANAGE] });
  await building(services);
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('service workspace routes', () => {
  test('creates, lists and reads a service with request context and one audit entry', async () => {
    const create = vi.spyOn(services, 'create');
    const response = await asking('POST', '/api/v1/services', DRAFT);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: { title: DRAFT.title, state: 'upcoming', stamp: { id: 'service-1', createdBy: OPERATOR } },
      meta: { requestId: expect.any(String), version: CLIENT_WINDOW.current },
    });
    const requestId = response.json().meta.requestId as string;
    expect(create).toHaveBeenCalledWith(serviceContext(OPERATOR, `service:${requestId}`), DRAFT);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ action: 'service.create', actor: OPERATOR, correlationId: `service:${requestId}` });
    const listing = await asking('GET', '/api/v1/services');
    expect(listing.statusCode).toBe(200);
    expect(listing.json().data).toEqual([response.json().data]);
    const reading = await asking('GET', ROOT);
    expect(reading.statusCode).toBe(200);
    expect(reading.json().data).toEqual(response.json().data);
    expect(entries()).toHaveLength(1);
  });

  test('lists an empty store and returns 404 when no service is presenting', async () => {
    expect((await asking('GET', '/api/v1/services')).json().data).toEqual([]);
    expect((await asking('GET', '/api/v1/services/current')).statusCode).toBe(404);
    await creating();
    expect((await asking('GET', '/api/v1/services/current')).statusCode).toBe(404);
  });

  test('reads the first presenting service through current without treating current as an id', async () => {
    await creating();
    const second = await services.create(CONTEXT, { ...DRAFT, title: 'Presenting' });
    const presenting = await services.transition(CONTEXT, second.stamp.id, 'presenting');
    const third = await services.create(CONTEXT, { ...DRAFT, title: 'Also presenting' });
    await services.transition(CONTEXT, third.stamp.id, 'presenting');
    const current = vi.spyOn(services, 'current');
    const response = await asking('GET', '/api/v1/services/current');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(JSON.parse(JSON.stringify(presenting)));
    expect(current).toHaveBeenCalledWith(serviceContext(OPERATOR, `service:${response.json().meta.requestId}`), second.stamp.id);
  });

  test('duplicates a service under a fresh identifier', async () => {
    await creating();
    const response = await asking('POST', `${ROOT}/duplicate`);
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ title: DRAFT.title, state: 'upcoming', stamp: { id: 'service-2' } });
    expect(entries().map((entry) => entry['action'])).toEqual(['service.create', 'service.duplicate']);
  });

  test('schedules, transitions and edits sections while preserving other service fields', async () => {
    await creating();
    const scheduled = await asking('POST', `${ROOT}/schedule`, { date: '2026-10-04' });
    expect(scheduled.statusCode).toBe(200);
    expect(scheduled.json().data).toMatchObject({ date: '2026-10-04', state: 'upcoming' });
    const transitioned = await asking('POST', `${ROOT}/transition`, { state: 'presenting' });
    expect(transitioned.statusCode).toBe(200);
    expect(transitioned.json().data.state).toBe('presenting');
    const edited = await asking('PATCH', ROOT, { ...DRAFT, title: 'Ignored', sections: [] });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().data).toMatchObject({ title: DRAFT.title, date: '2026-10-04', state: 'presenting', sections: [] });
    expect(entries().map((entry) => entry['action'])).toEqual([
      'service.create', 'service.schedule', 'service.transition', 'service.edit',
    ]);
  });

  test('archives and restores through the status flag', async () => {
    await creating();
    const archived = await asking('PATCH', `${ROOT}/status`, { archived: true });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.stamp.archivedBy).toBe(OPERATOR);
    const restored = await asking('PATCH', `${ROOT}/status`, { archived: false });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().data.stamp.archivedAt).toBeUndefined();
    expect(entries().map((entry) => entry['action'])).toEqual(['service.create', 'service.archive', 'service.archive']);
  });

  test('adds, disables, enables, duplicates, reorders and removes items', async () => {
    await creating();
    const added = await asking('POST', ITEMS, { ...ITEM, id: 'item-2' });
    expect(added.statusCode).toBe(200);
    expect(added.json().data.sections[0].items).toEqual([ITEM, { ...ITEM, id: 'item-2' }]);
    const disabled = await asking('POST', `${ITEM_ACTIONS}/item-1/disable`);
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().data.sections[0].items[0].enabled).toBe(false);
    const enabled = await asking('POST', `${ITEM_ACTIONS}/item-1/enable`);
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().data.sections[0].items[0].enabled).toBe(true);
    const duplicated = await asking('POST', `${ITEM_ACTIONS}/item-1/duplicate`);
    expect(duplicated.statusCode).toBe(200);
    expect(duplicated.json().data.sections[0].items).toEqual([ITEM, { ...ITEM, id: 'service-2' }, { ...ITEM, id: 'item-2' }]);
    const reordered = await asking('POST', `${ITEMS}/reorder`, { itemIds: ['item-2', 'service-2', 'item-1'] });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().data.sections[0].items.map((item: { id: string }) => item.id)).toEqual(['item-2', 'service-2', 'item-1']);
    const removed = await asking('DELETE', `${ITEM_ACTIONS}/item-1`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data.sections[0].items).toHaveLength(2);
    expect(removed.json().data.sections[0].items.map((item: { id: string }) => item.id)).toEqual(['item-2', 'service-2']);
    expect(entries().map((entry) => entry['action'])).toEqual([
      'service.create', 'service.item.add', 'service.item.disable', 'service.item.enable',
      'service.item.duplicate', 'service.item.reorder', 'service.item.remove',
    ]);
  });

  test('disables an item in the second section without naming its section', async () => {
    const draft: ServiceDraft = {
      ...DRAFT,
      sections: [
        { id: 'section-1', name: 'Welcome', items: [] },
        { id: 'section-2', name: 'Announcements', items: [{ ...ITEM, content: undefined }] },
      ],
    };
    expect((await asking('POST', '/api/v1/services', draft)).statusCode).toBe(201);
    const disabled = await asking('POST', `${ITEM_ACTIONS}/item-1/disable`);
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().data.sections[1]).toEqual({
      id: 'section-2', name: 'Announcements', items: [{ ...ITEM, enabled: false }],
    });
  });

  test('reads content drift and revises a pinned item only on request', async () => {
    const library = libraryOn(db, { now: () => NOW, newId: () => 'song-1' });
    await library.create(libraryContext(OPERATOR, CORRELATION), { kind: 'song', title: 'Grace' });
    const revisions = revisionsOn(db, { now: () => NOW });
    const context = { ...CONTEXT, permissions: [...CONTEXT.permissions, 'contentRevisions.append'] };
    const first = await revisions.save(context, { contentId: 'song-1', body: { verse: 1 }, origin: 'autosave' });
    const second = await revisions.save(context, { contentId: 'song-1', body: { verse: 2 }, origin: 'autosave' });
    await creating();
    expect((await asking('GET', `${ROOT}/content-drift`)).json().data).toEqual([]);
    const item = { ...ITEM, id: 'song-item', kind: 'song', content: { id: 'song-1', revision: 1, hash: first.revision.hash } };
    expect((await asking('POST', ITEMS, item)).statusCode).toBe(200);
    const drift = await asking('GET', `${ROOT}/content-drift`);
    expect(drift.statusCode).toBe(200);
    expect(drift.json().data).toEqual([
      { itemId: 'song-item', contentId: 'song-1', pinnedRevision: 1, latestRevision: 2, drifted: true },
    ]);
    const revised = await asking('POST', `${ITEM_ACTIONS}/song-item/revise`, { revision: 2 });
    expect(revised.statusCode).toBe(200);
    expect(revised.json().data.sections[0].items[1].content).toEqual({ id: 'song-1', revision: 2, hash: second.revision.hash });
    expect((await asking('GET', `${ROOT}/content-drift`)).json().data[0].drifted).toBe(false);
    expect(entries().filter((entry) => entry['action'] === 'service.item.revise')).toHaveLength(1);
  });

  test.each(ROUTES)('gates %s %s before calling the store', async (method, url, payload) => {
    const spies = Object.keys(services).map((key) => vi.spyOn(services, key as keyof ServiceStore));
    const bystander = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [SETTINGS_MANAGE] });
    expect((await asking(method, url, payload, bystander)).statusCode).toBe(403);
    expect((await asking(method, url, payload, 'anonymous')).statusCode).toBe(401);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  test.each(ROUTES)('serves a gated fallback for %s %s without a store', async (method, url, payload) => {
    await app.close();
    await building(undefined);
    const response = await asking(method, url, payload);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('resource.not_found');
    const bystander = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [] });
    expect((await asking(method, url, payload, bystander)).statusCode).toBe(403);
  });

  test.each(ROUTES.filter(([, url]) => url !== '/api/v1/services' && url !== '/api/v1/services/current'))(
    'returns 404 for an unknown service on %s %s', async (method, url, payload) => {
      const response = await asking(method, url, payload);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('resource.not_found');
      expect(entries()).toEqual([]);
    },
  );

  test.each([
    ['POST', '/api/v1/services', 'create'],
    ['PATCH', ROOT, 'edit'],
    ['POST', `${ROOT}/schedule`, 'schedule'],
    ['POST', `${ROOT}/transition`, 'transition'],
    ['PATCH', `${ROOT}/status`, 'archive'],
    ['POST', ITEMS, 'addItem'],
    ['POST', `${ITEMS}/reorder`, 'reorderItems'],
    ['POST', `${ITEM_ACTIONS}/item-1/revise`, 'reviseItem'],
  ] as const)('rejects malformed bodies before %s %s reaches %s', async (method, url, operation) => {
    const spy = vi.spyOn(services, operation);
    const response = await asking(method, url, {});
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(spy).not.toHaveBeenCalled();
    expect(entries()).toEqual([]);
  });

  test('maps an illegal transition and a competing write to 409', async () => {
    await creating();
    const transition = await asking('POST', `${ROOT}/transition`, { state: 'completed' });
    expect(transition.statusCode).toBe(409);
    expect(transition.json().error.code).toBe(ENTITY_CONFLICT);
    db.failOn = (collection) => collection === RECORDS.services.collection
      ? Object.assign(new Error('duplicate key'), { code: 11_000 }) : undefined;
    const conflict = await asking('PATCH', ROOT, DRAFT);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe(ENTITY_CONFLICT);
    expect(entries()).toHaveLength(1);
  });

  test('maps unknown items, invalid calendar days and duplicate item ids to 404', async () => {
    await creating();
    for (const response of [
      await asking('DELETE', `${ITEMS}/unknown`),
      await asking('POST', `${ROOT}/schedule`, { date: '2026-09-31' }),
      await asking('POST', ITEMS, ITEM),
    ]) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('resource.not_found');
    }
    expect(entries()).toHaveLength(1);
  });

  test.each(ROUTES)('maps schema refusals on %s %s', async (method, url, payload) => {
    for (const key of Object.keys(services)) {
      vi.spyOn(services, key as keyof ServiceStore).mockRejectedValue(new ServiceError('schema', 'private detail'));
    }
    const response = await asking(method, url, payload);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('resource.not_found');
    expect(response.body).not.toContain('private detail');
  });

  test.each([new ServiceError('corrupt', 'private detail'), new Error('private detail')])(
    'leaves server faults to the application error handler: %s', async (error) => {
      vi.spyOn(services, 'create').mockRejectedValue(error);
      const response = await asking('POST', '/api/v1/services', DRAFT);
      expect(response.statusCode).toBe(500);
      expect(response.json().data).toBeUndefined();
      expect(response.body).not.toContain('private detail');
    },
  );
});
