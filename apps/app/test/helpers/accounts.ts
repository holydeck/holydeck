// The account store's collection, in memory. It keeps the three uniqueness rules the store's indexes ask
// the database for, because a store whose one promise is "there is exactly one founder" proves nothing
// against a collection that lets a second one in. The integration suite runs the same store against a real
// MongoDB, which is where those indexes are actually built.

import { ACCOUNTS_COLLECTION } from '../../src/accounts.js';

import type { AccountCollection, AccountDb } from '../../src/accounts.js';
import type { Document, Filter } from '../../src/repositories.js';

const duplicate = (field: string): Error =>
  Object.assign(new Error(`E11000 duplicate key: ${field}`), { code: 11_000 });

export const memoryAccounts = (): { rows: Map<string, Document>; db: AccountDb; names: string[] } => {
  const rows = new Map<string, Document>();
  const names: string[] = [];

  const matches = (row: Document, filter: Filter): boolean =>
    Object.entries(filter).every(([field, wanted]) => row[field] === wanted);

  const collection: AccountCollection = {
    insertOne: async (document) => {
      const id = String(document['_id']);
      if (rows.has(id)) throw duplicate('_id');
      for (const row of rows.values()) {
        if (row['name'] === document['name']) throw duplicate('name');
        if (row['founder'] === true && document['founder'] === true) throw duplicate('founder');
      }
      rows.set(id, { ...document });
      return { insertedId: id };
    },
    findOne: async (filter) => [...rows.values()].find((row) => matches(row, filter)) ?? null,
    countDocuments: async (filter) => [...rows.values()].filter((row) => matches(row, filter)).length,
    updateOne: async (filter, update) => {
      const row = [...rows.values()].find((candidate) => matches(candidate, filter));
      if (row === undefined) return { matchedCount: 0 };
      const set = update['$set'] as Document | undefined;
      if (set !== undefined) rows.set(String(row['_id']), { ...row, ...set });
      return { matchedCount: 1 };
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

export const storedAccounts = (rows: Map<string, Document>): Document[] => [...rows.values()];

export const ACCOUNTS = ACCOUNTS_COLLECTION;
