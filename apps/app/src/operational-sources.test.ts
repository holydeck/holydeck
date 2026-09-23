import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, test } from 'vitest';

import { requestContext } from './context.js';
import { BACKUP_RECORD } from './backups.js';
import { LIBRARY_UNAVAILABLE } from './corpus.js';
import { operationalSourcesOn } from './operational-sources.js';
import { QUEUE_PERMISSIONS } from './queue.js';
import { permissionsFor } from './records.js';
import { RESTORE_RECORD } from './restores.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { JobRecord, JobState } from '@holydeck/contracts/jobs';
import type { MediaManifestEntry } from '@holydeck/contracts/media';
import type { corpusClient } from './corpus.js';
import type { Queue } from './queue.js';
import type { MediaLibrary, MediaPurgeItem, MediaRecord } from './media.js';
import type { MongoHealthDb, OperationalSourcesOptions } from './operational-sources.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const NOW = '2026-09-21T23:30:00.000Z';
const ADMINISTRATOR = 'account:' + 'C'.repeat(22);
const CORRELATION = 'req-0f9c2a41';
const now = (): string => NOW;

const context = requestContext({
  actor: ADMINISTRATOR,
  correlationId: CORRELATION,
  permissions: [
    QUEUE_PERMISSIONS.read,
    permissionsFor(BACKUP_RECORD).read,
    permissionsFor(RESTORE_RECORD).read,
  ],
});

const job = (overrides: Partial<JobRecord> & { readonly id: string; readonly queuedAt: string }): JobRecord => ({
  kind: 'backup-run',
  idempotencyKey: `key:${overrides.id}`,
  payload: {},
  state: 'queued',
  attempt: 1,
  retryLimit: 5,
  workers: [],
  leaseExpiresAt: undefined,
  heartbeatAt: undefined,
  lastError: undefined,
  ...overrides,
} as JobRecord);

const fakeQueue = (jobs: readonly JobRecord[]): Pick<Queue, 'summary' | 'list'> => ({
  async summary() {
    const states: readonly JobState[] = ['queued', 'leased', 'succeeded', 'failed'];
    return Object.freeze(Object.fromEntries(
      states.map((state) => [state, jobs.filter((entry) => entry.state === state).length]),
    )) as Readonly<Record<JobState, number>>;
  },
  async list() {
    return jobs;
  },
});

const fakeMedia = (
  entries: readonly MediaManifestEntry[],
  purgeReport: Pick<MediaLibrary, 'purgeReport'>['purgeReport'] = async () => ({ items: [] }),
): Pick<MediaLibrary, 'list' | 'purgeReport'> => ({
  async list() {
    return entries.map((manifest) => ({ stamp: { sequence: 1 }, manifest, storageKey: manifest.id }) as unknown as MediaRecord);
  },
  purgeReport,
});

const fakeMongoDb = (overrides: Partial<MongoHealthDb> = {}): MongoHealthDb => ({
  command: async () => ({ ok: 1 }),
  stats: async () => ({ storageSize: 1_000_000 }),
  ...overrides,
});

const fakeCorpus = (
  overrides: Partial<Pick<ReturnType<typeof corpusClient>, 'translations'>> = {},
): Pick<ReturnType<typeof corpusClient>, 'translations'> => ({
  translations: async () => ({ ok: true, value: [] }),
  ...overrides,
});

let trail: FakeDb;
let dataDir: string;

/** Every call below only ever exercises the one source under test, so the rest are given inert
 *  defaults — a `mediaRoot` that need not exist, since nothing here calls `sources.disk()` unless a
 *  test overrides it explicitly. */
const optionsFor = (overrides: Partial<OperationalSourcesOptions> = {}): OperationalSourcesOptions => ({
  db: trail,
  queue: fakeQueue([]),
  media: fakeMedia([]),
  dataDir,
  now,
  mongoDb: fakeMongoDb(),
  corpus: fakeCorpus(),
  corpusConfigured: true,
  mediaRoot: dataDir,
  mediaFreeSpaceReserveBytes: 0,
  mediaCleanupGraceDays: 180,
  ...overrides,
});

beforeEach(async () => {
  trail = fakeDb();
  dataDir = join(tmpdir(), `holydeck-operational-sources-${Math.random().toString(36).slice(2)}`);
});

describe('worker', () => {
  test('reads the heartbeat file when the worker has written one', async () => {
    await mkdir(join(dataDir, 'worker'), { recursive: true });
    await writeFile(
      join(dataDir, 'worker', 'heartbeat.json'),
      JSON.stringify({ at: NOW, pid: 4242, paths: ['/data/corpus'] }),
    );
    const sources = operationalSourcesOn(optionsFor({ queue: fakeQueue([]), media: fakeMedia([]) }), context);
    await expect(sources.worker()).resolves.toEqual({ at: NOW, pid: 4242, paths: ['/data/corpus'], staleAfterMs: 45_000 });
  });

  test('reports no reading, not a failure, when the worker has never mounted', async () => {
    const sources = operationalSourcesOn(optionsFor({ queue: fakeQueue([]), media: fakeMedia([]) }), context);
    await expect(sources.worker()).resolves.toEqual({ at: undefined, pid: undefined, paths: undefined, staleAfterMs: 45_000 });
  });

  test('throws on a heartbeat file that is not valid JSON', async () => {
    await mkdir(join(dataDir, 'worker'), { recursive: true });
    await writeFile(join(dataDir, 'worker', 'heartbeat.json'), 'not json');
    const sources = operationalSourcesOn(optionsFor({ queue: fakeQueue([]), media: fakeMedia([]) }), context);
    await expect(sources.worker()).rejects.toThrow();
  });
});

describe('queue', () => {
  test('forwards counts and jobs, and finds the oldest queued job off the raw collection', async () => {
    const jobs = [
      job({ id: 'newer', state: 'queued', queuedAt: '2026-09-21T23:20:00.000Z' }),
      job({ id: 'older', state: 'queued', queuedAt: '2026-09-21T22:00:00.000Z' }),
      job({ id: 'running', state: 'leased', queuedAt: '2026-09-21T21:00:00.000Z' }),
    ];
    trail.rows.set('jobs', jobs.map((entry) => ({ _id: entry.id, ...entry })));
    const sources = operationalSourcesOn(optionsFor({ queue: fakeQueue(jobs), media: fakeMedia([]) }), context);
    await expect(sources.queue()).resolves.toEqual({
      counts: { queued: 2, leased: 1, succeeded: 0, failed: 0 },
      jobs,
      oldestQueuedAt: '2026-09-21T22:00:00.000Z',
    });
  });

  test('reports no oldest queued job when none is queued', async () => {
    const sources = operationalSourcesOn(optionsFor({ queue: fakeQueue([]), media: fakeMedia([]) }), context);
    await expect(sources.queue()).resolves.toMatchObject({ oldestQueuedAt: undefined });
  });
});

describe('backups', () => {
  test('reads recorded backups off the backups collection', async () => {
    const manifest = {
      id: 'backup-1',
      createdAt: NOW,
      schemaVersion: 19,
      contents: [{ class: 'settings', count: 1, bytes: 12, hash: 'restic:settings-snap' }],
      excludedSecrets: [],
    };
    trail.rows.set('backups', [{
      _id: 'backup:backup-1',
      actor: ADMINISTRATOR,
      correlationId: CORRELATION,
      backupId: 'backup-1',
      at: NOW,
      manifest,
      consistency: { pointInTime: true, method: 'snapshot' },
    }]);
    const sources = operationalSourcesOn(optionsFor({ queue: fakeQueue([]), media: fakeMedia([]) }), context);
    await expect(sources.backups()).resolves.toEqual([{
      backupId: 'backup-1',
      at: NOW,
      production: { manifest, consistency: { pointInTime: true, method: 'snapshot' } },
      snapshots: ['settings-snap'],
    }]);
  });
});

describe('rehearsals', () => {
  test('reads recorded restore rehearsals newest first', async () => {
    const objectives = { rpoMinutes: 1500, rtoMinutes: 240 };
    trail.rows.set('restores', [
      {
        _id: 'restore:restore-1',
        actor: ADMINISTRATOR,
        correlationId: CORRELATION,
        restoreId: 'restore-1',
        backupId: 'backup-1',
        at: '2026-09-20T00:00:00.000Z',
        manifest: {},
        consistency: {},
        integrity: {},
        objectives,
        restore: {},
      },
      {
        _id: 'restore:restore-2',
        actor: ADMINISTRATOR,
        correlationId: CORRELATION,
        restoreId: 'restore-2',
        backupId: 'backup-2',
        at: NOW,
        manifest: {},
        consistency: {},
        integrity: {},
        objectives,
        restore: {},
      },
    ]);
    const sources = operationalSourcesOn(optionsFor({ queue: fakeQueue([]), media: fakeMedia([]) }), context);
    await expect(sources.rehearsals()).resolves.toEqual([
      { at: NOW, objectives },
      { at: '2026-09-20T00:00:00.000Z', objectives },
    ]);
  });
});

describe('media', () => {
  test('extracts the manifest entry off every media record', async () => {
    const manifest: MediaManifestEntry = {
      id: 'media-1',
      bytes: 1024,
      hash: 'sha256:abc',
      type: 'image/png',
      processingState: 'ready',
      derivatives: [],
    };
    const sources = operationalSourcesOn(optionsFor({ queue: fakeQueue([]), media: fakeMedia([manifest]) }), context);
    await expect(sources.media()).resolves.toEqual([manifest]);
  });
});

describe('database', () => {
  test('pings and reads stats when the store answers', async () => {
    const sources = operationalSourcesOn(
      optionsFor({ mongoDb: fakeMongoDb({ stats: async () => ({ storageSize: 42_000_000 }) }) }),
      context,
    );
    await expect(sources.database()).resolves.toMatchObject({ reachable: true, storageBytes: 42_000_000 });
  });

  test('reports unreachable, not a throw, when the ping fails', async () => {
    const sources = operationalSourcesOn(
      optionsFor({
        mongoDb: fakeMongoDb({
          command: async () => { throw new Error('no route to host'); },
        }),
      }),
      context,
    );
    await expect(sources.database()).resolves.toEqual({ reachable: false });
  });
});

describe('corpus', () => {
  test('reports not configured without calling the client at all', async () => {
    let called = false;
    const corpus = fakeCorpus({ translations: async () => { called = true; return { ok: true, value: [] }; } });
    const sources = operationalSourcesOn(optionsFor({ corpus, corpusConfigured: false }), context);
    await expect(sources.corpus()).resolves.toEqual({ configured: false });
    expect(called).toBe(false);
  });

  test('reports reachable with a latency when configured and the client answers ok', async () => {
    const sources = operationalSourcesOn(optionsFor({ corpusConfigured: true }), context);
    await expect(sources.corpus()).resolves.toMatchObject({ configured: true, reachable: true });
  });

  test('reports unreachable, not a throw, when the client refuses', async () => {
    const corpus = fakeCorpus({ translations: async () => ({ ok: false, refusal: LIBRARY_UNAVAILABLE }) });
    const sources = operationalSourcesOn(optionsFor({ corpus, corpusConfigured: true }), context);
    await expect(sources.corpus()).resolves.toEqual({ configured: true, reachable: false });
  });
});

describe('disk', () => {
  test('reports free space against the given reserve', async () => {
    const sources = operationalSourcesOn(
      optionsFor({ mediaRoot: tmpdir(), mediaFreeSpaceReserveBytes: 12_345 }),
      context,
    );
    const reading = await sources.disk();
    expect(reading.reserveBytes).toBe(12_345);
    expect(reading.freeBytes).toBeGreaterThan(0);
  });

  test('propagates, rather than catching, an unreadable media root', async () => {
    const sources = operationalSourcesOn(
      optionsFor({ mediaRoot: join(dataDir, 'does-not-exist'), mediaFreeSpaceReserveBytes: 0 }),
      context,
    );
    await expect(sources.disk()).rejects.toThrow();
  });
});

describe('process', () => {
  test("reports this process's own CPU and memory, never negative", async () => {
    const sources = operationalSourcesOn(optionsFor({}), context);
    const reading = await sources.process();
    expect(reading.cpuUserSeconds).toBeGreaterThanOrEqual(0);
    expect(reading.cpuSystemSeconds).toBeGreaterThanOrEqual(0);
    expect(reading.memoryRssMb).toBeGreaterThan(0);
  });
});

describe('mediaCleanup', () => {
  test('counts only eligible items and sums their bytes', async () => {
    const items: readonly MediaPurgeItem[] = [
      { id: 'a', bytes: 1000, type: 'image/png', hash: 'sha256:a', archivedAt: NOW, category: 'eligible', reason: undefined, purgeableAt: undefined },
      { id: 'b', bytes: 2000, type: 'image/png', hash: 'sha256:b', archivedAt: NOW, category: 'eligible', reason: undefined, purgeableAt: undefined },
      { id: 'c', bytes: 3000, type: 'image/png', hash: 'sha256:c', archivedAt: NOW, category: 'protected', reason: 'referenced', purgeableAt: undefined },
    ];
    const media = fakeMedia([], async () => ({ items }));
    const sources = operationalSourcesOn(optionsFor({ media }), context);
    await expect(sources.mediaCleanup()).resolves.toEqual({ eligibleCount: 2, reclaimableBytes: 3000 });
  });

  test('reports nothing eligible when the report is empty', async () => {
    const sources = operationalSourcesOn(optionsFor({}), context);
    await expect(sources.mediaCleanup()).resolves.toEqual({ eligibleCount: 0, reclaimableBytes: 0 });
  });
});
