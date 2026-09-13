import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Fetcher } from '@holydeck/core/fetcher';
import { HolyDeckError } from '@holydeck/core/messages';
import { MongoStore } from './mongo-store.js';
import { SyncJobManager } from './jobs.js';
import { startTestMongo } from '../test/helpers/mongo.js';
import type { SyncOptions, SyncReport, SyncStore } from '@holydeck/core/sync';
import type { TestMongo } from '../test/helpers/mongo.js';

type RunSync = (store: SyncStore, fetcher: Fetcher, abbr: string, options?: SyncOptions) => Promise<SyncReport>;

const baseReport: SyncReport = {
  translation: 'KJV',
  planned: 2,
  fetched: 2,
  unchanged: 1,
  newRevisions: [{ book: 'GEN', chapter: '1', rev: 1 }],
  failed: [],
  dryRun: false,
};

let mongo: TestMongo;
let store: MongoStore;
let fetcher: Fetcher;
let tick = 0;

function makeManager(runSync: RunSync): SyncJobManager {
  return new SyncJobManager(store, fetcher, mongo.db, {
    concurrency: 1,
    delayMs: 0,
    now: () => `2026-09-08T11:00:${String((tick += 1) % 60).padStart(2, '0')}.000Z`,
    runSync,
  });
}

beforeAll(async () => {
  mongo = await startTestMongo();
  fetcher = new Fetcher({ retries: 0, backoffMs: 1, sleep: async () => {} });
});

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.dropDatabase();
  tick = 0;
  store = new MongoStore(mongo.db);
});

describe('start/status lifecycle', () => {
  it('runs a job to completion, reports progress, and persists the final status', async () => {
    const manager = makeManager(async (_store, _fetcher, _abbr, options) => {
      options?.onProgress?.(1, 2, { book: 'GEN', chapter: '1', reason: 'missing' });
      return { ...baseReport, metadataBuildChanged: { from: 50, to: 51 } };
    });
    const started = manager.start('kjv', false);
    expect(started).toMatchObject({ translation: 'KJV', state: 'running', refresh: false });
    await manager.onIdle();
    const status = await manager.status('KJV');
    expect(status).toMatchObject({
      state: 'completed',
      progress: { done: 2, total: 2 },
      report: {
        planned: 2,
        fetched: 2,
        unchanged: 1,
        newRevisions: 1,
        failed: [],
        metadataBuildChanged: { from: 50, to: 51 },
      },
    });
    expect(status?.finishedAt).toBeDefined();
    const second = makeManager(async () => baseReport);
    const persisted = await second.status('KJV');
    expect(persisted?.state).toBe('completed');
    expect(persisted).not.toHaveProperty('_id');
  });

  it('exposes progress while the job is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = makeManager(async (_store, _fetcher, _abbr, options) => {
      options?.onProgress?.(1, 2, { book: 'GEN', chapter: '1', reason: 'missing' });
      await gate;
      return baseReport;
    });
    manager.start('KJV', false);
    await new Promise((resolve) => setImmediate(resolve));
    const running = await manager.status('KJV');
    expect(running).toMatchObject({ state: 'running', progress: { done: 1, total: 2 } });
    release();
    await manager.onIdle();
  });

  it('rejects a second start while a job is running, allows one after completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = makeManager(async () => {
      await gate;
      return baseReport;
    });
    manager.start('KJV', false);
    expect(() => manager.start('KJV', true)).toThrowError(HolyDeckError);
    try {
      manager.start('kjv', true);
    } catch (error) {
      expect(error).toMatchObject({ code: 'sync_already_running', params: { abbr: 'KJV' } });
    }
    release();
    await manager.onIdle();
    expect(manager.start('KJV', true)).toMatchObject({ state: 'running', refresh: true });
    await manager.onIdle();
  });

  it('throws unknown_translation for a bad abbreviation without creating a job', async () => {
    const manager = makeManager(async () => baseReport);
    expect(() => manager.start('ZZZ', false)).toThrowError(HolyDeckError);
    expect(await manager.status('ZZZ')).toBeUndefined();
  });

  it('records a HolyDeckError failure with its code and message', async () => {
    const manager = makeManager(async () => {
      throw new HolyDeckError('scrape_blocked', { abbr: 'KJV', book: 'GEN', chapter: '1' });
    });
    manager.start('KJV', false);
    await manager.onIdle();
    const status = await manager.status('KJV');
    expect(status?.state).toBe('failed');
    expect(status?.error?.code).toBe('scrape_blocked');
    expect(status?.error?.message).toContain('bot-protection');
  });

  it('wraps a non-HolyDeckError failure as internal_error', async () => {
    const manager = makeManager(async () => {
      throw new Error('boom');
    });
    manager.start('KJV', false);
    await manager.onIdle();
    const status = await manager.status('KJV');
    expect(status?.error).toEqual({ code: 'internal_error', message: 'Unexpected server error.' });
  });

  it('returns undefined when no job exists in memory or the database', async () => {
    const manager = makeManager(async () => baseReport);
    expect(await manager.status('NIV')).toBeUndefined();
  });
});

describe('recoverInterrupted', () => {
  it('marks persisted running jobs as failed with sync_interrupted, once', async () => {
    await mongo.db.collection('sync_jobs').insertOne({
      _id: 'KJV' as never,
      translation: 'KJV',
      state: 'running',
      refresh: false,
      startedAt: '2026-09-08T09:00:00.000Z',
      progress: { done: 3, total: 10 },
    });
    const manager = new SyncJobManager(store, fetcher, mongo.db, { concurrency: 1, delayMs: 0 });
    expect(await manager.recoverInterrupted()).toBe(1);
    const status = await manager.status('KJV');
    expect(status?.state).toBe('failed');
    expect(status?.error?.code).toBe('sync_interrupted');
    expect(status?.error?.message).toContain('interrupted by a server restart');
    expect(await manager.recoverInterrupted()).toBe(0);
  });
});

describe('persistence resilience', () => {
  it('completes the job in memory even when the status write fails', async () => {
    const dedicated = await startTestMongo();
    const dedicatedStore = new MongoStore(dedicated.db);
    const manager = new SyncJobManager(dedicatedStore, fetcher, dedicated.db, {
      concurrency: 1,
      delayMs: 0,
      runSync: async () => baseReport,
    });
    await dedicated.stop();
    manager.start('KJV', false);
    await manager.onIdle();
    const status = await manager.status('KJV');
    expect(status?.state).toBe('completed');
  });
});
