import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MAINTENANCE_COLLECTION, guardMaintenance, maintenanceOn } from './maintenance.js';

import type { MaintenanceCollection, MaintenanceDb, MaintenanceStore } from './maintenance.js';
import type { FastifyInstance } from 'fastify';
import type { Document, Filter } from './repositories.js';

/** An in-memory `MaintenanceDb`, for a store test that has no database to hold a document in. */
const memoryMaintenance = (): { readonly rows: Map<string, Document>; readonly db: MaintenanceDb } => {
  const rows = new Map<string, Document>();
  const idOf = (filter: Filter): string => String(filter['_id']);
  const collection: MaintenanceCollection = {
    findOne: async (filter) => rows.get(idOf(filter)) ?? null,
    findOneAndUpdate: async (filter, update) => {
      const id = idOf(filter);
      const patch = (update as { readonly $set?: Document })['$set'] ?? {};
      const unset = (update as { readonly $unset?: Document })['$unset'] ?? {};
      const next: Record<string, unknown> = { ...(rows.get(id) ?? {}), ...patch, _id: id };
      for (const field of Object.keys(unset)) delete next[field];
      rows.set(id, next);
      return next;
    },
  };
  return { rows, db: { collection: () => collection } };
};

describe('the maintenance lease', () => {
  let memory: ReturnType<typeof memoryMaintenance>;
  let store: MaintenanceStore;

  beforeEach(() => {
    memory = memoryMaintenance();
    store = maintenanceOn(memory.db);
  });

  test('names the collection it owns', () => {
    expect(MAINTENANCE_COLLECTION).toBe('maintenance');
  });

  test('reads idle against an empty collection', async () => {
    await expect(store.read()).resolves.toEqual({ active: false });
  });

  test('acquiring sets active, a reason and when, upserting the single document', async () => {
    await store.acquire('applying backup-2026-09-19T02-00-00Z', '2026-09-19T03:00:00.000Z');
    await expect(store.read()).resolves.toEqual({
      active: true,
      reason: 'applying backup-2026-09-19T02-00-00Z',
      startedAt: '2026-09-19T03:00:00.000Z',
    });
    expect(memory.rows.size).toBe(1);
  });

  test('releasing clears the reason and when, leaving only active: false', async () => {
    await store.acquire('applying backup-2026-09-19T02-00-00Z', '2026-09-19T03:00:00.000Z');
    await store.release();
    await expect(store.read()).resolves.toEqual({ active: false });
    expect(memory.rows.size).toBe(1);
  });

  test('acquiring twice restates the lease rather than failing', async () => {
    await store.acquire('first', '2026-09-19T03:00:00.000Z');
    await store.acquire('second', '2026-09-19T03:05:00.000Z');
    await expect(store.read()).resolves.toEqual({
      active: true,
      reason: 'second',
      startedAt: '2026-09-19T03:05:00.000Z',
    });
  });
});

describe('the maintenance guard', () => {
  let memory: ReturnType<typeof memoryMaintenance>;
  let store: MaintenanceStore;
  let app: FastifyInstance;

  const serving = async (maintenance: MaintenanceStore | undefined): Promise<FastifyInstance> => {
    const built = Fastify({ logger: false });
    guardMaintenance(built, { maintenance });
    built.post('/api/v1/anything', () => ({ ok: true }));
    built.get('/api/v1/anything', () => ({ ok: true }));
    await built.ready();
    return built;
  };

  beforeEach(async () => {
    memory = memoryMaintenance();
    store = maintenanceOn(memory.db);
    app = await serving(store);
  });

  afterEach(async () => {
    await app.close();
  });

  test('lets a mutating request through while idle', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/anything' });
    expect(response.statusCode).toBe(200);
  });

  test('lets a read through while a restore is applying', async () => {
    await store.acquire('applying a restore', '2026-09-19T03:00:00.000Z');
    const response = await app.inject({ method: 'GET', url: '/api/v1/anything' });
    expect(response.statusCode).toBe(200);
  });

  test('refuses a mutating request with 503 server.maintenance_active while a restore is applying', async () => {
    await store.acquire('applying backup-2026-09-19T02-00-00Z', '2026-09-19T03:00:00.000Z');
    const response = await app.inject({ method: 'POST', url: '/api/v1/anything' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'server.maintenance_active' } });
  });

  test('lets every request through when this deployment keeps no maintenance lease at all', async () => {
    const unguarded = await serving(undefined);
    const response = await unguarded.inject({ method: 'POST', url: '/api/v1/anything' });
    expect(response.statusCode).toBe(200);
    await unguarded.close();
  });
});
