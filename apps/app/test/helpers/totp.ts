// The second factor's collection, in memory. Shared by the store's own suite and by the routes', because
// a route proving what a replayed code is refused by needs the store that refuses it, not a stub of one.

import type { Document, Filter } from '../../src/repositories.js';
import type { TotpCollection, TotpDb } from '../../src/totp.js';

const duplicateKey = (): Error => Object.assign(new Error('E11000 duplicate key'), { code: 11_000 });

/**
 * Enough of a Mongo collection to hold one credential per account and to answer the operators the store
 * actually sends: an upsert that refuses to open a second document under one identifier, a conditional
 * `$lt` that is how a code is spent exactly once, and a `$pull` that is how a recovery code is. The
 * integration suite runs the same store against a real MongoDB, which is where the operators are proved.
 */
export const memoryTotp = (): {
  rows: Map<string, Document>;
  db: TotpDb;
  names: string[];
  /** Run before every write, which is how a test puts a racing request between a read and its write. */
  beforeWrite?: () => void;
} => {
  const rows = new Map<string, Document>();
  const names: string[] = [];
  const state: { beforeWrite?: () => void } = {};

  const idOf = (filter: Filter): string => String(filter['_id']);

  const matches = (row: Document, filter: Filter): boolean =>
    Object.entries(filter).every(([field, expected]) => {
      const held = row[field];
      if (expected !== null && typeof expected === 'object') {
        const below = (expected as { $lt?: unknown }).$lt;
        return typeof below === 'number' && typeof held === 'number' && held < below;
      }
      return Array.isArray(held) ? held.includes(expected) : held === expected;
    });

  const apply = (row: Document, update: Document): Document => {
    const next: Record<string, unknown> = { ...row, ...((update['$set'] ?? {}) as Document) };
    for (const field of Object.keys((update['$unset'] ?? {}) as Document)) delete next[field];
    for (const [field, value] of Object.entries((update['$pull'] ?? {}) as Document)) {
      next[field] = ((next[field] ?? []) as unknown[]).filter((held) => held !== value);
    }
    return next;
  };

  const collection: TotpCollection = {
    findOne: async (filter) => {
      const row = rows.get(idOf(filter));
      return row !== undefined && matches(row, filter) ? row : null;
    },
    findOneAndUpdate: async (filter, update, options) => {
      state.beforeWrite?.();
      const id = idOf(filter);
      const row = rows.get(id);
      if (row !== undefined && matches(row, filter)) {
        const next = apply(row, update);
        rows.set(id, next);
        return next;
      }
      if (!options.upsert) return null;
      // An upsert whose filter matched nothing inserts, and inserting over a document that is already
      // there is the duplicate key the identifier's own index answers with. That is the whole of "a proved
      // second factor is never replaced": the database refuses it, and no read decides it.
      if (row !== undefined) throw duplicateKey();
      const opened = apply({ _id: id }, update);
      rows.set(id, opened);
      return opened;
    },
    deleteOne: async (filter) => {
      state.beforeWrite?.();
      return { deletedCount: rows.delete(idOf(filter)) ? 1 : 0 };
    },
    createIndex: async () => 'created',
    dropIndex: async () => undefined,
  };

  return {
    rows,
    names,
    set beforeWrite(hook: (() => void) | undefined) {
      state.beforeWrite = hook;
    },
    get beforeWrite(): (() => void) | undefined {
      return state.beforeWrite;
    },
    db: {
      collection: (name) => {
        names.push(name);
        return collection;
      },
    },
  };
};
