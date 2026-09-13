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

  const matches = (row: Document, filter: Filter): boolean =>
    Object.entries(filter).every(([field, wanted]) => {
      if (field === 'tickets.hash') {
        const tickets = (row['tickets'] ?? []) as readonly { hash: string }[];
        return tickets.some((ticket) => ticket.hash === wanted);
      }
      return row[field] === wanted;
    });

  const found = (filter: Filter): Document | undefined =>
    [...rows.values()].find((row) => matches(row, filter));

  const apply = (row: Document, update: Document): Document => {
    const next = { ...row };
    const set = update['$set'] as Document | undefined;
    if (set !== undefined) Object.assign(next, set);
    const pull = update['$pull'] as { tickets: { hash: string } } | undefined;
    if (pull !== undefined) {
      const tickets = (next['tickets'] ?? []) as readonly { hash: string }[];
      next['tickets'] = tickets.filter((ticket) => ticket.hash !== pull.tickets.hash);
    }
    const push = update['$push'] as { tickets: { $each: unknown[]; $slice: number } } | undefined;
    if (push !== undefined) {
      const tickets = [...((next['tickets'] ?? []) as unknown[]), ...push.tickets.$each];
      next['tickets'] = tickets.slice(push.tickets.$slice);
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

