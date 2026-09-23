import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildApp } from './app.js';
import { SERVICES_MANAGE } from './roles.js';
import { serviceContext, servicesOn } from './services.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { loadSettings } from './settings.js';
import { WORKSPACE_POSITION_PATH } from './workspace-position-routes.js';
import { workspacePositionsOn } from './workspace-positions.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { ServiceStore } from './services.js';
import type { StartedSession } from './sessions.js';
import type { WorkspacePositionCollection, WorkspacePositionDb, WorkspacePositionStore } from './workspace-positions.js';
import type { Document, Filter } from './repositories.js';
import type { FastifyInstance, InjectOptions } from 'fastify';

const NOW = '2026-09-22T10:00:00.000Z';
const OPERATOR = actorFor('A'.repeat(22));
const OTHER = actorFor('B'.repeat(22));
const CORRELATION = 'req-0f9c2a41';

const memoryPositionDb = (): WorkspacePositionDb => {
  const rows = new Map<string, Document>();
  const collection: WorkspacePositionCollection = {
    async findOne(filter: Filter) {
      return rows.get(String(filter['_id'])) ?? null;
    },
    async replaceOne(filter, replacement) {
      rows.set(String(filter['_id']), replacement);
    },
  };
  return { collection: () => collection };
};

let app: FastifyInstance;
let positions: WorkspacePositionStore;
let services: ServiceStore;
let operator: StartedSession;
let member: StartedSession;
let content: Set<string>;

const asking = (
  method: 'GET' | 'PUT',
  payload?: unknown,
  held: StartedSession | 'anonymous' = operator,
  csrf = true,
) => app.inject({
  method,
  url: WORKSPACE_POSITION_PATH,
  ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
  headers: {
    [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
    host: 'holydeck.example.invalid',
    'x-forwarded-proto': 'https',
    origin: 'https://holydeck.example.invalid',
    ...(held === 'anonymous' ? {} : {
      cookie: sessionCookie(held.token, 60),
      ...(csrf ? { [CSRF_HEADER]: held.record.csrf } : {}),
    }),
  },
});

beforeEach(async () => {
  const db = fakeDb();
  services = servicesOn(db, { now: () => NOW, newId: () => 'service-1' });
  await services.create(serviceContext(OPERATOR, CORRELATION), {
    title: 'Sunday', date: '2026-09-27', site: 'Main Hall',
    sections: [{
      id: 'section-1', name: 'Welcome',
      items: [{ id: 'item-1', kind: 'custom-slide', title: 'Welcome', enabled: true, content: undefined }],
    }],
  });
  const sessions = sessionsOn(memorySessions().db, { now: () => NOW });
  operator = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [SERVICES_MANAGE] });
  member = await sessions.start(sessionContext(CORRELATION), { actor: OTHER, permissions: [] });
  positions = workspacePositionsOn(memoryPositionDb(), { now: () => NOW });
  content = new Set(['content-1']);
  app = buildApp({
    settings: loadSettings({ env: {} }), logger: false,
    fetching: () => Promise.reject(new Error('this route must not ask the corpus')),
    sessions, services, workspacePositions: positions,
    contentExists: async (_context, id) => content.has(id),
  });
  await app.ready();
});

afterEach(async () => app.close());

describe('workspace position routes', () => {
  test('round-trips a reachable service item', async () => {
    expect((await asking('PUT', { serviceId: 'service-1', itemId: 'item-1' })).statusCode).toBe(200);
    const response = await asking('GET');
    expect(response.json().data).toEqual({ position: { serviceId: 'service-1', itemId: 'item-1' } });
    expect(response.json().meta.dropped).toEqual([]);
  });

  test('drops a service and item that no longer exist', async () => {
    await asking('PUT', { serviceId: 'service-404', itemId: 'item-404' });
    const response = await asking('GET');
    expect(response.json().data).toEqual({ position: {} });
    expect(response.json().meta.dropped).toEqual(['serviceId', 'itemId']);
  });

  test('drops an item absent from its service', async () => {
    await asking('PUT', { serviceId: 'service-1', itemId: 'item-404' });
    const response = await asking('GET');
    expect(response.json().data).toEqual({ position: { serviceId: 'service-1' } });
    expect(response.json().meta.dropped).toEqual(['itemId']);
  });

  test('does not disclose a service to a session without services.manage', async () => {
    await asking('PUT', { serviceId: 'service-1', itemId: 'item-1' }, member);
    const response = await asking('GET', undefined, member);
    expect(response.json().data).toEqual({ position: {} });
    expect(response.json().meta.dropped).toEqual(['serviceId', 'itemId']);
  });

  test('drops content that no longer exists', async () => {
    content.delete('content-404');
    await asking('PUT', { contentId: 'content-404' });
    const response = await asking('GET');
    expect(response.json().data).toEqual({ position: {} });
    expect(response.json().meta.dropped).toEqual(['contentId']);
  });

  test('keeps each account position private', async () => {
    await asking('PUT', { serviceId: 'service-1' });
    expect((await asking('GET', undefined, member)).json().data).toEqual({ position: {} });
  });

  test('validates and protects writes', async () => {
    expect((await asking('PUT', { itemId: 'x' })).statusCode).toBe(422);
    expect((await asking('PUT', { serviceId: 'service-1' }, 'anonymous')).statusCode).toBe(401);
    expect((await asking('PUT', { serviceId: 'service-1' }, operator, false)).statusCode).toBe(403);
  });

  test('does not persist fields GET drops', async () => {
    await asking('PUT', { serviceId: 'service-404', itemId: 'item-404' });
    await asking('GET');
    expect(await positions.read(OPERATOR)).toEqual({
      serviceId: 'service-404', itemId: 'item-404', updatedAt: NOW,
    });
  });
});
