import type { CapabilityCollection, CapabilityDb } from '../../src/capabilities.js';
import type { Document, Filter } from '../../src/repositories.js';

/** An in-memory `CapabilityDb`, for a store test that has no database to hold a token digest in. */
export const memoryCapabilities = (): {
  readonly rows: Map<string, Document>;
  readonly db: CapabilityDb;
  readonly names: string[];
} => {
  const rows = new Map<string, Document>();
  const names: string[] = [];

  const idOf = (filter: Filter): string => String(filter['_id']);

  const collection: CapabilityCollection = {
    insertOne: async (document) => {
      const id = idOf(document);
      rows.set(id, document);
      return { insertedId: id };
    },
    findOne: async (filter) => rows.get(idOf(filter)) ?? null,
    find: (filter) => {
      const found = [...rows.values()].filter((row) =>
        Object.entries(filter).every(([field, wanted]) => row[field] === wanted),
      );
      return { toArray: async () => found };
    },
    deleteOne: async (filter) => ({ deletedCount: rows.delete(idOf(filter)) ? 1 : 0 }),
    deleteMany: async () => {
      const count = rows.size;
      rows.clear();
      return { deletedCount: count };
    },
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
