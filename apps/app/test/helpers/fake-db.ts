import type { Document, Filter, ReadOptions, RepositoryCollection, RepositoryDb } from '../../src/repositories.js';

export interface FakeDb extends RepositoryDb {
  readonly rows: Map<string, Document[]>;
  readonly indexes: Map<string, string[]>;
  /** Set to make the next write fail, which is how a migration is made to fail mid-flight. */
  failOn?: (collection: string, document: Document) => Error | undefined;
}

const matches = (document: Document, filter: Filter): boolean =>
  Object.entries(filter).every(([field, value]) => document[field] === value);

/** Enough of a Mongo database to replay a ledger: unique `_id`, equality filters, named indexes. */
export function fakeDb(): FakeDb {
  const rows = new Map<string, Document[]>();
  const indexes = new Map<string, string[]>();
  const db: FakeDb = {
    rows,
    indexes,
    collection(name: string): RepositoryCollection {
      const stored = rows.get(name) ?? [];
      rows.set(name, stored);
      const named = indexes.get(name) ?? [];
      indexes.set(name, named);
      return {
        async insertOne(document: Document) {
          const failure = db.failOn?.(name, document);
          if (failure !== undefined) throw failure;
          const id = document['_id'];
          if (id !== undefined && stored.some((row) => row['_id'] === id)) {
            throw Object.assign(new Error(`E11000 duplicate key: ${String(id)}`), { code: 11_000 });
          }
          const row = { _id: id ?? `generated-${stored.length + 1}`, ...document };
          stored.push(row);
          return { insertedId: row['_id'] };
        },
        find(filter: Filter, options: ReadOptions = {}) {
          const found = stored.filter((row) => matches(row, filter));
          const sort = options.sort;
          if (sort !== undefined) {
            const [[field, direction]] = Object.entries(sort) as [[string, 1 | -1]];
            found.sort((left, right) => (Number(left[field]) - Number(right[field])) * direction);
          }
          return { toArray: async () => (options.limit === undefined ? found : found.slice(0, options.limit)) };
        },
        async countDocuments(filter: Filter) {
          return stored.filter((row) => matches(row, filter)).length;
        },
        async createIndex(_keys, options = {}) {
          const index = String(options['name'] ?? 'unnamed');
          named.push(index);
          return index;
        },
        async dropIndex(index: string) {
          const at = named.indexOf(index);
          // Answered the way the driver answers it — code 27, `IndexNotFound` — rather than as a schema
          // complaint of our own, so a caller that forgives this one code is exercised for what it forgives.
          if (at < 0) {
            throw Object.assign(new Error(`index not found with name [${index}]`), {
              code: 27,
              codeName: 'IndexNotFound',
            });
          }
          named.splice(at, 1);
        },
      };
    },
  };
  return db;
}
