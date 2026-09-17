import type { PresenceCollection, PresenceDb } from '../../src/presence.js';
import type { Document, Filter, ReadOptions } from '../../src/repositories.js';

/** An in-memory `PresenceDb`, for a store test with no database to hold an entry in. */
export const memoryPresence = (): {
  readonly rows: Map<string, Document>;
  readonly db: PresenceDb;
  readonly names: string[];
  readonly indexes: string[];
} => {
  const rows = new Map<string, Document>();
  const names: string[] = [];
  const indexes: string[] = [];

  // The only three shapes presence asks of a filter: one entry by its key, everyone on one content, and
  // whether an entry has run out. Anything else is a query this double should not be quietly answering.
  const matches = (row: Document, filter: Filter): boolean =>
    Object.entries(filter).every(([field, wanted]) => {
      if (field === 'expiresAt' && typeof wanted === 'object' && wanted !== null) {
        return String(row['expiresAt']) > String((wanted as { readonly $gt: string }).$gt);
      }
      return row[field] === wanted;
    });

  const collection: PresenceCollection = {
    findOne: async (filter) => [...rows.values()].find((row) => matches(row, filter)) ?? null,
    findOneAndUpdate: async (filter, update, options) => {
      const id = String(filter['_id']);
      const set = (update as { readonly $set: Document })['$set'];
      const document = { _id: id, ...(options.upsert ? {} : (rows.get(id) ?? {})), ...set };
      rows.set(id, document);
      return document;
    },
    find: (filter, options: ReadOptions = {}) => {
      const found = [...rows.values()].filter((row) => matches(row, filter));
      const sort = options.sort;
      if (sort !== undefined) {
        const [[field, direction]] = Object.entries(sort) as [[string, 1 | -1]];
        found.sort((left, right) => String(left[field]).localeCompare(String(right[field])) * direction);
      }
      return { toArray: async () => found };
    },
    deleteOne: async (filter) => ({ deletedCount: rows.delete(String(filter['_id'])) ? 1 : 0 }),
    createIndex: async (_keys, options = {}) => {
      const index = String(options['name'] ?? 'unnamed');
      indexes.push(index);
      return index;
    },
    dropIndex: async (index) => {
      indexes.splice(indexes.indexOf(index), 1);
    },
  };

  return {
    rows,
    names,
    indexes,
    db: {
      collection: (name) => {
        names.push(name);
        return collection;
      },
    },
  };
};
