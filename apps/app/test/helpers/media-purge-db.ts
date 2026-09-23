import type { FakeDb } from './fake-db.js';
import type { MediaPurgeDb } from '../../src/media.js';

/** Deletes matching rows out of a `fakeDb()`'s own backing store, so a purge test can assert rows
 *  are physically gone rather than merely trusting a call was made — the same relationship
 *  `fakeMediaStorageIO` has to `write`/`read`, extended to the one collection `purgeArchived`
 *  physically deletes from. Equality-only filter matching is enough: `purgeArchived` only ever
 *  calls `deleteMany({ assetId })`. */
export function fakeMediaPurgeDb(db: FakeDb): MediaPurgeDb {
  return {
    collection: (name) => ({
      async deleteMany(filter: Readonly<Record<string, unknown>>) {
        const stored = db.rows.get(name) ?? [];
        const remaining = stored.filter(
          (row) => !Object.entries(filter).every(([field, value]) => row[field] === value),
        );
        db.rows.set(name, remaining);
        return { deletedCount: stored.length - remaining.length };
      },
    }),
  };
}
