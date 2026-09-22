import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, test } from 'vitest';

import { requestContext } from './context.js';
import { BACKUP_RECORD } from './backups.js';
import { operationalSourcesOn } from './operational-sources.js';
import { QUEUE_PERMISSIONS } from './queue.js';
import { permissionsFor } from './records.js';
import { RESTORE_RECORD } from './restores.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { JobRecord, JobState } from '@holydeck/contracts/jobs';
import type { MediaManifestEntry } from '@holydeck/contracts/media';
import type { Queue } from './queue.js';
import type { MediaLibrary, MediaRecord } from './media.js';
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

const fakeMedia = (entries: readonly MediaManifestEntry[]): Pick<MediaLibrary, 'list'> => ({
  async list() {
    return entries.map((manifest) => ({ stamp: { sequence: 1 }, manifest, storageKey: manifest.id }) as unknown as MediaRecord);
  },
});

let trail: FakeDb;
let dataDir: string;

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
    const sources = operationalSourcesOn({ db: trail, queue: fakeQueue([]), media: fakeMedia([]), dataDir, now }, context);
    await expect(sources.worker()).resolves.toEqual({ at: NOW, pid: 4242, paths: ['/data/corpus'], staleAfterMs: 45_000 });
  });

  test('reports no reading, not a failure, when the worker has never mounted', async () => {
    const sources = operationalSourcesOn({ db: trail, queue: fakeQueue([]), media: fakeMedia([]), dataDir, now }, context);
    await expect(sources.worker()).resolves.toEqual({ at: undefined, pid: undefined, paths: undefined, staleAfterMs: 45_000 });
  });

  test('throws on a heartbeat file that is not valid JSON', async () => {
    await mkdir(join(dataDir, 'worker'), { recursive: true });
    await writeFile(join(dataDir, 'worker', 'heartbeat.json'), 'not json');
    const sources = operationalSourcesOn({ db: trail, queue: fakeQueue([]), media: fakeMedia([]), dataDir, now }, context);
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
    const sources = operationalSourcesOn({ db: trail, queue: fakeQueue(jobs), media: fakeMedia([]), dataDir, now }, context);
    await expect(sources.queue()).resolves.toEqual({
      counts: { queued: 2, leased: 1, succeeded: 0, failed: 0 },
      jobs,
      oldestQueuedAt: '2026-09-21T22:00:00.000Z',
    });
  });

  test('reports no oldest queued job when none is queued', async () => {
    const sources = operationalSourcesOn({ db: trail, queue: fakeQueue([]), media: fakeMedia([]), dataDir, now }, context);
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
    const sources = operationalSourcesOn({ db: trail, queue: fakeQueue([]), media: fakeMedia([]), dataDir, now }, context);
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
    const sources = operationalSourcesOn({ db: trail, queue: fakeQueue([]), media: fakeMedia([]), dataDir, now }, context);
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
    const sources = operationalSourcesOn({ db: trail, queue: fakeQueue([]), media: fakeMedia([manifest]), dataDir, now }, context);
    await expect(sources.media()).resolves.toEqual([manifest]);
  });
});
