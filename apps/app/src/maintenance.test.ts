import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  MAINTENANCE_COLLECTION,
  MAINTENANCE_LEASE_TTL_MS,
  guardMaintenance,
  maintenanceOn,
  releaseOrphanedLease,
} from './maintenance.js';

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

describe('releaseOrphanedLease', () => {
  let memory: ReturnType<typeof memoryMaintenance>;
  let store: MaintenanceStore;

  beforeEach(() => {
    memory = memoryMaintenance();
    store = maintenanceOn(memory.db);
  });

  test('releases an active lease and reports why', async () => {
    await store.acquire('applying restore backup-1', '2026-09-19T03:00:00.000Z');
    const reported: string[] = [];
    await releaseOrphanedLease(store, (line) => reported.push(line));
    await expect(store.read()).resolves.toEqual({ active: false });
    expect(reported).toEqual(['released an orphaned maintenance lease (applying restore backup-1)']);
  });

  test('does nothing and reports nothing while idle', async () => {
    const reported: string[] = [];
    await releaseOrphanedLease(store, (line) => reported.push(line));
    await expect(store.read()).resolves.toEqual({ active: false });
    expect(reported).toEqual([]);
  });
});

describe('the maintenance guard', () => {
  let memory: ReturnType<typeof memoryMaintenance>;
  let store: MaintenanceStore;
  let app: FastifyInstance;

  const serving = async (
    maintenance: MaintenanceStore | undefined,
    now: () => string = () => '2026-09-19T03:00:00.000Z',
  ): Promise<FastifyInstance> => {
    const built = Fastify({ logger: false });
    guardMaintenance(built, { maintenance, now });
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

  test('never sends the lease reason to the client, which may not be authenticated yet', async () => {
    await store.acquire('applying restore backup-with-a-secret-id', '2026-09-19T03:00:00.000Z');
    const response = await app.inject({ method: 'POST', url: '/api/v1/anything' });
    const body = JSON.stringify(response.json());
    expect(body).not.toContain('backup-with-a-secret-id');
  });

  test('lets every request through when this deployment keeps no maintenance lease at all', async () => {
    const unguarded = await serving(undefined);
    const response = await unguarded.inject({ method: 'POST', url: '/api/v1/anything' });
    expect(response.statusCode).toBe(200);
    await unguarded.close();
  });

  test('treats a lease older than the TTL as idle rather than blocking writes forever', async () => {
    await store.acquire('applying a restore', '2026-09-19T03:00:00.000Z');
    const stale = await serving(store, () => new Date(Date.parse('2026-09-19T03:00:00.000Z') + MAINTENANCE_LEASE_TTL_MS + 1).toISOString());
    const response = await stale.inject({ method: 'POST', url: '/api/v1/anything' });
    expect(response.statusCode).toBe(200);
    await stale.close();
  });

  test('still blocks a lease that is within the TTL', async () => {
    await store.acquire('applying a restore', '2026-09-19T03:00:00.000Z');
    const fresh = await serving(store, () => new Date(Date.parse('2026-09-19T03:00:00.000Z') + MAINTENANCE_LEASE_TTL_MS - 1).toISOString());
    const response = await fresh.inject({ method: 'POST', url: '/api/v1/anything' });
    expect(response.statusCode).toBe(503);
    await fresh.close();
  });
});
