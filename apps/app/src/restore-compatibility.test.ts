import { describe, expect, test } from 'vitest';

import {
  RESTORE_COMPATIBILITY_COLLECTION,
  RESTORE_COMPATIBILITY_WINDOW_MS,
  restoreCompatibilityOn,
} from './restore-compatibility.js';

import type { RestoreCompatibilityCollection, RestoreCompatibilityDb, RestoreCompatibilityStore } from './restore-compatibility.js';
import type { Document, Filter } from './repositories.js';

/** An in-memory `RestoreCompatibilityDb`, mirroring `maintenance.test.ts`'s own fake. */
const memoryCompatibility = (): { readonly rows: Map<string, Document>; readonly db: RestoreCompatibilityDb } => {
  const rows = new Map<string, Document>();
  const idOf = (filter: Filter): string => String(filter['_id']);
  const collection: RestoreCompatibilityCollection = {
    findOne: async (filter) => rows.get(idOf(filter)) ?? null,
    findOneAndUpdate: async (filter, update) => {
      const id = idOf(filter);
      const patch = (update as { readonly $set?: Document })['$set'] ?? {};
      const next: Record<string, unknown> = { ...(rows.get(id) ?? {}), ...patch, _id: id };
      rows.set(id, next);
      return next;
    },
  };
  return { rows, db: { collection: () => collection } };
};

describe('the restore compatibility marker', () => {
  test('names the collection it owns', () => {
    expect(RESTORE_COMPATIBILITY_COLLECTION).toBe('restore_compatibility');
  });

  test('is not recently restored against an empty collection', async () => {
    const store = restoreCompatibilityOn(memoryCompatibility().db, { now: () => '2026-09-23T00:00:00.000Z' });
    await expect(store.restoredRecently()).resolves.toBe(false);
  });

  test('recording a restore makes it recently restored, upserting the single document', async () => {
    const memory = memoryCompatibility();
    const clock = '2026-09-23T00:00:00.000Z';
    const store = restoreCompatibilityOn(memory.db, { now: () => clock });
    await store.record();
    await expect(store.restoredRecently()).resolves.toBe(true);
    expect(memory.rows.size).toBe(1);
  });

  test('stays recently restored right up to the grace window boundary', async () => {
    const memory = memoryCompatibility();
    let clock = '2026-09-23T00:00:00.000Z';
    const store = restoreCompatibilityOn(memory.db, { now: () => clock });
    await store.record();
    clock = new Date(Date.parse('2026-09-23T00:00:00.000Z') + RESTORE_COMPATIBILITY_WINDOW_MS).toISOString();
    await expect(store.restoredRecently()).resolves.toBe(true);
  });

  test('stops being recently restored once the grace window has passed', async () => {
    const memory = memoryCompatibility();
    let clock = '2026-09-23T00:00:00.000Z';
    const store = restoreCompatibilityOn(memory.db, { now: () => clock });
    await store.record();
    clock = new Date(Date.parse('2026-09-23T00:00:00.000Z') + RESTORE_COMPATIBILITY_WINDOW_MS + 1).toISOString();
    await expect(store.restoredRecently()).resolves.toBe(false);
  });

  test('recording twice restates the marker at the later time', async () => {
    const memory = memoryCompatibility();
    let clock = '2026-09-23T00:00:00.000Z';
    const store = restoreCompatibilityOn(memory.db, { now: () => clock });
    await store.record();
    clock = '2026-09-23T01:00:00.000Z';
    await store.record();
    expect(memory.rows.size).toBe(1);
    expect(memory.rows.get('restore_compatibility')?.['restoredAt']).toBe('2026-09-23T01:00:00.000Z');
  });
});

describe('restoreCompatibilityOn: RestoreCompatibilityStore', () => {
  test('is frozen, the same shape every other single-document store here takes', () => {
    const store: RestoreCompatibilityStore = restoreCompatibilityOn(memoryCompatibility().db, { now: () => '2026-09-23T00:00:00.000Z' });
    expect(Object.isFrozen(store)).toBe(true);
  });
});
