import { beforeEach, describe, expect, test } from 'vitest';

import { SCHEDULER_STATE_COLLECTION, schedulerStateOn } from './scheduler-state.js';

import type { SchedulerStateCollection, SchedulerStateDb, SchedulerStateStore } from './scheduler-state.js';
import type { Document, Filter } from '@holydeck/app/repositories';

/** An in-memory `SchedulerStateDb`, for a store test that has no database to hold a document in. */
const memorySchedulerState = (): { readonly rows: Map<string, Document>; readonly db: SchedulerStateDb } => {
  const rows = new Map<string, Document>();
  const idOf = (filter: Filter): string => String(filter['_id']);
  const collection: SchedulerStateCollection = {
    findOne: async (filter) => rows.get(idOf(filter)) ?? null,
    findOneAndUpdate: async (filter, update) => {
      const id = idOf(filter);
      const patch = (update as { readonly $set?: Document })['$set'] ?? {};
      const next = { ...(rows.get(id) ?? {}), ...patch, _id: id };
      rows.set(id, next);
      return next;
    },
  };
  return { rows, db: { collection: () => collection } };
};

let memory: ReturnType<typeof memorySchedulerState>;
let store: SchedulerStateStore;

beforeEach(() => {
  memory = memorySchedulerState();
  store = schedulerStateOn(memory.db);
});

describe('scheduler state', () => {
  test('names the collection it owns', () => {
    expect(SCHEDULER_STATE_COLLECTION).toBe('scheduler_state');
  });

  test('reads an all-undefined state against an empty collection', async () => {
    await expect(store.read()).resolves.toEqual({
      lastBackupAt: undefined,
      lastRestoreRehearsalAt: undefined,
      lastRetentionSweepAt: undefined,
    });
  });

  test('each mark method sets only its own field, upserting the single scheduler document', async () => {
    await store.markBackup('2026-09-13T03:00:00.000Z');
    await expect(store.read()).resolves.toEqual({
      lastBackupAt: '2026-09-13T03:00:00.000Z',
      lastRestoreRehearsalAt: undefined,
      lastRetentionSweepAt: undefined,
    });

    await store.markRestoreRehearsal('2026-09-13T04:00:00.000Z');
    await expect(store.read()).resolves.toEqual({
      lastBackupAt: '2026-09-13T03:00:00.000Z',
      lastRestoreRehearsalAt: '2026-09-13T04:00:00.000Z',
      lastRetentionSweepAt: undefined,
    });

    await store.markRetentionSweep('2026-09-13T05:00:00.000Z');
    await expect(store.read()).resolves.toEqual({
      lastBackupAt: '2026-09-13T03:00:00.000Z',
      lastRestoreRehearsalAt: '2026-09-13T04:00:00.000Z',
      lastRetentionSweepAt: '2026-09-13T05:00:00.000Z',
    });

    expect(memory.rows.size).toBe(1);
  });

  test('calling the same mark method twice overwrites rather than duplicating', async () => {
    await store.markBackup('2026-09-13T03:00:00.000Z');
    await store.markBackup('2026-09-14T03:00:00.000Z');

    await expect(store.read()).resolves.toMatchObject({ lastBackupAt: '2026-09-14T03:00:00.000Z' });
    expect(memory.rows.size).toBe(1);
  });
});
