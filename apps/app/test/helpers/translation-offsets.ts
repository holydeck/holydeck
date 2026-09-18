import type { TranslationOffsetCollection, TranslationOffsetDb } from '../../src/translation-offsets.js';
import type { Document, Filter } from '../../src/repositories.js';

/** An in-memory `TranslationOffsetDb`, for a store test that has no database to hold an offset in. */
export const memoryTranslationOffsets = (): {
  readonly rows: Map<string, Document>;
  readonly db: TranslationOffsetDb;
} => {
  const rows = new Map<string, Document>();

  const idOf = (filter: Filter): string => String(filter['_id']);

  const collection: TranslationOffsetCollection = {
    findOne: async (filter) => rows.get(idOf(filter)) ?? null,
    find: () => ({ toArray: async () => [...rows.values()] }),
    findOneAndUpdate: async (filter, update) => {
      const id = idOf(filter);
      const patch = (update as { readonly $set?: Document })['$set'] ?? {};
      const next = { ...(rows.get(id) ?? {}), ...patch, _id: id };
      rows.set(id, next);
      return next;
    },
  };

  return { rows, db: { collection: () => collection } };
};
