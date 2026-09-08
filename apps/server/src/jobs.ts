import { HolyDeckError } from '@holydeck/core/messages';
import { syncTranslation } from '@holydeck/core/sync';
import { translationId } from '@holydeck/core/translations';
import type { Fetcher } from '@holydeck/core/fetcher';
import type { SyncReport } from '@holydeck/core/sync';
import type { Collection, Db } from 'mongodb';
import type { MongoStore } from './mongo-store.js';

export interface SyncJobReport {
  planned: number;
  fetched: number;
  unchanged: number;
  newRevisions: number;
  failed: Array<{ book: string; chapter: string; code: string }>;
  metadataBuildChanged?: { from: number; to: number };
}

export interface SyncJobStatus {
  translation: string;
  state: 'running' | 'completed' | 'failed';
  refresh: boolean;
  startedAt: string;
  finishedAt?: string;
  progress: { done: number; total: number };
  report?: SyncJobReport;
  error?: { code: string; message: string };
}

export interface SyncJobManagerOptions {
  concurrency: number;
  delayMs: number;
  now?: () => string;
  runSync?: typeof syncTranslation;
}

interface SyncJobDoc extends SyncJobStatus {
  _id: string;
}

function toJobReport(report: SyncReport): SyncJobReport {
  const jobReport: SyncJobReport = {
    planned: report.planned,
    fetched: report.fetched,
    unchanged: report.unchanged,
    newRevisions: report.newRevisions.length,
    failed: report.failed,
  };
  if (report.metadataBuildChanged !== undefined) {
    jobReport.metadataBuildChanged = report.metadataBuildChanged;
  }
  return jobReport;
}

export class SyncJobManager {
  private readonly store: MongoStore;
  private readonly fetcher: Fetcher;
  private readonly collection: Collection<SyncJobDoc>;
  private readonly concurrency: number;
  private readonly delayMs: number;
  private readonly now: () => string;
  private readonly runSync: typeof syncTranslation;
  private readonly jobs = new Map<string, SyncJobStatus>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(store: MongoStore, fetcher: Fetcher, db: Db, options: SyncJobManagerOptions) {
    this.store = store;
    this.fetcher = fetcher;
    this.collection = db.collection<SyncJobDoc>('sync_jobs');
    this.concurrency = options.concurrency;
    this.delayMs = options.delayMs;
    this.now = options.now ?? (() => new Date().toISOString());
    this.runSync = options.runSync ?? syncTranslation;
  }

  start(abbr: string, refresh: boolean): SyncJobStatus {
    const upper = abbr.toUpperCase();
    translationId(upper);
    if (this.jobs.get(upper)?.state === 'running') {
      throw new HolyDeckError('sync_already_running', { abbr: upper });
    }
    const status: SyncJobStatus = {
      translation: upper,
      state: 'running',
      refresh,
      startedAt: this.now(),
      progress: { done: 0, total: 0 },
    };
    this.jobs.set(upper, status);
    this.pending.set(upper, this.execute(upper, status));
    return status;
  }

  async status(abbr: string): Promise<SyncJobStatus | undefined> {
    const upper = abbr.toUpperCase();
    const inMemory = this.jobs.get(upper);
    if (inMemory !== undefined) return inMemory;
    const doc = await this.collection.findOne({ _id: upper });
    if (doc === null) return undefined;
    const status: SyncJobStatus & { _id?: string } = { ...doc };
    delete status._id;
    return status;
  }

  async recoverInterrupted(): Promise<number> {
    const stale = await this.collection.find({ state: 'running' }).toArray();
    for (const doc of stale) {
      const error = new HolyDeckError('sync_interrupted', { abbr: doc.translation });
      await this.collection.updateOne(
        { _id: doc._id },
        { $set: { state: 'failed', finishedAt: this.now(), error: { code: error.code, message: error.message } } },
      );
    }
    return stale.length;
  }

  async onIdle(): Promise<void> {
    await Promise.all(this.pending.values());
  }

  private async execute(upper: string, status: SyncJobStatus): Promise<void> {
    const initialPersist = this.persist(upper, status);
    try {
      const report = await this.runSync(this.store, this.fetcher, upper, {
        refresh: status.refresh,
        concurrency: this.concurrency,
        delayMs: this.delayMs,
        onProgress: (done, total) => {
          status.progress = { done, total };
        },
      });
      status.state = 'completed';
      status.report = toJobReport(report);
      status.progress = { done: report.planned, total: report.planned };
    } catch (caught) {
      const error = caught instanceof HolyDeckError ? caught : new HolyDeckError('internal_error');
      status.state = 'failed';
      status.error = { code: error.code, message: error.message };
    }
    status.finishedAt = this.now();
    await initialPersist; // preserve write order: the running snapshot must land before the final one
    await this.persist(upper, status);
    this.pending.delete(upper);
  }

  private async persist(upper: string, status: SyncJobStatus): Promise<void> {
    try {
      await this.collection.replaceOne({ _id: upper }, status, { upsert: true });
    } catch {
      // Best effort: the in-memory map stays authoritative when Mongo is unreachable.
    }
  }
}
