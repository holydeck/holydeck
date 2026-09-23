// Where the scheduler keeps the one fact each of its three jobs needs before it enqueues again: when it
// last finished. A single document, not a `Repository` — this is operational bookkeeping with no history
// to keep (ADR 0009), the same reasoning `queue.ts`'s own `QueueDb` and `translation-offsets.ts`'s store
// are precedent for.
//
// Nothing here decides whether a job is due: `apps/app/src/schedule.ts`'s `dueJobs` reads what `read()`
// returns and answers that question on its own, pure and never touching Mongo. This store only remembers
// what a job handler reported once it actually finished — the scheduler that reads it never writes here
// itself.

import type { Db } from 'mongodb';
import type { Document, Filter } from '@holydeck/app/repositories';

export const SCHEDULER_STATE_COLLECTION = 'scheduler_state';

const DOC_ID = 'scheduler';

export interface SchedulerState {
  readonly lastBackupAt?: string;
  readonly lastRestoreRehearsalAt?: string;
  readonly lastRetentionSweepAt?: string;
}

/** The slice of a Mongo collection this store uses. Narrow on purpose: a test can supply all of it. */
export interface SchedulerStateCollection {
  findOne(filter: Filter): Promise<Document | null>;
  findOneAndUpdate(
    filter: Filter,
    update: Document,
    options: { readonly upsert: true; readonly returnDocument: 'after' },
  ): Promise<Document>;
}

export interface SchedulerStateDb {
  collection(name: string): SchedulerStateCollection;
}

export interface SchedulerStateStore {
  /** An all-undefined state for a deployment that has never finished any of the three jobs. */
  read(): Promise<SchedulerState>;
  markBackup(at: string): Promise<void>;
  markRestoreRehearsal(at: string): Promise<void>;
  markRetentionSweep(at: string): Promise<void>;
}

const stateFrom = (document: Document | null): SchedulerState =>
  Object.freeze({
    lastBackupAt: document?.['lastBackupAt'] as string | undefined,
    lastRestoreRehearsalAt: document?.['lastRestoreRehearsalAt'] as string | undefined,
    lastRetentionSweepAt: document?.['lastRetentionSweepAt'] as string | undefined,
  });

/** The store over one database. Nothing here reads an ambient clock, database or current user. */
export function schedulerStateOn(db: SchedulerStateDb): SchedulerStateStore {
  const rows = (): SchedulerStateCollection => db.collection(SCHEDULER_STATE_COLLECTION);

  const mark =
    (field: keyof SchedulerState) =>
    async (at: string): Promise<void> => {
      await rows().findOneAndUpdate({ _id: DOC_ID }, { $set: { [field]: at } }, { upsert: true, returnDocument: 'after' });
    };

  return Object.freeze({
    async read() {
      return stateFrom(await rows().findOne({ _id: DOC_ID }));
    },
    markBackup: mark('lastBackupAt'),
    markRestoreRehearsal: mark('lastRestoreRehearsalAt'),
    markRetentionSweep: mark('lastRetentionSweepAt'),
  });
}

/**
 * The driver satisfies this interface in practice; the cast is about the document types the driver
 * reports.
 */
export function schedulerStateDb(db: Db): SchedulerStateDb {
  return { collection: (name) => db.collection(name) as unknown as SchedulerStateCollection };
}
