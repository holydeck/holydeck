import { beforeEach, describe, expect, test } from 'vitest';

import { MEDIA_MIGRATION_STATE_COLLECTION, mediaMigrationStateOn } from './media-migration-state.js';

import type { MediaMigrationStateCollection, MediaMigrationStateDb, MediaMigrationStateStore } from './media-migration-state.js';
import type { Document, Filter } from './repositories.js';

/** An in-memory `MediaMigrationStateDb`, for a store test that has no database to hold a document in. */
const memoryMigrationState = (): { readonly rows: Map<string, Document>; readonly db: MediaMigrationStateDb } => {
  const rows = new Map<string, Document>();
  const idOf = (filter: Filter): string => String(filter['_id']);
  const collection: MediaMigrationStateCollection = {
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

describe('the media storage-root migration record', () => {
  let memory: ReturnType<typeof memoryMigrationState>;
  let store: MediaMigrationStateStore;

  beforeEach(() => {
    memory = memoryMigrationState();
    store = mediaMigrationStateOn(memory.db);
  });

  test('names the collection it owns', () => {
    expect(MEDIA_MIGRATION_STATE_COLLECTION).toBe('media_migration_state');
  });

  test('reads undefined against an empty collection', async () => {
    await expect(store.read()).resolves.toBeUndefined();
  });

  test('recording a completion upserts the single document', async () => {
    await store.recordCompletion({
      fromRoot: '/mnt/media-old',
      toRoot: '/mnt/media-new',
      completedAt: '2026-09-23T03:00:00.000Z',
    });
    await expect(store.read()).resolves.toEqual({
      fromRoot: '/mnt/media-old',
      toRoot: '/mnt/media-new',
      completedAt: '2026-09-23T03:00:00.000Z',
    });
    expect(memory.rows.size).toBe(1);
  });

  test('recording a cleanup adds cleanedUpAt without disturbing the completion fields', async () => {
    await store.recordCompletion({
      fromRoot: '/mnt/media-old',
      toRoot: '/mnt/media-new',
      completedAt: '2026-09-23T03:00:00.000Z',
    });
    await store.recordCleanup('2026-09-23T04:00:00.000Z');
    await expect(store.read()).resolves.toEqual({
      fromRoot: '/mnt/media-old',
      toRoot: '/mnt/media-new',
      completedAt: '2026-09-23T03:00:00.000Z',
      cleanedUpAt: '2026-09-23T04:00:00.000Z',
    });
  });

  test('a second completion clears any prior cleanedUpAt', async () => {
    await store.recordCompletion({
      fromRoot: '/mnt/media-old',
      toRoot: '/mnt/media-new',
      completedAt: '2026-09-23T03:00:00.000Z',
    });
    await store.recordCleanup('2026-09-23T04:00:00.000Z');
    await store.recordCompletion({
      fromRoot: '/mnt/media-new',
      toRoot: '/mnt/media-newer',
      completedAt: '2026-09-24T03:00:00.000Z',
    });
    await expect(store.read()).resolves.toEqual({
      fromRoot: '/mnt/media-new',
      toRoot: '/mnt/media-newer',
      completedAt: '2026-09-24T03:00:00.000Z',
    });
  });
});
