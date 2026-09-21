import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { backupContext } from '@holydeck/app/backups';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SETTINGS_STAGING_DIR, backupProducerOn } from './backup-producer.js';
import { runnerOn } from './runner.js';
import { fakeDb } from '../../app/test/helpers/fake-db.js';

import type { BackupCollection, BackupDb, BackupSession } from '@holydeck/app/backups';
import type { LeasedJob } from '@holydeck/contracts/jobs';
import type { RunnerQueue } from './runner.js';

class FakeChild extends EventEmitter {
  readonly kill = vi.fn();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

const children: FakeChild[] = [];
const spawned = vi.fn<(...args: unknown[]) => FakeChild>(() => {
  const child = new FakeChild();
  children.push(child);
  return child;
});
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawned(...args) }));

const CONTEXT = backupContext('system', 'req-backup-producer');
const NOW = '2026-09-21T02:00:00.000Z';

const job = (fields: Partial<LeasedJob> = {}): LeasedJob => ({
  id: 'job-1',
  kind: 'backup-run',
  idempotencyKey: 'backup-run:2026-09-21',
  state: 'leased',
  attempt: 1,
  retryLimit: 2,
  queuedAt: NOW,
  workers: ['worker-1'],
  leaseExpiresAt: '2026-09-21T02:01:00.000Z',
  heartbeatAt: NOW,
  lastError: undefined,
  payload: {},
  ...fields,
});

const fakeArchiveDb = (seed: Readonly<Record<string, readonly Record<string, unknown>[]>> = {}): BackupDb => ({
  collection: (name): BackupCollection => ({ find: () => ({ toArray: async () => [...(seed[name] ?? [])] }) }),
  startSession: (): BackupSession => ({
    withTransaction: async (fn) => fn(),
    endSession: async () => undefined,
  }),
});

const summaryLine = (fields: Record<string, unknown>): string =>
  `${JSON.stringify({ message_type: 'summary', ...fields })}\n`;

const OPTIONS = {
  context: CONTEXT,
  restic: { repository: '/data/holydeck/restic' },
  // Left pointing at nothing on disk: most of these tests do not care what the "settings" class holds,
  // and `stageRedactedSettings` treats a missing file as "nothing configured yet" rather than a failure.
  settingsPath: '/data/holydeck/config/settings.yaml',
  mediaRoot: '/data/holydeck/media',
  schemaVersion: 19,
  now: () => NOW,
  newId: () => 'backup-fixed',
};

/** A backup an earlier run recorded, spread across one snapshot of its own. */
const recorded = (day: string): Record<string, unknown> => ({
  _id: `backup:backup-${day}`,
  actor: 'system',
  correlationId: 'req-earlier',
  backupId: `backup-${day}`,
  at: `${day}T02:00:00.000Z`,
  manifest: {
    id: `backup-${day}`,
    createdAt: `${day}T02:00:00.000Z`,
    schemaVersion: 19,
    contents: [{ class: 'media', count: 1, bytes: 1, hash: `restic:snap-${day}` }],
    excludedSecrets: [],
  },
  consistency: { pointInTime: true, method: 'a session read at one snapshot cluster time' },
});

/** Drives the four restic calls a successful backup makes, in order, to their summaries. */
const completeBackupCalls = async (): Promise<void> => {
  await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(1));
  children[0]?.emit('close', 0);
  for (const [at, snapshot] of [
    [1, 'mongo-snap'],
    [2, 'settings-snap'],
    [3, 'media-snap'],
  ] as const) {
    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(at + 1));
    children[at]?.stdout.emit(
      'data',
      Buffer.from(summaryLine({ files_new: 1, total_bytes_processed: 1, snapshot_id: snapshot })),
    );
    children[at]?.emit('close', 0);
  }
};

describe('producing a backup', () => {
  beforeEach(() => {
    children.length = 0;
    spawned.mockClear();
  });

  it('reads the Mongo archive, dumps it, backs up mongo, settings and media, and finalizes one manifest', async () => {
    const db = fakeDb();
    const seededService = { _id: 'svc-1', name: 'Sunday' };
    const handler = backupProducerOn({ ...OPTIONS, archive: fakeArchiveDb({ services: [seededService] }), db });

    const running = handler(job(), new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(1));
    children[0]?.emit('close', 0);

    // Every dump file `readMongoArchive` writes exists on disk by now — it ran to completion before the
    // first restic call was even made. Read it back here, before the run's cleanup ever gets a chance to
    // delete it, and independently rehash it: this is the byte-for-byte proof that what gets persisted is
    // what the manifest's hash was computed over, not two independently-computed values that merely agree
    // by construction.
    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(2));
    const mongoArgs = spawned.mock.calls[1]?.[1] as string[];
    const dumpDir = mongoArgs.at(-1) as string;
    expect(dumpDir).toContain(join(tmpdir(), 'holydeck-backup-mongo-'));
    const dumpedServices = await readFile(join(dumpDir, 'services.json'), 'utf8');
    expect(dumpedServices).toBe(JSON.stringify([seededService]));
    const rehashedServices = `sha256:${createHash('sha256').update(dumpedServices).digest('hex')}`;

    children[1]?.stdout.emit(
      'data',
      Buffer.from(summaryLine({ files_new: 1, total_bytes_processed: 128, snapshot_id: 'mongo-snap' })),
    );
    children[1]?.emit('close', 0);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(3));
    children[2]?.stdout.emit(
      'data',
      Buffer.from(summaryLine({ files_new: 3, total_bytes_processed: 512, snapshot_id: 'settings-snap' })),
    );
    children[2]?.emit('close', 0);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(4));
    children[3]?.stdout.emit(
      'data',
      Buffer.from(summaryLine({ files_new: 5, total_bytes_processed: 2048, snapshot_id: 'media-snap' })),
    );
    children[3]?.emit('close', 0);

    await expect(running).resolves.toBeUndefined();

    const backups = db.rows.get('backups') ?? [];
    expect(backups).toHaveLength(1);
    const manifest = (backups[0] as { manifest: { contents: Array<{ class: string; hash: string }> } }).manifest;
    expect(manifest.contents.map((content) => content.class).sort()).toEqual(
      ['content-revisions', 'media', 'mongo', 'prepared-snapshots', 'run-events', 'services', 'settings'].sort(),
    );
    const services = manifest.contents.find((content) => content.class === 'services');
    expect(services?.hash).toBe(rehashedServices);
    const mongo = manifest.contents.find((content) => content.class === 'mongo');
    expect(mongo?.hash).toBe('restic:mongo-snap');

    const audits = db.rows.get('audit_events') ?? [];
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'backup.run', subject: 'backup-fixed' });

    expect(spawned).toHaveBeenNthCalledWith(
      1,
      'restic',
      ['init', '--repo', OPTIONS.restic.repository, '--insecure-no-password', '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(spawned).toHaveBeenNthCalledWith(
      2,
      'restic',
      ['backup', '--repo', OPTIONS.restic.repository, '--insecure-no-password', '--json', '--tag', 'mongo', dumpDir],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(spawned).toHaveBeenNthCalledWith(
      3,
      'restic',
      ['backup', '--repo', OPTIONS.restic.repository, '--insecure-no-password', '--json', '--tag', 'settings', SETTINGS_STAGING_DIR],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(spawned).toHaveBeenNthCalledWith(
      4,
      'restic',
      ['backup', '--repo', OPTIONS.restic.repository, '--insecure-no-password', '--json', '--tag', 'media', OPTIONS.mediaRoot],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  });

  it('redacts the settings file before backing it up, so no export ever carries a secret', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'holydeck-backup-producer-settings-'));
    const settingsPath = join(configDir, 'settings.yaml');
    const secretToken = 'super-secret-corpus-token-value';
    await writeFile(
      settingsPath,
      `port: 4100\ncorpusToken: ${secretToken}\nmongoUrl: mongodb://operator:hunter2@mongo:27017/holydeck\n`,
    );

    const db = fakeDb();
    const handler = backupProducerOn({ ...OPTIONS, settingsPath, archive: fakeArchiveDb(), db });

    const running = handler(job(), new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(1));
    children[0]?.emit('close', 0);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(2));
    children[1]?.stdout.emit(
      'data',
      Buffer.from(summaryLine({ files_new: 1, total_bytes_processed: 1, snapshot_id: 'mongo-snap' })),
    );
    children[1]?.emit('close', 0);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(3));
    const staged = await readFile(join(SETTINGS_STAGING_DIR, 'settings.yaml'), 'utf8');
    expect(staged).not.toContain(secretToken);
    expect(staged).not.toContain('hunter2');
    expect(staged).toContain('port: 4100');

    children[2]?.stdout.emit(
      'data',
      Buffer.from(summaryLine({ files_new: 1, total_bytes_processed: 1, snapshot_id: 'settings-snap' })),
    );
    children[2]?.emit('close', 0);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(4));
    children[3]?.stdout.emit(
      'data',
      Buffer.from(summaryLine({ files_new: 1, total_bytes_processed: 1, snapshot_id: 'media-snap' })),
    );
    children[3]?.emit('close', 0);

    await expect(running).resolves.toBeUndefined();
  });

  it('stages settings at one stable path across runs, clearing what a later run has none of', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'holydeck-backup-producer-settings-'));
    const settingsPath = join(configDir, 'settings.yaml');
    await writeFile(settingsPath, 'port: 4100\n');

    const firstDb = fakeDb();
    const first = backupProducerOn({ ...OPTIONS, settingsPath, archive: fakeArchiveDb(), db: firstDb });
    const firstRun = first(job(), new AbortController().signal);
    await completeBackupCalls();
    await expect(firstRun).resolves.toBeUndefined();
    const firstArgs = spawned.mock.calls[2]?.[1] as string[];
    expect(firstArgs.at(-1)).toBe(SETTINGS_STAGING_DIR);
    await expect(readFile(join(SETTINGS_STAGING_DIR, 'settings.yaml'), 'utf8')).resolves.toContain('port: 4100');

    spawned.mockClear();
    children.length = 0;
    const secondDb = fakeDb();
    const second = backupProducerOn({
      ...OPTIONS,
      settingsPath: join(configDir, 'missing.yaml'),
      archive: fakeArchiveDb(),
      db: secondDb,
    });
    const secondRun = second(job(), new AbortController().signal);
    await completeBackupCalls();
    await expect(secondRun).resolves.toBeUndefined();
    const secondArgs = spawned.mock.calls[2]?.[1] as string[];
    expect(secondArgs.at(-1)).toBe(SETTINGS_STAGING_DIR);
    await expect(readFile(join(SETTINGS_STAGING_DIR, 'settings.yaml'), 'utf8')).rejects.toThrow();
  });

  it('kills an in-flight restic process and writes nothing when the lease is lost mid-run', async () => {
    const db = fakeDb();
    const handler = backupProducerOn({ ...OPTIONS, archive: fakeArchiveDb(), db });
    let claimed = false;
    const queue: RunnerQueue = {
      async claim() {
        if (claimed) return undefined;
        claimed = true;
        return job();
      },
      async heartbeat() {
        return false;
      },
      async succeed() {
        throw new Error('the lost lease must not succeed');
      },
      async fail() {
        throw new Error('the lost lease must not fail');
      },
      async recover() {
        return [];
      },
    };
    let beat!: () => void;
    const runner = runnerOn({
      queue,
      context: CONTEXT,
      worker: 'worker-1',
      handlers: { 'backup-run': handler },
      now: () => NOW,
      sleep: async () => undefined,
      ticker: (_everyMs, tick) => {
        beat = tick;
        return (): void => undefined;
      },
      report: () => undefined,
    });

    const running = runner.once();
    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(1));
    children[0]?.emit('close', 0);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(2));
    beat();
    children[1]?.stdout.emit(
      'data',
      Buffer.from(summaryLine({ files_new: 1, total_bytes_processed: 1, snapshot_id: 'mongo-snap' })),
    );
    children[1]?.emit('close', 0);

    await expect(running).resolves.toBe('lost');
    expect(children[1]?.kill).not.toHaveBeenCalled();
    expect(db.rows.get('backups') ?? []).toHaveLength(0);
    expect(db.rows.get('audit_events') ?? []).toHaveLength(0);
  });
});

describe('forgetting what retention no longer keeps', () => {
  beforeEach(() => {
    children.length = 0;
    spawned.mockClear();
  });

  // Eight distinct days of runs against a seven-daily rule: the oldest is the first run no rule claims,
  // and its snapshot is the only one the repository is asked to forget.
  it('prunes the snapshots of the run nothing keeps once the new one is recorded', async () => {
    const db = fakeDb();
    db.rows.set(
      'backups',
      ['2026-09-20', '2026-09-19', '2026-09-18', '2026-09-17', '2026-09-16', '2026-09-15', '2026-09-14'].map(recorded),
    );
    const handler = backupProducerOn({ ...OPTIONS, archive: fakeArchiveDb(), db });

    const running = handler(job(), new AbortController().signal);
    await completeBackupCalls();

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(5));
    children[4]?.emit('close', 0);
    await expect(running).resolves.toBeUndefined();

    expect(spawned).toHaveBeenNthCalledWith(
      5,
      'restic',
      [
        'forget',
        '--repo',
        OPTIONS.restic.repository,
        '--insecure-no-password',
        '--json',
        '--prune',
        'snap-2026-09-14',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  });

  // Retention runs after the backup is already recorded, so a failure there is not a reason to run the
  // whole backup again: a retry would re-dump Mongo, re-take all three snapshots, and record a second row
  // for work that already succeeded. It is reported and left for the next run to decide again.
  it('keeps the backup it already recorded when the repository refuses to forget', async () => {
    const db = fakeDb();
    db.rows.set(
      'backups',
      ['2026-09-20', '2026-09-19', '2026-09-18', '2026-09-17', '2026-09-16', '2026-09-15', '2026-09-14'].map(recorded),
    );
    const reported: string[] = [];
    const handler = backupProducerOn({
      ...OPTIONS,
      archive: fakeArchiveDb(),
      db,
      report: (line) => reported.push(line),
    });

    const running = handler(job(), new AbortController().signal);
    await completeBackupCalls();

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(5));
    children[4]?.stderr.emit('data', Buffer.from('Fatal: unable to create lock in backend\n'));
    children[4]?.emit('close', 1);

    await expect(running).resolves.toBeUndefined();
    expect(db.rows.get('backups') ?? []).toHaveLength(8);
    expect(reported.join('\n')).toContain('unable to create lock in backend');
    expect(reported.join('\n')).toContain('backup-fixed');
  });

  it('asks restic to forget nothing while every run is one a rule still claims', async () => {
    const db = fakeDb();
    db.rows.set('backups', [recorded('2026-09-20')]);
    const handler = backupProducerOn({ ...OPTIONS, archive: fakeArchiveDb(), db });

    const running = handler(job(), new AbortController().signal);
    await completeBackupCalls();

    await expect(running).resolves.toBeUndefined();
    expect(spawned).toHaveBeenCalledTimes(4);
  });
});
