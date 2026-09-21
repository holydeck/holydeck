import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MONGO_CONTENTS, archiveEntryOf } from '@holydeck/app/backups';
import { restoreContext } from '@holydeck/app/restores';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { restoreRehearsalOn } from './restore-rehearsal.js';
import { fakeDb } from '../../app/test/helpers/fake-db.js';

import type { Document } from '@holydeck/app/repositories';
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

const NOW = '2026-09-21T02:00:00.000Z';
const CONTEXT = restoreContext('system', 'req-restore-rehearsal');

const job = (): LeasedJob => ({
  id: 'job-1',
  kind: 'restore-run',
  idempotencyKey: 'restore-run:2026-09-21',
  state: 'leased',
  attempt: 1,
  retryLimit: 2,
  queuedAt: NOW,
  workers: ['worker-1'],
  leaseExpiresAt: '2026-09-21T02:01:00.000Z',
  heartbeatAt: NOW,
  lastError: undefined,
  payload: {},
});

const SEEDED: Readonly<Record<string, readonly Document[]>> = { services: [{ _id: 'svc-1', name: 'Sunday' }] };

const dumps = MONGO_CONTENTS.map((content) => ({
  file: `${content.class}.json`,
  ...archiveEntryOf(content.class, SEEDED[content.class] ?? []),
}));

const manifestOf = (contents: readonly unknown[]): Record<string, unknown> => ({
  id: 'backup-fixed',
  createdAt: NOW,
  schemaVersion: 19,
  contents,
  excludedSecrets: ['session-keys', 'credential-hashes', 'api-tokens', 'signing-keys'],
});

const RESTIC = { repository: '/data/holydeck/restic', password: 'p'.repeat(64) };

/** How every restic call is launched: the repository password travels in the environment, never in argv. */
const LAUNCHED = {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: expect.objectContaining({ RESTIC_PASSWORD: RESTIC.password }) as unknown,
};

const RESTIC_CONTENTS = [
  { class: 'mongo', count: 4, bytes: 128, hash: 'restic:mongo-snap' },
  { class: 'settings', count: 3, bytes: 512, hash: 'restic:settings-snap' },
  { class: 'media', count: 5, bytes: 2048, hash: 'restic:media-snap' },
];

const recordedBackup = (contents: readonly unknown[]): Document => ({
  _id: 'backup:backup-fixed',
  actor: 'system',
  correlationId: 'req-backup',
  backupId: 'backup-fixed',
  at: NOW,
  manifest: manifestOf(contents),
  consistency: { pointInTime: true, method: 'a session read at one snapshot cluster time' },
});

/** Enough of a database to be restored into: whole-collection replacement, and nothing else. */
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

const options = (over: Partial<Parameters<typeof restoreRehearsalOn>[0]> = {}): Parameters<typeof restoreRehearsalOn>[0] => ({
  context: CONTEXT,
  db: fakeDb(),
  target: fakeTarget(),
  sessions: { revokeEvery: async () => 3 },
  capabilities: { revokeEvery: async () => 6 },
  restic: RESTIC,
  schemaVersion: 19,
  now: () => NOW,
  newId: () => 'restore-fixed',
  ...over,
});

/** The directory restic was asked to restore into, with the dump the rehearsal expects to find there. */
const restoreInto = async (call: number): Promise<string> => {
  const args = spawned.mock.calls[call]?.[1] as string[];
  const target = args[args.indexOf('--target') + 1] as string;
  for (const dump of dumps) await writeFile(join(target, dump.file), dump.text, 'utf8');
  return target;
};

describe('rehearsing a restore', () => {
  beforeEach(() => {
    children.length = 0;
    spawned.mockClear();
  });

  it('checks the repository, puts the newest backup back, and records what that proved', async () => {
    const db = fakeDb();
    db.rows.set('backups', [recordedBackup([...dumps.map((dump) => dump.content), ...RESTIC_CONTENTS])]);
    const target = fakeTarget();
    const revokeEvery = vi.fn(async () => 3);
    const revokeEveryCapability = vi.fn(async () => 6);
    const handler = restoreRehearsalOn(
      options({ db, target, sessions: { revokeEvery }, capabilities: { revokeEvery: revokeEveryCapability } }),
    );

    const running = handler(job(), new AbortController().signal);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(1));
    children[0]?.emit('close', 0);

    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(2));
    const restored = await restoreInto(1);
    children[1]?.emit('close', 0);

    await expect(running).resolves.toBeUndefined();

    expect(spawned).toHaveBeenNthCalledWith(
      1,
      'restic',
      ['check', '--repo', '/data/holydeck/restic', '--read-data-subset=5%'],
      LAUNCHED,
    );
    expect(spawned).toHaveBeenNthCalledWith(
      2,
      'restic',
      ['restore', 'mongo-snap', '--repo', '/data/holydeck/restic', '--json', '--target', restored],
      LAUNCHED,
    );

    expect(revokeEvery).toHaveBeenCalledOnce();
    expect(revokeEveryCapability).toHaveBeenCalledOnce();
    const rehearsals = db.rows.get('restores') ?? [];
    expect(rehearsals).toHaveLength(1);
    expect(rehearsals[0]).toMatchObject({
      restoreId: 'restore-fixed',
      backupId: 'backup-fixed',
      integrity: { verifiedBeforeRestore: true, mismatchAborts: true },
      restore: {
        sessionsInvalidated: true,
        sessionsInvalidatedCount: 3,
        capabilitiesInvalidated: true,
        capabilitiesInvalidatedCount: 6,
        rollback: { verified: true },
      },
    });
    // Rolled back: the rehearsal target is left holding what it held before, which was nothing.
    expect(target.rows.get('services') ?? []).toEqual([]);
    // And the directory the archive was restored into is not left behind on the worker's disk.
    expect(existsSync(restored)).toBe(false);
  });

  it('refuses when this deployment has never recorded a backup to rehearse', async () => {
    const handler = restoreRehearsalOn(options());
    await expect(handler(job(), new AbortController().signal)).rejects.toThrow(
      'there is no recorded backup to rehearse a restore of',
    );
    expect(spawned).not.toHaveBeenCalled();
  });

  it('refuses a backup whose manifest names no snapshot holding the Mongo archive', async () => {
    const db = fakeDb();
    db.rows.set('backups', [recordedBackup(dumps.map((dump) => dump.content))]);
    const handler = restoreRehearsalOn(options({ db }));

    await expect(handler(job(), new AbortController().signal)).rejects.toThrow(
      'backup-fixed: no snapshot holds the mongo archive',
    );
    expect(spawned).not.toHaveBeenCalled();
  });

  it('stops before restoring anything when the lease is lost during the repository check', async () => {
    const db = fakeDb();
    db.rows.set('backups', [recordedBackup([...dumps.map((dump) => dump.content), ...RESTIC_CONTENTS])]);
    const stopping = new AbortController();
    const handler = restoreRehearsalOn(options({ db }));

    const running = handler(job(), stopping.signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalledTimes(1));
    stopping.abort();
    children[0]?.emit('close', 0);

    await expect(running).rejects.toThrow('restore rehearsal stopped after its lease was lost');
    expect(spawned).toHaveBeenCalledTimes(1);
    expect(db.rows.get('restores') ?? []).toHaveLength(0);
  });
});
