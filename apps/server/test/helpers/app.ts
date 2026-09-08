import { Fetcher } from '@holydeck/core/fetcher';
import { MongoStore } from '../../src/mongo-store.js';
import { SyncJobManager } from '../../src/jobs.js';
import { buildApp } from '../../src/app.js';
import { chapterHtml, versionPayload } from './scrape.js';
import { startTestMongo } from './mongo.js';
import type { Db } from 'mongodb';
import type { FastifyInstance } from 'fastify';
import type { syncTranslation } from '@holydeck/core/sync';

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  store: MongoStore;
  jobs: SyncJobManager;
  urls: string[];
  stop: () => Promise<void>;
  stopMongo: () => Promise<void>;
}

function defaultScrape(url: string): string {
  if (url.includes('/api/bible/version/')) return versionPayload();
  return chapterHtml('PSA', '117', { '1': 'Praise verse one.', '2': 'Praise verse two.' });
}

export async function buildTestApp(
  options: {
    scrape?: (url: string) => string;
    runSync?: typeof syncTranslation;
    lockTimeoutMs?: number;
    concurrency?: number;
    delayMs?: number;
  } = {},
): Promise<TestApp> {
  const mongo = await startTestMongo();
  const urls: string[] = [];
  const scrape = options.scrape ?? defaultScrape;
  const fetcher = new Fetcher({
    httpGet: async (url: string) => {
      urls.push(url);
      return { status: 200, body: scrape(url) };
    },
    retries: 0,
    backoffMs: 1,
    sleep: async () => {},
  });
  let tick = 0;
  const store = new MongoStore(mongo.db, {
    now: () => `2026-09-08T12:00:${String((tick += 1) % 60).padStart(2, '0')}.000Z`,
    lockTimeoutMs: options.lockTimeoutMs,
  });
  const jobs = new SyncJobManager(store, fetcher, mongo.db, {
    concurrency: options.concurrency ?? 1,
    delayMs: options.delayMs ?? 0,
    now: store.now,
    runSync: options.runSync,
  });
  const app = buildApp({ store, fetcher, jobs, version: '0.0.0-test' });
  return {
    app,
    db: mongo.db,
    store,
    jobs,
    urls,
    stop: async () => {
      await app.close();
      await mongo.stop();
    },
    stopMongo: mongo.stop,
  };
}
