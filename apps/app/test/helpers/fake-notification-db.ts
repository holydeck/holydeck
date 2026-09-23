import type { NotificationDb } from '../../src/notification-store.js';

type Document = Record<string, unknown>;

const matches = (row: Document, filter: Document): boolean =>
  Object.entries(filter).every(([key, value]) => {
    if (typeof value !== 'object' || value === null) return row[key] === value;
    const comparison = value as Document;
    if ('$exists' in comparison) return (row[key] !== undefined) === comparison['$exists'];
    if ('$lt' in comparison) return typeof row[key] === 'string' && row[key] < String(comparison['$lt']);
    if ('$lte' in comparison) return typeof row[key] === 'string' && row[key] <= String(comparison['$lte']);
    if ('$in' in comparison && Array.isArray(comparison['$in'])) return comparison['$in'].includes(row[key]);
    throw new Error('unsupported notification filter');
  });

export function fakeNotificationDb(): NotificationDb {
  const collections = new Map<string, Document[]>();
  return {
    collection(name) {
      const rows = collections.get(name) ?? [];
      collections.set(name, rows);
      const update = (filter: Document, change: Document, all: boolean): number => {
        const found = rows.filter((row) => matches(row, filter));
        const selected = all ? found : found.slice(0, 1);
        for (const row of selected) Object.assign(row, structuredClone(change['$set']));
        return selected.length;
      };
      const remove = (filter: Document, all: boolean): number => {
        let count = 0;
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (!matches(rows[index] as Document, filter)) continue;
          rows.splice(index, 1);
          count += 1;
          if (!all) break;
        }
        return count;
      };
      return {
        findOne: async (filter) => structuredClone(rows.find((row) => matches(row, filter)) ?? null),
        find(filter, options = {}) {
          const found = rows.filter((row) => matches(row, filter));
          for (const [key, direction] of Object.entries(options.sort ?? {})) {
            found.sort((a, b) => (a[key] === b[key] ? 0 : String(a[key]) < String(b[key]) ? -1 : 1) * direction);
          }
          return { toArray: async () => structuredClone(found.slice(0, options.limit)) };
        },
        countDocuments: async (filter) => rows.filter((row) => matches(row, filter)).length,
        async insertOne(document) {
          rows.push(structuredClone(document));
          return { insertedId: document['_id'] };
        },
        async findOneAndUpdate(filter, change, options) {
          let row = rows.find((candidate) => matches(candidate, filter));
          if (row === undefined && options.upsert) {
            row = { ...filter, ...structuredClone(change['$setOnInsert'] as Document) };
            rows.push(row);
          }
          if (row === undefined) return null;
          Object.assign(row, structuredClone(change['$set']));
          return structuredClone(row);
        },
        updateOne: async (filter, change) => ({ matchedCount: update(filter, change, false) }),
        updateMany: async (filter, change) => ({ matchedCount: update(filter, change, true) }),
        deleteOne: async (filter) => ({ deletedCount: remove(filter, false) }),
        deleteMany: async (filter) => ({ deletedCount: remove(filter, true) }),
        createIndex: async () => '',
        dropIndex: async () => {},
      };
    },
  };
}
