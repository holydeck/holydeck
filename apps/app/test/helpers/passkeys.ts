// The two collections a passkey lives in, in memory. Shared by the store's own suite and by the routes',
// because a route proving what a spent challenge is refused by needs the store that spends it.

import type { Document, Filter, ReadOptions } from '../../src/repositories.js';
import type { PasskeyCollection, PasskeyDb } from '../../src/passkeys.js';

const duplicateKey = (): Error => Object.assign(new Error('E11000 duplicate key'), { code: 11_000 });

const matches = (row: Document, filter: Filter): boolean =>
  Object.entries(filter).every(([field, expected]) => row[field] === expected);

const sorted = (rows: Document[], options: ReadOptions | undefined): Document[] => {
  const sort = options?.sort;
  if (sort === undefined) return rows;
  const [field, direction] = Object.entries(sort)[0] ?? ['_id', 1];
  return [...rows].sort((left, right) => (String(left[field]) < String(right[field]) ? -1 : 1) * direction);
};

/**
 * Enough of a Mongo collection to answer the operators the store actually sends: an insert that refuses a
 * second document under one identifier, a sorted read, a count, a delete that answers whether it deleted,
 * and the find-and-delete that is how a challenge is answered exactly once. The integration suite runs the
 * same store against a real MongoDB, which is where those operators are proved rather than imitated.
 */
export const memoryPasskeys = (): {
  rows: Map<string, Map<string, Document>>;
  db: PasskeyDb;
  names: string[];
  beforeWrite?: () => void;
} => {
  const rows = new Map<string, Map<string, Document>>();
  const names: string[] = [];
  const state: { beforeWrite?: () => void } = {};

  const collectionFor = (name: string): PasskeyCollection => {
    const held = rows.get(name) ?? new Map<string, Document>();
    rows.set(name, held);
    const all = (filter: Filter): Document[] => [...held.values()].filter((row) => matches(row, filter));
    return {
      findOne: async (filter) => all(filter)[0] ?? null,
      find: (filter, options) => ({ toArray: async () => sorted(all(filter), options) }),
      countDocuments: async (filter) => all(filter).length,
      insertOne: async (document) => {
        state.beforeWrite?.();
        const id = String(document['_id']);
        if (held.has(id)) throw duplicateKey();
        held.set(id, document);
        return { insertedId: id };
      },
      findOneAndDelete: async (filter) => {
        state.beforeWrite?.();
        const row = all(filter)[0];
        if (row === undefined) return null;
        held.delete(String(row['_id']));
        return row;
      },
      updateOne: async (filter, update) => {
        state.beforeWrite?.();
        const row = all(filter)[0];
        if (row === undefined) return { matchedCount: 0 };
        held.set(String(row['_id']), { ...row, ...((update['$set'] ?? {}) as Document) });
        return { matchedCount: 1 };
      },
      deleteOne: async (filter) => {
        state.beforeWrite?.();
        const row = all(filter)[0];
        if (row === undefined) return { deletedCount: 0 };
        held.delete(String(row['_id']));
        return { deletedCount: 1 };
      },
      createIndex: async () => 'created',
      dropIndex: async () => undefined,
    };
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
        return collectionFor(name);
      },
    },
  };
};
