import type { ShownReferenceCollection, ShownReferenceDb } from '../../src/shown-references.js';
import type { Document, Filter, ReadOptions } from '../../src/repositories.js';

/** An in-memory `ShownReferenceDb`, for a test with no database to keep a shown reference in. */
export const memoryShownReferences = (): {
  readonly rows: Document[];
  readonly db: ShownReferenceDb;
  readonly names: string[];
} => {
  const rows: Document[] = [];
  const names: string[] = [];

  const matches = (row: Document, filter: Filter): boolean =>
    Object.entries(filter).every(([field, wanted]) => row[field] === wanted);

  const collection: ShownReferenceCollection = {
    insertOne: async (document) => {
      rows.push(document);
      return { insertedId: document['_id'] };
    },
    find: (filter, options: ReadOptions = {}) => {
      const found = rows.filter((row) => matches(row, filter));
      const sort = options.sort;
      if (sort !== undefined) {
        const [[field, direction]] = Object.entries(sort) as [[string, 1 | -1]];
        found.sort((left, right) => String(left[field]).localeCompare(String(right[field])) * direction);
      }
      return { toArray: async () => (options.limit === undefined ? found : found.slice(0, options.limit)) };
    },
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
