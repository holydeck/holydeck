import { EventEmitter } from 'node:events';

import { backupContext } from '@holydeck/app/backups';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { backupProducerOn } from './backup-producer.js';
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

const fakeArchiveDb = (): BackupDb => ({
  collection: (): BackupCollection => ({ find: () => ({ toArray: async () => [] }) }),
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
  settingsDir: '/data/holydeck/config',
  mediaRoot: '/data/holydeck/media',
  schemaVersion: 19,
  now: () => NOW,
  newId: () => 'backup-fixed',
};

describe('producing a backup', () => {
  beforeEach(() => {
    children.length = 0;
    spawned.mockClear();
  });

  it('reads the Mongo archive, backs up settings and media, and finalizes one manifest', async () => {
    const db = fakeDb();
    const handler = backupProducerOn({ ...OPTIONS, archive: fakeArchiveDb(), db });

    const running = handler(job(), new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(1));
    children[0]?.emit('close', 0);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(2));
    children[1]?.stdout.emit(
      'data',
      Buffer.from(summaryLine({ files_new: 3, total_bytes_processed: 512, snapshot_id: 'settings-snap' })),
    );
    children[1]?.emit('close', 0);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(3));
    children[2]?.stdout.emit(
      'data',
      Buffer.from(summaryLine({ files_new: 5, total_bytes_processed: 2048, snapshot_id: 'media-snap' })),
    );
    children[2]?.emit('close', 0);

    await expect(running).resolves.toBeUndefined();

    const backups = db.rows.get('backups') ?? [];
    expect(backups).toHaveLength(1);
    const manifest = (backups[0] as { manifest: { contents: Array<{ class: string }> } }).manifest;
    expect(manifest.contents.map((content) => content.class).sort()).toEqual(
      ['content-revisions', 'media', 'prepared-snapshots', 'run-events', 'services', 'settings'].sort(),
    );

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
      ['backup', '--repo', OPTIONS.restic.repository, '--insecure-no-password', '--json', '--tag', 'settings', OPTIONS.settingsDir],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(spawned).toHaveBeenNthCalledWith(
      3,
      'restic',
      ['backup', '--repo', OPTIONS.restic.repository, '--insecure-no-password', '--json', '--tag', 'media', OPTIONS.mediaRoot],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
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
      Buffer.from(summaryLine({ files_new: 1, total_bytes_processed: 1, snapshot_id: 'settings-snap' })),
    );
    children[1]?.emit('close', 0);

    await expect(running).resolves.toBe('lost');
    expect(children[1]?.kill).not.toHaveBeenCalled();
    expect(db.rows.get('backups') ?? []).toHaveLength(0);
    expect(db.rows.get('audit_events') ?? []).toHaveLength(0);
  });
});
