import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditContext } from '@holydeck/app/audit';
import { CANONICAL_SETTINGS_PATH, loadSettings } from '@holydeck/app/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MediaMigrationError, mediaMigrationOn } from './media-migration-handler.js';
import { fakeDb } from '../../app/test/helpers/fake-db.js';

import type { MaintenanceStore } from '@holydeck/app/maintenance';
import type { MediaMigrationRecord, MediaMigrationStateStore } from '@holydeck/app/media-migration-state';
import type { LeasedJob } from '@holydeck/contracts/jobs';

const { hashCalls, forceMismatchAt } = vi.hoisted(() => ({
  hashCalls: { count: 0 },
  forceMismatchAt: { call: undefined as number | undefined },
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    createHash: (...args: Parameters<typeof actual.createHash>) => {
      const hash = actual.createHash(...args);
      hashCalls.count += 1;
      const call = hashCalls.count;
      const digest = hash.digest.bind(hash);
      // @ts-expect-error -- overriding one real Hash instance's digest, for one deterministic mismatch test
      hash.digest = (encoding?: 'hex') => (call === forceMismatchAt.call ? 'forced-mismatch-digest' : digest(encoding));
      return hash;
    },
  };
});

const NOW = '2026-09-23T03:00:00.000Z';
const CONTEXT = auditContext('system', 'req-media-migration');
const PATH = CANONICAL_SETTINGS_PATH;

const job = (targetRoot?: string): LeasedJob => ({
  id: 'job-1',
  kind: 'media-root-migrate',
  idempotencyKey: 'media-root-migrate:1',
  state: 'leased',
  attempt: 1,
  retryLimit: 2,
  queuedAt: NOW,
  workers: ['worker-1'],
  leaseExpiresAt: '2026-09-23T03:01:00.000Z',
  heartbeatAt: NOW,
  lastError: undefined,
  payload: targetRoot === undefined ? {} : { targetRoot },
});

const entries = (db: ReturnType<typeof fakeDb>) => db.rows.get('audit_events') ?? [];

/** A settings IO with no `writable` probe, the same shape `main.ts` gives the real handler (Ruling 4). */
const fakeWorkerSettingsIo = (fromRoot: string) => {
  const files = new Map<string, string>([[PATH, `mediaRoot: ${fromRoot}\n`]]);
  return {
    files,
    env: {} as Record<string, string | undefined>,
    async readFile(path: string) {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
      return text;
    },
    async writeFile(path: string, text: string) {
      files.set(path, text);
    },
    async rename(from: string, to: string) {
      const text = files.get(from);
      files.delete(from);
      if (text !== undefined) files.set(to, text);
    },
  };
};

const fakeMaintenance = (): MaintenanceStore & { readonly acquired: string[]; readonly released: number[] } => {
  const acquired: string[] = [];
  const released: number[] = [];
  return {
    acquired,
    released,
    read: async () => ({ active: false }),
    async acquire(reason) {
      acquired.push(reason);
    },
    async release() {
      released.push(released.length + 1);
    },
  };
};

const fakeMigrationState = (): MediaMigrationStateStore & {
  readonly completions: MediaMigrationRecord[];
  readonly cleanups: string[];
} => {
  const completions: MediaMigrationRecord[] = [];
  const cleanups: string[] = [];
  return {
    completions,
    cleanups,
    async read() {
      return completions.at(-1);
    },
    async recordCompletion(record) {
      completions.push(record);
    },
    async recordCleanup(at) {
      cleanups.push(at);
    },
  };
};

describe('migrating media storage to a new root', () => {
  let fromRoot: string;
  let targetRoot: string;

  beforeEach(async () => {
    hashCalls.count = 0;
    forceMismatchAt.call = undefined;
    fromRoot = await mkdtemp(join(tmpdir(), 'holydeck-media-migration-from-'));
    targetRoot = await mkdtemp(join(tmpdir(), 'holydeck-media-migration-to-'));
    await mkdir(join(fromRoot, 'nested'), { recursive: true });
    await writeFile(join(fromRoot, 'photo.jpg'), 'photo-bytes', 'utf8');
    await writeFile(join(fromRoot, 'nested', 'clip.mp4'), 'clip-bytes', 'utf8');
  });

  it('copies every file real, verifies it, and only then switches mediaRoot', async () => {
    const db = fakeDb();
    const maintenance = fakeMaintenance();
    const migrationState = fakeMigrationState();
    const settingsIo = fakeWorkerSettingsIo(fromRoot);
    const loaded = loadSettings({ fileText: `mediaRoot: ${fromRoot}\n`, env: {}, path: PATH });
    const handler = mediaMigrationOn({
      context: CONTEXT,
      db,
      maintenance,
      migrationState,
      loaded,
      settingsIo,
      now: () => NOW,
    });

    await expect(handler(job(targetRoot), new AbortController().signal)).resolves.toBeUndefined();

    await expect(readFile(join(targetRoot, 'photo.jpg'), 'utf8')).resolves.toBe('photo-bytes');
    await expect(readFile(join(targetRoot, 'nested', 'clip.mp4'), 'utf8')).resolves.toBe('clip-bytes');

    const written = settingsIo.files.get(PATH) ?? '';
    expect(written).toContain(`mediaRoot: ${targetRoot}`);

    expect(migrationState.completions).toEqual([{ fromRoot, toRoot: targetRoot, completedAt: NOW }]);
    expect(maintenance.acquired).toEqual([`migrating media storage to ${targetRoot}`]);
    expect(maintenance.released).toHaveLength(1);

    expect(entries(db)).toMatchObject([
      { action: 'media.storageMigration.complete', subject: targetRoot, outcome: 'allowed' },
    ]);
  });

  it('treats a mediaRoot nothing has ever written into as an empty, no-op copy', async () => {
    const neverCreated = join(fromRoot, 'never-created-subdir');
    const db = fakeDb();
    const maintenance = fakeMaintenance();
    const migrationState = fakeMigrationState();
    const settingsIo = fakeWorkerSettingsIo(neverCreated);
    const loaded = loadSettings({ fileText: `mediaRoot: ${neverCreated}\n`, env: {}, path: PATH });
    const handler = mediaMigrationOn({
      context: CONTEXT,
      db,
      maintenance,
      migrationState,
      loaded,
      settingsIo,
      now: () => NOW,
    });

    await expect(handler(job(targetRoot), new AbortController().signal)).resolves.toBeUndefined();

    expect(migrationState.completions).toEqual([{ fromRoot: neverCreated, toRoot: targetRoot, completedAt: NOW }]);
    expect(entries(db)).toMatchObject([{ action: 'media.storageMigration.complete', outcome: 'allowed' }]);
  });

  it('refuses a job naming no targetRoot at all, before touching maintenance', async () => {
    const maintenance = fakeMaintenance();
    const handler = mediaMigrationOn({
      context: CONTEXT,
      db: fakeDb(),
      maintenance,
      migrationState: fakeMigrationState(),
      loaded: loadSettings({ fileText: `mediaRoot: ${fromRoot}\n`, env: {}, path: PATH }),
      settingsIo: fakeWorkerSettingsIo(fromRoot),
      now: () => NOW,
    });

    await expect(handler(job(), new AbortController().signal)).rejects.toThrow(
      'a media-root-migrate job must name payload.targetRoot',
    );
    expect(maintenance.acquired).toEqual([]);
  });

  it('refuses a target that is the same as the current media root, before touching maintenance', async () => {
    const maintenance = fakeMaintenance();
    const handler = mediaMigrationOn({
      context: CONTEXT,
      db: fakeDb(),
      maintenance,
      migrationState: fakeMigrationState(),
      loaded: loadSettings({ fileText: `mediaRoot: ${fromRoot}\n`, env: {}, path: PATH }),
      settingsIo: fakeWorkerSettingsIo(fromRoot),
      now: () => NOW,
    });

    await expect(handler(job(fromRoot), new AbortController().signal)).rejects.toThrow(
      'the target root is the same as the current media root',
    );
    expect(maintenance.acquired).toEqual([]);
  });

  it('rolls back on a hash mismatch: the setting is never switched, and the lease is still released', async () => {
    forceMismatchAt.call = 2; // the destination hash of the first file this walk verifies
    const db = fakeDb();
    const maintenance = fakeMaintenance();
    const migrationState = fakeMigrationState();
    const settingsIo = fakeWorkerSettingsIo(fromRoot);
    const loaded = loadSettings({ fileText: `mediaRoot: ${fromRoot}\n`, env: {}, path: PATH });
    const handler = mediaMigrationOn({
      context: CONTEXT,
      db,
      maintenance,
      migrationState,
      loaded,
      settingsIo,
      now: () => NOW,
    });

    await expect(handler(job(targetRoot), new AbortController().signal)).rejects.toThrow(MediaMigrationError);

    expect(migrationState.completions).toEqual([]);
    expect(settingsIo.files.get(PATH)).toBe(`mediaRoot: ${fromRoot}\n`);
    expect(maintenance.acquired).toEqual([`migrating media storage to ${targetRoot}`]);
    expect(maintenance.released).toHaveLength(1);
    expect(entries(db)).toMatchObject([
      { action: 'media.storageMigration.fail', subject: targetRoot, outcome: 'refused' },
    ]);
    expect((entries(db)[0] as { detail?: string }).detail).toMatch(/did not verify after copy/u);
  });

  it('stops before finishing the walk when the lease is lost mid-copy, releasing it either way', async () => {
    const db = fakeDb();
    const maintenance = fakeMaintenance();
    const stopping = new AbortController();
    const handler = mediaMigrationOn({
      context: CONTEXT,
      db,
      maintenance,
      migrationState: fakeMigrationState(),
      loaded: loadSettings({ fileText: `mediaRoot: ${fromRoot}\n`, env: {}, path: PATH }),
      settingsIo: fakeWorkerSettingsIo(fromRoot),
      now: () => NOW,
      report: () => stopping.abort(),
    });

    await expect(handler(job(targetRoot), stopping.signal)).rejects.toThrow(
      'media migration stopped after its lease was lost',
    );
    expect(maintenance.released).toHaveLength(1);
    expect(entries(db)).toMatchObject([{ action: 'media.storageMigration.fail', outcome: 'refused' }]);
  });
});
