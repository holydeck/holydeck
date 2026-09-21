import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { CONSISTENCY_METHOD, EXCLUDED_SECRETS, MONGO_CONTENTS, archiveEntryOf } from './backups.js';
import { requestContext } from './context.js';
import { RECORDS, permissionsFor } from './records.js';
import {
  INTEGRITY_ALGORITHM,
  RECOVERY_OBJECTIVES,
  RESTORE_RECORD,
  RestoreError,
  rehearsalDatabaseName,
  rehearseRestore,
  restoreContext,
  verifyMongoArchive,
} from './restores.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { BackupContent, BackupProduction } from '@holydeck/contracts/backups';
import type { Document } from './repositories.js';
import type { RehearsalOptions, RestoreCapabilities, RestoreCollection, RestoreDb, RestoreSessions } from './restores.js';

const CREATED_AT = '2026-09-19T02:00:00.000Z';
const STARTED_AT = '2026-09-19T02:30:00.000Z';
const FINISHED_AT = '2026-09-19T02:33:00.000Z';

const CONTEXT = restoreContext('operator', 'rehearsal-1');

/** The classes worth seeding with something; every other class is archived empty, and is still a class. */
const SEEDED: Readonly<Record<string, readonly Document[]>> = {
  services: [{ _id: 'service:1', title: 'Sunday morning' }],
  'content-revisions': [{ _id: 'revision:1', body: 'a verse' }],
  'prepared-snapshots': [],
  'run-events': [{ _id: 'event:1' }, { _id: 'event:2' }],
};

/** Every class an archive has to put back, taken from the census so a new class is covered by adding it. */
const ARCHIVED: Readonly<Record<string, readonly Document[]>> = Object.fromEntries(
  MONGO_CONTENTS.map((content) => [content.class, SEEDED[content.class] ?? []]),
);

/** A content class Restic addresses by snapshot rather than by digest — never rehashed, deliberately. */
const RESTIC_CONTENT: BackupContent = { class: 'settings', count: 1, bytes: 512, hash: 'restic:9f2c1b' };

/** Writes a dump exactly as a backup run would have, and answers the contents a manifest would record. */
const archiveIn = async (
  dir: string,
  classes: Readonly<Record<string, readonly Document[]>> = ARCHIVED,
): Promise<readonly BackupContent[]> => {
  await mkdir(dir, { recursive: true });
  const contents: BackupContent[] = [];
  for (const [className, documents] of Object.entries(classes)) {
    const { content, text } = archiveEntryOf(className, documents);
    await writeFile(join(dir, `${className}.json`), text, 'utf8');
    contents.push(content);
  }
  return contents;
};

const productionOf = (contents: readonly BackupContent[], createdAt = CREATED_AT): BackupProduction => ({
  manifest: {
    id: 'backup-2026-09-19T02-00-00Z',
    createdAt,
    schemaVersion: 19,
    contents: [...contents, RESTIC_CONTENT],
    excludedSecrets: EXCLUDED_SECRETS,
  },
  consistency: { pointInTime: true, method: CONSISTENCY_METHOD },
});

interface FakeTarget extends RestoreDb {
  readonly rows: Map<string, Document[]>;
  /** Lets a test injure the write-back the rollback depends on, which is the only way to fail one honestly. */
  onInsert?: (collection: string, documents: readonly Document[]) => readonly Document[];
}

const fakeTarget = (seed: Readonly<Record<string, readonly Document[]>> = {}, log: string[] = []): FakeTarget => {
  const rows = new Map<string, Document[]>(Object.entries(seed).map(([name, held]) => [name, [...held]]));
  const target: FakeTarget = {
    rows,
    collection(name: string): RestoreCollection {
      const held = (): Document[] => {
        const stored = rows.get(name) ?? [];
        rows.set(name, stored);
        return stored;
      };
      return {
        find: () => ({ toArray: async () => held().map((row) => ({ ...row })) }),
        async deleteMany() {
          const stored = held();
          const deletedCount = stored.length;
          stored.length = 0;
          log.push(`clear ${name}`);
          return { deletedCount };
        },
        async insertMany(documents: readonly Document[]) {
          const kept = target.onInsert?.(name, documents) ?? documents;
          held().push(...kept.map((row) => ({ ...row })));
          log.push(`write ${name}`);
          return { insertedCount: kept.length };
        },
      };
    },
  };
  return target;
};

const fakeSessions = (log: string[] = []): RestoreSessions => ({
  async revokeEvery() {
    log.push('end every session');
    return 4;
  },
});

const fakeCapabilities = (log: string[] = []): RestoreCapabilities => ({
  async revokeEvery() {
    log.push('revoke every capability');
    return 6;
  },
});

/** Hands out each instant in turn and then repeats the last, so a test names only the ones it cares about. */
const clockOf = (...instants: readonly string[]) => {
  let at = 0;
  return (): string => instants[Math.min(at++, instants.length - 1)] as string;
};

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holydeck-rehearsal-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const optionsFor = (over: Partial<RehearsalOptions> = {}): RehearsalOptions => ({
  restoredRoot: root,
  target: fakeTarget(),
  sessions: fakeSessions(),
  capabilities: fakeCapabilities(),
  now: clockOf(STARTED_AT, FINISHED_AT),
  schemaVersion: 19,
  ...over,
});

const refusal = async (run: () => Promise<unknown>): Promise<RestoreError> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof RestoreError) return error;
    throw error;
  }
  throw new Error('the call was expected to be refused');
};

describe('verifying an archive before a byte of it is restored', () => {
  test('reads every class back when the dump is the one the manifest hashed', async () => {
    const production = productionOf(await archiveIn(root));
    const verified = await verifyMongoArchive(root, production);
    expect(verified.map((entry) => entry.class)).toEqual(MONGO_CONTENTS.map((pair) => pair.class));
    expect(verified.find((entry) => entry.class === 'run-events')?.documents).toEqual(ARCHIVED['run-events']);
    expect(verified.find((entry) => entry.class === 'prepared-snapshots')?.documents).toEqual([]);
  });

  // The whole point of recording a digest: bytes that changed after the manifest was written are bytes
  // nothing should be restored from, whether they rotted on the disk or somebody edited them.
  test('refuses a dump whose bytes changed after the manifest recorded them', async () => {
    const production = productionOf(await archiveIn(root));
    const dump = join(root, 'services.json');
    const held = JSON.parse(await readFile(dump, 'utf8')) as Document[];
    await writeFile(dump, JSON.stringify([...held, { _id: 'service:2', title: 'smuggled in' }]), 'utf8');

    const error = await refusal(() => verifyMongoArchive(root, production));
    expect(error.kind).toBe('integrity');
    expect(error.message).toContain('services');
    expect(error.message).toContain('does not match');
  });

  test('refuses an archive that is missing a class it has to put back', async () => {
    const production = productionOf(await archiveIn(root));
    await rm(join(root, 'run-events.json'));
    const error = await refusal(() => verifyMongoArchive(root, production));
    expect(error.kind).toBe('archive');
  });

  test('refuses a manifest that never inventoried a class the archive has to put back', async () => {
    const contents = await archiveIn(root);
    const production = productionOf(contents.filter((content) => content.class !== 'services'));
    const error = await refusal(() => verifyMongoArchive(root, production));
    expect(error.kind).toBe('archive');
    expect(error.message).toContain('services');
  });

  // Restic puts a snapshot back under the absolute path it was taken from, so where the dump lands is
  // whatever the repository remembers rather than the directory the restore was pointed at.
  test('finds the dump wherever the archive put it back', async () => {
    const buried = join(root, 'var', 'lib', 'holydeck', 'dump');
    const production = productionOf(await archiveIn(buried));
    const verified = await verifyMongoArchive(root, production);
    expect(verified).toHaveLength(MONGO_CONTENTS.length);
  });

  test('refuses a restored tree holding no dump at all', async () => {
    const production = productionOf(await archiveIn(join(root, 'elsewhere')));
    await rm(join(root, 'elsewhere'), { recursive: true });
    await mkdir(join(root, 'empty'), { recursive: true });
    const error = await refusal(() => verifyMongoArchive(root, production));
    expect(error.kind).toBe('archive');
  });

  // `restic:<snapshot>` is an address, not a digest — there is nothing in it to rehash. A verifier that
  // pretended otherwise would either refuse every real archive or quietly prove nothing.
  test('leaves the snapshot-addressed classes to the repository that addresses them', async () => {
    const production = productionOf(await archiveIn(root));
    const verified = await verifyMongoArchive(root, production);
    expect(verified.map((entry) => entry.class)).not.toContain('settings');
  });
});

describe('a timed restore rehearsal', () => {
  test('puts every archived class into the isolated target', async () => {
    const production = productionOf(await archiveIn(root));
    const target = fakeTarget();
    await rehearseRestore(fakeDb(), CONTEXT, production, optionsFor({ target }));
    // Rolled back afterwards, which is what the rehearsal is: the observation hook below is where a test
    // sees the restored world, and this is what the target is left as.
    expect(target.rows.get('services')).toEqual([]);
  });

  test('lets an observer see the restored world, with every session already ended and every capability revoked', async () => {
    const production = productionOf(await archiveIn(root));
    const target = fakeTarget({ services: [{ _id: 'service:9', title: 'whatever was there' }] });
    const log: string[] = [];
    const seen: Document[][] = [];
    await rehearseRestore(
      fakeDb(),
      CONTEXT,
      production,
      optionsFor({
        target,
        sessions: fakeSessions(log),
        capabilities: fakeCapabilities(log),
        afterRestore: async () => {
          seen.push(await target.collection('services').find({}).toArray());
          log.push('observed');
        },
      }),
    );
    expect(seen[0]).toEqual([{ _id: 'service:1', title: 'Sunday morning' }]);
    expect(log).toEqual(['end every session', 'revoke every capability', 'observed']);
  });

  test('ends every session and revokes every capability before anything observes the restored world', async () => {
    const production = productionOf(await archiveIn(root));
    const log: string[] = [];
    await rehearseRestore(
      fakeDb(),
      CONTEXT,
      production,
      optionsFor({ target: fakeTarget({}, log), sessions: fakeSessions(log), capabilities: fakeCapabilities(log) }),
    );
    expect(log.indexOf('end every session')).toBeGreaterThan(log.indexOf('write services'));
    expect(log.indexOf('revoke every capability')).toBeGreaterThan(log.indexOf('end every session'));
    expect(log.filter((step) => step === 'end every session')).toHaveLength(1);
    expect(log.filter((step) => step === 'revoke every capability')).toHaveLength(1);
  });

  test('records what the recovery cost, measured rather than assumed', async () => {
    const production = productionOf(await archiveIn(root));
    const { manifest } = await rehearseRestore(fakeDb(), CONTEXT, production, optionsFor());
    expect(manifest.objectives).toEqual({
      ...RECOVERY_OBJECTIVES,
      measured: { rpoMinutes: 30, rtoMinutes: 3 },
    });
    expect(manifest.integrity).toEqual({
      verifiedBeforeRestore: true,
      algorithm: INTEGRITY_ALGORITHM,
      mismatchAborts: true,
    });
    expect(manifest.restore.sessionsInvalidated).toBe(true);
    // The count, not only the fact: a rehearsal that ended four sessions and one that found none to end
    // are different things to have proved, and the flag alone reads the same for both.
    expect(manifest.restore.sessionsInvalidatedCount).toBe(4);
    expect(manifest.restore.capabilitiesInvalidated).toBe(true);
    expect(manifest.restore.capabilitiesInvalidatedCount).toBe(6);
    expect(manifest.restore.rollback.verified).toBe(true);
    expect(manifest.restore.rollback.verifiedOn).toBe('2026-09-19');
    expect(manifest.manifest.id).toBe(production.manifest.id);
  });

  test('refuses a rehearsal whose recovery time missed the objective it is held to', async () => {
    const production = productionOf(await archiveIn(root));
    const error = await refusal(() =>
      rehearseRestore(fakeDb(), CONTEXT, production, optionsFor({ now: clockOf(STARTED_AT, '2026-09-19T08:00:00.000Z') })),
    );
    expect(error.kind).toBe('objective');
    expect(error.message).toContain('recovery time');
    expect(error.message).toContain(String(RECOVERY_OBJECTIVES.rtoMinutes));
  });

  // How old the newest backup is was decided by the backup cadence, not by this restore, so a rehearsal
  // of a backup older than the recovery-point target records the figure and carries on: refusing here
  // would report "the restore does not work" for something the restore had no part in.
  test('records a recovery point older than the objective rather than refusing the rehearsal', async () => {
    const db = fakeDb();
    const production = productionOf(await archiveIn(root), '2026-09-17T00:00:00.000Z');
    const { manifest } = await rehearseRestore(db, CONTEXT, production, optionsFor());
    expect(manifest.objectives.measured.rpoMinutes).toBeGreaterThan(RECOVERY_OBJECTIVES.rpoMinutes);
    expect(manifest.objectives.measured.rpoMinutes).toBe(3030);
    expect(db.rows.get(RECORDS[RESTORE_RECORD].collection) ?? []).toHaveLength(1);
  });

  // Failure injection: the mismatch has to stop the restore, not be noted while it carries on.
  test('aborts before writing a byte when the archive does not match the manifest', async () => {
    const production = productionOf(await archiveIn(root));
    await writeFile(join(root, 'run-events.json'), '[]', 'utf8');
    const target = fakeTarget({ services: [{ _id: 'service:9', title: 'still here' }] });
    const log: string[] = [];

    const error = await refusal(() =>
      rehearseRestore(
        fakeDb(),
        CONTEXT,
        production,
        optionsFor({ target, sessions: fakeSessions(log), capabilities: fakeCapabilities(log) }),
      ),
    );
    expect(error.kind).toBe('integrity');
    expect(target.rows.get('services')).toEqual([{ _id: 'service:9', title: 'still here' }]);
    expect(log).toEqual([]);
  });

  test('puts the target back exactly as it found it, and says so only once it has checked', async () => {
    const production = productionOf(await archiveIn(root));
    const before = {
      services: [{ _id: 'service:9', title: 'still here' }],
      run_events: [{ _id: 'event:9', runId: 'run:9' }],
    };
    const target = fakeTarget(before);
    const { manifest } = await rehearseRestore(fakeDb(), CONTEXT, production, optionsFor({ target }));
    expect(target.rows.get('services')).toEqual(before.services);
    expect(target.rows.get('run_events')).toEqual(before.run_events);
    expect(manifest.restore.rollback.plan).toMatch(/\S/u);
  });

  test('refuses when the rollback did not put back what it took away', async () => {
    const production = productionOf(await archiveIn(root));
    const target = fakeTarget({ services: [{ _id: 'service:9', title: 'still here' }] });
    let restored = false;
    target.onInsert = (collection, documents) => {
      if (collection !== 'services') return documents;
      if (!restored) {
        restored = true;
        return documents;
      }
      return [];
    };
    const error = await refusal(() => rehearseRestore(fakeDb(), CONTEXT, production, optionsFor({ target })));
    expect(error.kind).toBe('rollback');
    expect(error.message).toContain('services');
  });
});

describe('what a rehearsal leaves behind', () => {
  test('records the whole manifest as one immutable row', async () => {
    const db = fakeDb();
    const production = productionOf(await archiveIn(root));
    const { restoreId, manifest } = await rehearseRestore(db, CONTEXT, production, optionsFor());
    const rows = db.rows.get(RECORDS[RESTORE_RECORD].collection) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      restoreId,
      backupId: production.manifest.id,
      at: FINISHED_AT,
      actor: CONTEXT.actor,
      correlationId: CONTEXT.correlationId,
      integrity: manifest.integrity,
      objectives: manifest.objectives,
      restore: manifest.restore,
    });
    expect(rows[0]).toMatchObject({ restore: { sessionsInvalidatedCount: 4, capabilitiesInvalidatedCount: 6 } });
  });

  test('audits the rehearsal with the figures it measured', async () => {
    const db = fakeDb();
    await rehearseRestore(db, CONTEXT, productionOf(await archiveIn(root)), optionsFor());
    const audited = db.rows.get(RECORDS.auditEvents.collection) ?? [];
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ action: 'restore.run', outcome: 'allowed' });
    expect(String(audited[0]?.['detail'])).toContain('30');
    expect(String(audited[0]?.['detail'])).toContain('capabilities revoked');
  });

  test('audits a refusal too, because a rehearsal that failed is the one worth finding later', async () => {
    const db = fakeDb();
    const production = productionOf(await archiveIn(root));
    await writeFile(join(root, 'services.json'), '[]', 'utf8');
    await refusal(() => rehearseRestore(db, CONTEXT, production, optionsFor()));
    const audited = db.rows.get(RECORDS.auditEvents.collection) ?? [];
    expect(audited[0]).toMatchObject({ action: 'restore.run', outcome: 'refused' });
    expect(db.rows.get(RECORDS[RESTORE_RECORD].collection) ?? []).toEqual([]);
  });

  test('refuses an actor who may not record one', async () => {
    const production = productionOf(await archiveIn(root));
    const reader = requestContext({
      actor: 'operator',
      permissions: [permissionsFor(RESTORE_RECORD).read],
      correlationId: 'rehearsal-1',
    });
    const error = await refusal(() => rehearseRestore(fakeDb(), reader, production, optionsFor()));
    expect(error.kind).toBe('permission');
  });

  test('refuses a context that is not one', async () => {
    const production = productionOf(await archiveIn(root));
    const error = await refusal(() => rehearseRestore(fakeDb(), { actor: '' }, production, optionsFor()));
    expect(error.kind).toBe('context');
  });
});

describe('the database a rehearsal restores into', () => {
  test('is named after the one it is rehearsing for, never the one itself', () => {
    expect(rehearsalDatabaseName('holydeck')).not.toBe('holydeck');
    expect(rehearsalDatabaseName('holydeck')).toContain('holydeck');
  });

  test('refuses to rehearse into a rehearsal, which is how a name gets reused by accident', () => {
    const once = rehearsalDatabaseName('holydeck');
    expect(() => rehearsalDatabaseName(once)).toThrow(RestoreError);
  });

  test('refuses a database with no name', () => {
    expect(() => rehearsalDatabaseName('')).toThrow(RestoreError);
  });
});
