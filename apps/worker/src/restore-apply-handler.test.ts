import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { MONGO_CONTENTS, archiveEntryOf } from '@holydeck/app/backups';
import { restoreContext } from '@holydeck/app/restores';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SETTINGS_STAGING_DIR } from './backup-producer.js';
import { restoreApplyOn } from './restore-apply-handler.js';
import { fakeDb } from '../../app/test/helpers/fake-db.js';

import type { Document } from '@holydeck/app/repositories';
import type { MaintenanceStore } from '@holydeck/app/maintenance';
import type { RestoreCollection, RestoreDb } from '@holydeck/app/restores';
import type { LeasedJob } from '@holydeck/contracts/jobs';

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

const NOW = '2026-09-23T02:00:00.000Z';
const CONTEXT = restoreContext('system', 'req-restore-apply');
const RESTIC = { repository: '/data/holydeck/restic', password: 'p'.repeat(64) };
const BACKUP_ID = 'backup-fixed';

const job = (components?: readonly string[]): LeasedJob => ({
  id: 'job-1',
  kind: 'restore-apply',
  idempotencyKey: `restore-apply:${BACKUP_ID}:${NOW}`,
  state: 'leased',
  attempt: 1,
  retryLimit: 2,
  queuedAt: NOW,
  workers: ['worker-1'],
  leaseExpiresAt: '2026-09-23T02:01:00.000Z',
  heartbeatAt: NOW,
  lastError: undefined,
  payload: components === undefined ? { backupId: BACKUP_ID } : { backupId: BACKUP_ID, components },
});

const SEEDED: Readonly<Record<string, readonly Document[]>> = { services: [{ _id: 'svc-1', name: 'Sunday' }] };
const dumps = MONGO_CONTENTS.map((content) => ({
  file: `${content.class}.json`,
  ...archiveEntryOf(content.class, SEEDED[content.class] ?? []),
}));
const RESTIC_CONTENTS = [
  { class: 'mongo', count: 4, bytes: 128, hash: 'restic:mongo-snap' },
  { class: 'settings', count: 3, bytes: 512, hash: 'restic:settings-snap' },
  { class: 'media', count: 5, bytes: 2048, hash: 'restic:media-snap' },
];

const manifestOf = (contents: readonly unknown[]): Record<string, unknown> => ({
  id: BACKUP_ID,
  createdAt: NOW,
  schemaVersion: 19,
  contents,
  excludedSecrets: ['session-keys', 'credential-hashes', 'api-tokens', 'signing-keys'],
});

const recordedBackup = (contents: readonly unknown[]): Document => ({
  _id: `backup:${BACKUP_ID}`,
  actor: 'system',
  correlationId: 'req-backup',
  backupId: BACKUP_ID,
  at: NOW,
  manifest: manifestOf(contents),
  consistency: { pointInTime: true, method: 'a session read at one snapshot cluster time' },
});

const FULL_CONTENTS = [...dumps.map((dump) => dump.content), ...RESTIC_CONTENTS];

const fakeTarget = (): RestoreDb & { readonly rows: Map<string, Document[]> } => {
  const rows = new Map<string, Document[]>();
  return {
    rows,
    collection(name: string): RestoreCollection {
      const stored = rows.get(name) ?? [];
      rows.set(name, stored);
      return {
        find: () => ({ toArray: async () => [...stored] }),
        async deleteMany() {
          const deletedCount = stored.length;
          stored.length = 0;
          return { deletedCount };
        },
        async insertMany(documents: readonly Document[]) {
          stored.push(...documents);
          return { insertedCount: documents.length };
        },
      };
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

/** The `--target` a spawned restic call was given, so a test can populate it the way restic would have. */
const targetOf = (call: number): string => {
  const args = spawned.mock.calls[call]?.[1] as string[];
  return args[args.indexOf('--target') + 1] as string;
};

const writeMongoDumps = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true });
  for (const dump of dumps) await writeFile(join(root, dump.file), dump.text, 'utf8');
};

const options = (over: Partial<Parameters<typeof restoreApplyOn>[0]> = {}): Parameters<typeof restoreApplyOn>[0] => ({
  context: CONTEXT,
  db: fakeDb(),
  target: fakeTarget(),
  sessions: { revokeEvery: async () => 3 },
  capabilities: { revokeEvery: async () => 6 },
  compatibility: { record: async () => undefined },
  maintenance: fakeMaintenance(),
  restic: RESTIC,
  settingsPath: '/never/set/in/a/test/that/does/not/touch/it',
  mediaRoot: '/never/set/in/a/test/that/does/not/touch/it',
  now: () => NOW,
  ...over,
});

const entries = (db: ReturnType<typeof fakeDb>): Document[] => db.rows.get('audit_events') ?? [];

describe('applying a recorded backup to production', () => {
  let settingsDir: string;
  let settingsPath: string;
  let mediaRoot: string;

  beforeEach(async () => {
    children.length = 0;
    spawned.mockClear();
    settingsDir = await mkdtemp(join(tmpdir(), 'holydeck-restore-apply-settings-'));
    settingsPath = join(settingsDir, 'settings.env');
    await writeFile(settingsPath, 'old-settings', 'utf8');
    mediaRoot = await mkdtemp(join(tmpdir(), 'holydeck-restore-apply-media-'));
    await writeFile(join(mediaRoot, 'old.jpg'), 'old-media', 'utf8');
  });

  it('restores mongo, settings and media behind the maintenance lease, and audits it', async () => {
    const db = fakeDb();
    db.rows.set('backups', [recordedBackup(FULL_CONTENTS)]);
    const target = fakeTarget();
    const revokeEvery = vi.fn(async () => 3);
    const revokeEveryCapability = vi.fn(async () => 6);
    const record = vi.fn(async () => undefined);
    const maintenance = fakeMaintenance();
    const handler = restoreApplyOn(
      options({
        db,
        target,
        sessions: { revokeEvery },
        capabilities: { revokeEvery: revokeEveryCapability },
        compatibility: { record },
        maintenance,
        settingsPath,
        mediaRoot,
      }),
    );

    const running = handler(job(['mongo', 'settings', 'media']), new AbortController().signal);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(1));
    children[0]?.emit('close', 0);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(2));
    const mongoRoot = targetOf(1);
    await writeMongoDumps(mongoRoot);
    children[1]?.emit('close', 0);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(3));
    const settingsRoot = targetOf(2);
    await mkdir(join(settingsRoot, SETTINGS_STAGING_DIR), { recursive: true });
    await writeFile(join(settingsRoot, SETTINGS_STAGING_DIR, basename(settingsPath)), 'new-settings', 'utf8');
    children[2]?.emit('close', 0);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(4));
    const mediaRestoredRoot = targetOf(3);
    await mkdir(join(mediaRestoredRoot, mediaRoot), { recursive: true });
    await writeFile(join(mediaRestoredRoot, mediaRoot, 'new.jpg'), 'new-media', 'utf8');
    children[3]?.emit('close', 0);

    await expect(running).resolves.toBeUndefined();

    expect(spawned).toHaveBeenNthCalledWith(1, 'restic', ['check', '--repo', RESTIC.repository, '--read-data-subset=5%'], expect.anything());
    expect(spawned).toHaveBeenNthCalledWith(
      2,
      'restic',
      ['restore', 'mongo-snap', '--repo', RESTIC.repository, '--json', '--target', mongoRoot],
      expect.anything(),
    );
    expect(spawned).toHaveBeenNthCalledWith(
      3,
      'restic',
      ['restore', 'settings-snap', '--repo', RESTIC.repository, '--json', '--target', settingsRoot],
      expect.anything(),
    );
    expect(spawned).toHaveBeenNthCalledWith(
      4,
      'restic',
      ['restore', 'media-snap', '--repo', RESTIC.repository, '--json', '--target', mediaRestoredRoot],
      expect.anything(),
    );

    expect(maintenance.acquired).toEqual([`applying restore ${BACKUP_ID}`]);
    expect(maintenance.released).toHaveLength(1);
    expect(revokeEvery).toHaveBeenCalledOnce();
    expect(revokeEveryCapability).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledOnce();

    await expect(readFile(settingsPath, 'utf8')).resolves.toBe('new-settings');
    await expect(readFile(join(mediaRoot, 'new.jpg'), 'utf8')).resolves.toBe('new-media');
    expect(existsSync(join(mediaRoot, 'old.jpg'))).toBe(false);
    expect(existsSync(mongoRoot)).toBe(false);

    expect(entries(db)).toMatchObject([
      { action: 'restore.run', subject: BACKUP_ID, outcome: 'allowed' },
      { action: 'restore.apply.complete', subject: BACKUP_ID, outcome: 'allowed' },
    ]);
  });

  it('narrows to the components the job asked for, leaving the rest untouched', async () => {
    const db = fakeDb();
    db.rows.set('backups', [recordedBackup(FULL_CONTENTS)]);
    const target = fakeTarget();
    const revokeEvery = vi.fn(async () => 3);
    const handler = restoreApplyOn(options({ db, target, sessions: { revokeEvery }, settingsPath, mediaRoot }));

    const running = handler(job(['settings']), new AbortController().signal);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(1));
    children[0]?.emit('close', 0);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(2));
    const settingsRoot = targetOf(1);
    await mkdir(join(settingsRoot, SETTINGS_STAGING_DIR), { recursive: true });
    await writeFile(join(settingsRoot, SETTINGS_STAGING_DIR, basename(settingsPath)), 'narrowed-settings', 'utf8');
    children[1]?.emit('close', 0);

    await expect(running).resolves.toBeUndefined();
    expect(spawned).toHaveBeenCalledTimes(2);
    await expect(readFile(settingsPath, 'utf8')).resolves.toBe('narrowed-settings');
    await expect(readFile(join(mediaRoot, 'old.jpg'), 'utf8')).resolves.toBe('old-media');
    expect(revokeEvery).not.toHaveBeenCalled();
  });

  it('refuses a job naming a backup this deployment never recorded, before touching maintenance', async () => {
    const db = fakeDb();
    const maintenance = fakeMaintenance();
    const handler = restoreApplyOn(options({ db, maintenance }));

    await expect(handler(job(['mongo']), new AbortController().signal)).rejects.toThrow(
      `restore-apply: ${BACKUP_ID} is not a recorded backup`,
    );
    expect(spawned).not.toHaveBeenCalled();
    expect(maintenance.acquired).toEqual([]);
  });

  it('refuses a job naming no backupId at all', async () => {
    const handler = restoreApplyOn(options());
    const withoutBackupId: LeasedJob = { ...job(), payload: {} };
    await expect(handler(withoutBackupId, new AbortController().signal)).rejects.toThrow(
      'a restore-apply job must name the backupId to restore',
    );
    expect(spawned).not.toHaveBeenCalled();
  });

  it('releases the lease and audits the failure when a requested class has no snapshot', async () => {
    const db = fakeDb();
    db.rows.set('backups', [recordedBackup([...dumps.map((dump) => dump.content), RESTIC_CONTENTS[0] as unknown, RESTIC_CONTENTS[2] as unknown])]);
    const maintenance = fakeMaintenance();
    const handler = restoreApplyOn(options({ db, maintenance, settingsPath, mediaRoot }));

    const running = handler(job(['settings']), new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(1));
    children[0]?.emit('close', 0);

    await expect(running).rejects.toThrow(`restore ${BACKUP_ID}: no snapshot holds the settings archive`);
    expect(spawned).toHaveBeenCalledTimes(1);
    expect(maintenance.acquired).toEqual([`applying restore ${BACKUP_ID}`]);
    expect(maintenance.released).toHaveLength(1);
    expect(entries(db)).toMatchObject([
      { action: 'restore.apply.fail', subject: BACKUP_ID, outcome: 'refused' },
    ]);
  });

  it('stops before restoring anything when the lease is lost during the repository check', async () => {
    const db = fakeDb();
    db.rows.set('backups', [recordedBackup(FULL_CONTENTS)]);
    const maintenance = fakeMaintenance();
    const stopping = new AbortController();
    const handler = restoreApplyOn(options({ db, maintenance, settingsPath, mediaRoot }));

    const running = handler(job(['mongo']), stopping.signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(1));
    stopping.abort();
    children[0]?.emit('close', 0);

    await expect(running).rejects.toThrow('restore apply stopped after its lease was lost');
    expect(spawned).toHaveBeenCalledTimes(1);
    expect(maintenance.released).toHaveLength(1);
    expect(entries(db)).toMatchObject([{ action: 'restore.apply.fail', subject: BACKUP_ID, outcome: 'refused' }]);
  });
});
