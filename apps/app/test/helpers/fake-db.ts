import type { Document, Filter, ReadOptions, RepositoryCollection, RepositoryDb } from '../../src/repositories.js';

export interface FakeDb extends RepositoryDb {
  readonly rows: Map<string, Document[]>;
  readonly indexes: Map<string, string[]>;
  /** Set to make the next write fail, which is how a migration is made to fail mid-flight. */
  failOn?: (collection: string, document: Document) => Error | undefined;
}

// Ordered the way Mongo orders it: numbers by value, everything else lexicographically — which is exactly
// right for the ISO instants every `at` field in this codebase is stored as.
function compared(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  const [a, b] = [String(left), String(right)];
  return a < b ? -1 : a > b ? 1 : 0;
}

// A field's value in a filter is either the value itself or an operator object naming what it is compared
// against — `$eq`/`$gt`/`$gte`/`$lt`/`$lte`, the same handful `repositories.ts` lets a nested field carry
// through unvalidated. Every operator an object names must hold, the same as Mongo reads it.
function valueMatches(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) return actual === expected;
  return Object.entries(expected as Record<string, unknown>).every(([operator, operand]) => {
    switch (operator) {
      case '$eq':
        return actual === operand;
      case '$gt':
        return compared(actual, operand) > 0;
      case '$gte':
        return compared(actual, operand) >= 0;
      case '$lt':
        return compared(actual, operand) < 0;
      case '$lte':
        return compared(actual, operand) <= 0;
      default:
        return actual === operand;
    }
  });
}

// `$and`/`$nor`/`$or` nest, the same three `repositories.ts` validates and no others — a filter this fake
// answers is exactly a filter the real layer would have let through.
function matches(document: Document, filter: Filter): boolean {
  return Object.entries(filter).every(([key, value]) => {
    const clauses = value as readonly Filter[];
    if (key === '$and') return clauses.every((clause) => matches(document, clause));
    if (key === '$or') return clauses.some((clause) => matches(document, clause));
    if (key === '$nor') return !clauses.some((clause) => matches(document, clause));
    return valueMatches(document[key], value);
  });
}

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
            const keys = Object.entries(sort) as [string, 1 | -1][];
            found.sort((left, right) => {
              for (const [field, direction] of keys) {
                const compare = compared(left[field], right[field]) * direction;
                if (compare !== 0) return compare;
              }
              return 0;
            });
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
