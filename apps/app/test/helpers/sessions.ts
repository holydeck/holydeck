// The session store's collection, in memory. Shared by the store's own suite and by the guard's, because
// a guard proving what it refuses needs sessions to refuse them against, not a second stub of a store.

import type { Document, Filter } from '../../src/repositories.js';
import type { SessionCollection, SessionDb } from '../../src/sessions.js';

/**
 * An in-memory collection that keeps only the operations the store performs, and keeps them the way the
 * database does: a replayed identifier is refused, and pulling a ticket either finds one or finds none.
 * The integration suite runs the same store against a real MongoDB, which is where the operators are
 * proved; here they are enough to say what the store asks for and what it does with the answer.
 */
export const memorySessions = (): { rows: Map<string, Document>; db: SessionDb; names: string[] } => {
  const rows = new Map<string, Document>();
  const names: string[] = [];

  /** A dotted path, read off an array field: `slots.actor` reads `actor` from every entry of `slots`. */
  const arrayField = (row: Document, path: string): { readonly array: readonly Document[]; readonly key: string } | undefined => {
    const at = path.indexOf('.');
    if (at === -1) return undefined;
    const array = row[path.slice(0, at)];
    return Array.isArray(array) ? { array: array as readonly Document[], key: path.slice(at + 1) } : undefined;
  };

  const matches = (row: Document, filter: Filter): boolean =>
    Object.entries(filter).every(([field, wanted]) => {
      if (wanted !== null && typeof wanted === 'object' && '$size' in (wanted as Document)) {
        const value = row[field];
        return Array.isArray(value) && value.length === (wanted as Document)['$size'];
      }
      const nested = arrayField(row, field);
      if (nested !== undefined) return nested.array.some((entry) => entry[nested.key] === wanted);
      return row[field] === wanted;
    });

  const found = (filter: Filter): Document | undefined =>
    [...rows.values()].find((row) => matches(row, filter));

  const apply = (row: Document, update: Document): Document => {
    const next = { ...row };
    const set = update['$set'] as Document | undefined;
    if (set !== undefined) Object.assign(next, set);
    const pull = update['$pull'] as Document | undefined;
    if (pull !== undefined) {
      for (const [field, condition] of Object.entries(pull)) {
        const current = (next[field] ?? []) as readonly Document[];
        next[field] = current.filter(
          (entry) => !Object.entries(condition as Document).every(([key, wanted]) => entry[key] === wanted),
        );
      }
    }
    const push = update['$push'] as Document | undefined;
    if (push !== undefined) {
      for (const [field, spec] of Object.entries(push)) {
        const shaped = spec as { $each: unknown[]; $slice?: number };
        const current = [...((next[field] ?? []) as unknown[]), ...shaped.$each];
        next[field] = shaped.$slice === undefined ? current : current.slice(shaped.$slice);
      }
    }
    rows.set(String(next['_id']), next);
    return next;
  };

  const collection: SessionCollection = {
    insertOne: async (document) => {
      const id = String(document['_id']);
      if (rows.has(id)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11_000 });
      rows.set(id, { ...document });
      return { insertedId: id };
    },
    findOne: async (filter) => found(filter) ?? null,
    findOneAndUpdate: async (filter, update, options) => {
      const row = found(filter);
      if (row === undefined) return null;
      const before = { ...row };
      const after = apply(row, update);
      return options.returnDocument === 'before' ? before : after;
    },
    updateOne: async (filter, update) => {
      const row = found(filter);
      if (row === undefined) return { matchedCount: 0 };
      apply(row, update);
      return { matchedCount: 1 };
    },
    updateMany: async (filter, update) => {
      const matched = [...rows.values()].filter((row) => matches(row, filter));
      for (const row of matched) apply(row, update);
      return { modifiedCount: matched.length };
    },
    deleteOne: async (filter) => {
      const row = found(filter);
      if (row === undefined) return { deletedCount: 0 };
      rows.delete(String(row['_id']));
      return { deletedCount: 1 };
    },
    deleteMany: async (filter) => {
      const gone = [...rows.values()].filter((row) => matches(row, filter));
      for (const row of gone) rows.delete(String(row['_id']));
      return { deletedCount: gone.length };
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
