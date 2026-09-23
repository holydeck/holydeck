// A single-document record of the last media storage-root migration (OPS-16).
//
// Modeled directly on `maintenance.ts`: operational bookkeeping, not a durable record, so it is kept
// outside the repositories in `records.ts` the same way and for the same reason (ADR 0009 — that layer has
// no update verb, and this is nothing but an update). The worker writes the completion record right after
// switching `mediaRoot`, before releasing the maintenance lease it held for the copy; the cleanup route
// reads it back to decide whether there is anything left at the old root worth removing.

import type { Db } from 'mongodb';

import type { Document, Filter } from './repositories.js';

export const MEDIA_MIGRATION_STATE_COLLECTION = 'media_migration_state';
const DOC_ID = 'media-migration';

export interface MediaMigrationRecord {
  readonly fromRoot: string;
  readonly toRoot: string;
  readonly completedAt: string;
  readonly cleanedUpAt?: string;
}

/** The slice of a Mongo collection this store uses. Narrow on purpose: a test can supply all of it. */
export interface MediaMigrationStateCollection {
  findOne(filter: Filter): Promise<Document | null>;
  findOneAndUpdate(
    filter: Filter,
    update: Document,
    options: { readonly upsert: true; readonly returnDocument: 'after' },
  ): Promise<Document>;
}

export interface MediaMigrationStateDb {
  collection(name: string): MediaMigrationStateCollection;
}

export interface MediaMigrationStateStore {
  read(): Promise<MediaMigrationRecord | undefined>;
  recordCompletion(record: MediaMigrationRecord): Promise<void>;
  recordCleanup(at: string): Promise<void>;
}

const recordFrom = (found: Document): MediaMigrationRecord => ({
  fromRoot: String(found['fromRoot'] ?? ''),
  toRoot: String(found['toRoot'] ?? ''),
  completedAt: String(found['completedAt'] ?? ''),
  ...(typeof found['cleanedUpAt'] === 'string' ? { cleanedUpAt: found['cleanedUpAt'] } : {}),
});

export function mediaMigrationStateOn(db: MediaMigrationStateDb): MediaMigrationStateStore {
  const doc = (): MediaMigrationStateCollection => db.collection(MEDIA_MIGRATION_STATE_COLLECTION);
  const store: MediaMigrationStateStore = {
    async read() {
      const found = await doc().findOne({ _id: DOC_ID });
      return found === null ? undefined : recordFrom(found);
    },
    async recordCompletion(record) {
      await doc().findOneAndUpdate(
        { _id: DOC_ID },
        { $set: { fromRoot: record.fromRoot, toRoot: record.toRoot, completedAt: record.completedAt }, $unset: { cleanedUpAt: '' } },
        { upsert: true, returnDocument: 'after' },
      );
    },
    async recordCleanup(at) {
      await doc().findOneAndUpdate(
        { _id: DOC_ID },
        { $set: { cleanedUpAt: at } },
        { upsert: true, returnDocument: 'after' },
      );
    },
  };
  return Object.freeze(store);
}

export function mediaMigrationStateDb(db: Db): MediaMigrationStateDb {
  return { collection: (name) => db.collection(name) as unknown as MediaMigrationStateCollection };
}
