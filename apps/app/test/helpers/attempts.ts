// The attempt gate's collection, in memory. Shared by the gate's own suite and by the sign-in route's,
// because a route proving what a lock refuses needs the gate that locks, not a second stub of one.

import type { AttemptCollection, AttemptDb } from '../../src/attempts.js';
import type { Document, Filter } from '../../src/repositories.js';

/**
 * An in-memory collection that keeps the operators the gate actually sends — an upsert that increments
 * and answers with the document after the change — because the whole of "the tenth failure is the one
 * that locks" is read out of that answer. The integration suite runs the same gate against a real
 * MongoDB, which is where the operators themselves are proved.
 */
export const memoryAttempts = (): { rows: Map<string, Document>; db: AttemptDb; names: string[] } => {
  const rows = new Map<string, Document>();
  const names: string[] = [];

  const idOf = (filter: Filter): string => String(filter['_id']);

  const apply = (row: Document, update: Document): Document => {
    const next: Record<string, unknown> = { ...row };
    const increments = (update['$inc'] ?? {}) as Readonly<Record<string, number>>;
    for (const [field, by] of Object.entries(increments)) next[field] = Number(next[field] ?? 0) + by;
    Object.assign(next, (update['$set'] ?? {}) as Document);
    return next;
  };

  const collection: AttemptCollection = {
    findOne: async (filter) => rows.get(idOf(filter)) ?? null,
    findOneAndUpdate: async (filter, update) => {
      const id = idOf(filter);
      const opened = { _id: id, ...((update['$setOnInsert'] ?? {}) as Document) };
      const next = apply(rows.get(id) ?? opened, update);
      rows.set(id, next);
      return next;
    },
    updateOne: async (filter, update) => {
      const row = rows.get(idOf(filter));
      if (row === undefined) return { matchedCount: 0 };
      rows.set(idOf(filter), apply(row, update));
      return { matchedCount: 1 };
    },
    deleteOne: async (filter) => ({ deletedCount: rows.delete(idOf(filter)) ? 1 : 0 }),
    createIndex: async () => 'created',
    dropIndex: async () => undefined,
  };

  return {
    rows,
    names,
    db: {
      collection: (name) => {
        names.push(name);
        return collection;
      },
    },
  };
};
