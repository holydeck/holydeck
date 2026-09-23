import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BACKUP_INDEXES,
  BackupError,
  CONSISTENCY_METHOD,
  EXCLUDED_RECORDS,
  EXCLUDED_SECRETS,
  MONGO_CONTENTS,
  backupContext,
  censusProblems,
  finalizeBackup,
  readMongoArchive,
  recordedBackups,
} from './backups.js';
import { requestContext } from './context.js';
import { RECORDS, RECORD_NAMES } from './records.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { BackupContent, BackupConsistency } from '@holydeck/contracts/backups';
import type { BackupCollection, BackupDb, BackupSession, ExcludedRecord, MongoContent } from './backups.js';
import type { RecordName } from './records.js';
import type { Document } from './repositories.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const AT = '2026-09-19T02:00:00.000Z';
const CORRELATION = 'req-0f9c2a41';

const CONTEXT = backupContext('system', CORRELATION);

const NO_PERMISSION = requestContext({ actor: 'system', permissions: [], correlationId: CORRELATION });

interface FakeMongoDb extends BackupDb {
  readonly transactions: number;
  readonly sessionsEnded: number;
}

/**
 * Enough of a session-aware Mongo database to prove `readMongoArchive` reads inside one transaction: a
 * document seeded into a collection after the transaction starts is invisible for the rest of that read,
 * which is exactly the isolation a snapshot transaction promises and a stub without one could not prove.
 */
function fakeMongoDb(seed: Readonly<Record<string, Document[]>>): FakeMongoDb {
  const rows = new Map(Object.entries(seed).map(([name, docs]) => [name, [...docs]]));
  let transactions = 0;
  let sessionsEnded = 0;
  const db: FakeMongoDb = {
    get transactions() {
      return transactions;
    },
    get sessionsEnded() {
      return sessionsEnded;
    },
    collection(name: string): BackupCollection {
      return {
        find(_filter, options) {
          expect(options.session).toBeDefined();
          const snapshot = [...(rows.get(name) ?? [])];
          return { toArray: async () => snapshot };
        },
      };
    },
    startSession(): BackupSession {
      return {
        async withTransaction(fn, options) {
          expect(options).toEqual({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
          transactions += 1;
          return fn();
        },
        async endSession() {
          sessionsEnded += 1;
        },
      };
    },
  };
  return db;
}

const backupsOf = (db: FakeDb) => db.rows.get(RECORDS.backups.collection) ?? [];

const auditsOf = (db: FakeDb) => db.rows.get(RECORDS.auditEvents.collection) ?? [];

const consistency: BackupConsistency = { pointInTime: true, method: CONSISTENCY_METHOD };

describe('the context a backup run needs', () => {
  it('grants exactly enough to produce, read and audit one backup', () => {
    expect(CONTEXT.permissions).toEqual(
      expect.arrayContaining(['backups.append', 'backups.read', 'auditEvents.append']),
    );
  });
});

describe('reading the Mongo archive', () => {
  let dumpDir: string;

  beforeEach(async () => {
    dumpDir = await mkdtemp(join(tmpdir(), 'holydeck-backups-test-'));
  });

  afterEach(async () => {
    await rm(dumpDir, { recursive: true, force: true });
  });

  it('refuses an actor without the permission to produce a backup', async () => {
    const db = fakeMongoDb({});
    await expect(readMongoArchive(db, NO_PERMISSION, { dumpDir })).rejects.toThrow(BackupError);
  });

  it('refuses a value that is not a request context at all', async () => {
    const db = fakeMongoDb({});
    await expect(readMongoArchive(db, undefined, { dumpDir })).rejects.toThrow(BackupError);
  });

  it('reads every Mongo content class inside one snapshot transaction, and dumps each class to disk exactly as hashed', async () => {
    const db = fakeMongoDb({
      [RECORDS.services.collection]: [{ _id: 's1' }],
      [RECORDS.contentRevisions.collection]: [{ _id: 'r1' }, { _id: 'r2' }],
      [RECORDS.preparedSnapshots.collection]: [],
      [RECORDS.runEvents.collection]: [{ _id: 'e1' }],
    });
    const archive = await readMongoArchive(db, CONTEXT, { dumpDir });
    expect(archive.consistency).toEqual({ pointInTime: true, method: CONSISTENCY_METHOD });
    expect(archive.contents.map((content) => content.class)).toEqual(MONGO_CONTENTS.map((content) => content.class));
    const services = archive.contents.find((content) => content.class === 'services') as BackupContent;
    expect(services.count).toBe(1);
    expect(services.hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const snapshots = archive.contents.find((content) => content.class === 'prepared-snapshots') as BackupContent;
    expect(snapshots.count).toBe(0);
    expect(db.transactions).toBe(1);
    expect(db.sessionsEnded).toBe(1);

    // Every dump file holds exactly the bytes its class's hash was computed over: rehashing what actually
    // landed on disk reproduces the manifest's recorded hash, not merely a value that happens to agree
    // because both sides were computed the same way.
    for (const content of archive.contents) {
      const text = await readFile(join(dumpDir, `${content.class}.json`), 'utf8');
      expect(`sha256:${createHash('sha256').update(text).digest('hex')}`).toBe(content.hash);
    }
    const dumpedServices = await readFile(join(dumpDir, 'services.json'), 'utf8');
    expect(dumpedServices).toBe(JSON.stringify([{ _id: 's1' }]));
  });

  it('ends the session even when the read fails partway through', async () => {
    const db = fakeMongoDb({});
    const failing: FakeMongoDb = {
      ...db,
      collection: () => {
        throw new Error('the archive collection is unreachable');
      },
    };
    await expect(readMongoArchive(failing, CONTEXT, { dumpDir })).rejects.toThrow('unreachable');
    expect(db.sessionsEnded).toBe(1);
  });

  it('hashes the same documents to the same value however they were ordered on the wire', async () => {
    const first = fakeMongoDb({ [RECORDS.services.collection]: [{ _id: 's1', name: 'Sunday', kind: 'weekly' }] });
    const second = fakeMongoDb({ [RECORDS.services.collection]: [{ kind: 'weekly', _id: 's1', name: 'Sunday' }] });
    const [dumpA, dumpB] = await Promise.all([
      mkdtemp(join(tmpdir(), 'holydeck-backups-test-a-')),
      mkdtemp(join(tmpdir(), 'holydeck-backups-test-b-')),
    ]);
    try {
      const [archiveA, archiveB] = await Promise.all([
        readMongoArchive(first, CONTEXT, { dumpDir: dumpA }),
        readMongoArchive(second, CONTEXT, { dumpDir: dumpB }),
      ]);
      const hashA = archiveA.contents.find((content) => content.class === 'services')?.hash;
      const hashB = archiveB.contents.find((content) => content.class === 'services')?.hash;
      expect(hashA).toBe(hashB);
    } finally {
      await Promise.all([rm(dumpA, { recursive: true, force: true }), rm(dumpB, { recursive: true, force: true })]);
    }
  });

  it('calls back between reads, which is what lets a caller prove point-in-time isolation', async () => {
    const db = fakeMongoDb({
      [RECORDS.services.collection]: [],
      [RECORDS.contentRevisions.collection]: [],
      [RECORDS.preparedSnapshots.collection]: [],
      [RECORDS.runEvents.collection]: [],
    });
    const seen: string[] = [];
    await readMongoArchive(db, CONTEXT, {
      dumpDir,
      afterRead: (className) => {
        seen.push(className);
      },
    });
    expect(seen).toEqual(MONGO_CONTENTS.map((content) => content.class));
  });
});

describe('the census of what a backup carries', () => {
  const problemsAmong = (
    records: readonly RecordName[],
    contents: readonly MongoContent[],
    excluded: readonly ExcludedRecord[],
  ): readonly string[] => censusProblems({ records, contents, excluded });

  it('accounts for every record class this deployment ships, one way or the other', () => {
    expect(censusProblems()).toEqual([]);
  });

  it('carries the schema ledger, without which a restored archive says nothing about its own shape', () => {
    expect(MONGO_CONTENTS.map((content) => content.record)).toContain('schemaMigrations');
  });

  it('accounts for every class as either carried or excused, and for no other reason than that', () => {
    expect(EXCLUDED_RECORDS.map((entry) => entry.record)).toEqual(['pptxImportSessions']);
    expect(EXCLUDED_RECORDS[0]?.because.trim()).not.toBe('');
    expect(MONGO_CONTENTS).toHaveLength(RECORD_NAMES.length - EXCLUDED_RECORDS.length);
  });

  it('inventories each class under its own name, so a dump file can be matched back to a collection', () => {
    for (const { record, class: className } of MONGO_CONTENTS) {
      expect(RECORDS[record]).toBeDefined();
      expect(className).toMatch(/^[a-z]+(-[a-z]+)*$/u);
    }
  });

  it('reports a class that is carried by nothing and excused by nothing, which is how one stops being lost', () => {
    const forgotten = MONGO_CONTENTS.filter((content) => content.record !== 'slideLayouts');
    expect(problemsAmong(RECORD_NAMES, forgotten, EXCLUDED_RECORDS)).toEqual([
      'slideLayouts: no backup carries it and nothing says why — inventory it or exclude it with a reason',
    ]);
  });

  it('reports a class that is carried and excused at once, because only one of the two can be acted on', () => {
    expect(
      problemsAmong(RECORD_NAMES, MONGO_CONTENTS, [...EXCLUDED_RECORDS, { record: 'runEvents', because: 'they are noisy' }]),
    ).toEqual(['runEvents: is inventoried and excluded at once, which cannot both be true']);
  });

  it('reports an exclusion that gives no reason, which is the whole of what an exclusion has to give', () => {
    const kept = MONGO_CONTENTS.filter((content) => content.record !== 'runEvents');
    expect(
      problemsAmong(RECORD_NAMES, kept, [...EXCLUDED_RECORDS, { record: 'runEvents', because: '  ' }]),
    ).toEqual(['runEvents: is excluded without saying why']);
  });

  it('reports a class inventoried twice, and two classes sharing one manifest name', () => {
    const doubled = [...MONGO_CONTENTS, { record: 'services', class: 'services' } as const];
    expect(problemsAmong(RECORD_NAMES, doubled, EXCLUDED_RECORDS)).toEqual([
      'one record class is inventoried more than once',
      'two classes are inventoried under one manifest name',
    ]);
  });

  it('reports a class inventoried under a name that is not its own, which a restore could not read back', () => {
    const renamed = MONGO_CONTENTS.map((content) =>
      content.record === 'runEvents' ? { record: content.record, class: 'events' } : content,
    );
    expect(problemsAmong(RECORD_NAMES, renamed, EXCLUDED_RECORDS)).toEqual([
      'runEvents: is inventoried as events rather than run-events, which a restore reads by',
    ]);
  });

  it('reports a class named for something the file half or a withheld secret already answers to', () => {
    const clashing = MONGO_CONTENTS.map((content) =>
      content.record === 'mediaAssets' ? { record: content.record, class: 'media' } : content,
    );
    expect(problemsAmong(RECORD_NAMES, clashing, EXCLUDED_RECORDS)).toEqual([
      'mediaAssets: is inventoried as media rather than media-assets, which a restore reads by',
      'media: is inventoried under a name the file half already uses',
    ]);
  });
});

const mongoContents: readonly BackupContent[] = [
  { class: 'services', count: 1, bytes: 10, hash: 'sha256:aa' },
  { class: 'content-revisions', count: 0, bytes: 2, hash: 'sha256:bb' },
];

const otherContents: readonly BackupContent[] = [
  { class: 'settings', count: 1, bytes: 4, hash: 'sha256:cc' },
  { class: 'media', count: 3, bytes: 900, hash: 'sha256:dd' },
];

describe('finalizing a backup', () => {
  it('refuses an actor without the permission to produce a backup', async () => {
    const db = fakeDb();
    await expect(
      finalizeBackup(db, NO_PERMISSION, { mongoContents, otherContents, consistency }, { now: () => AT, schemaVersion: 19 }),
    ).rejects.toThrow(BackupError);
    expect(backupsOf(db)).toHaveLength(0);
  });

  it('records one backup and one audit entry, naming the manifest it produced', async () => {
    const db = fakeDb();
    const production = await finalizeBackup(
      db,
      CONTEXT,
      { mongoContents, otherContents, consistency },
      { now: () => AT, schemaVersion: 19, newId: () => 'backup-fixed' },
    );
    expect(production.manifest.id).toBe('backup-fixed');
    expect(production.manifest.contents).toEqual([...mongoContents, ...otherContents]);
    expect(production.manifest.excludedSecrets).toEqual(EXCLUDED_SECRETS);
    expect(production.consistency).toEqual(consistency);

    const [stored] = backupsOf(db);
    expect(stored).toMatchObject({
      _id: 'backup:backup-fixed',
      actor: 'system',
      correlationId: CORRELATION,
      backupId: 'backup-fixed',
      at: AT,
    });

    const [audited] = auditsOf(db);
    expect(audited).toMatchObject({
      actor: 'system',
      correlationId: CORRELATION,
      action: 'backup.run',
      subject: 'backup-fixed',
      outcome: 'allowed',
    });
  });

  it('refuses a manifest its own contract would refuse, and writes nothing', async () => {
    const db = fakeDb();
    await expect(
      finalizeBackup(
        db,
        CONTEXT,
        { mongoContents: [], otherContents: [], consistency },
        { now: () => AT, schemaVersion: 19, newId: () => 'backup-empty' },
      ),
    ).rejects.toThrow(BackupError);
    expect(backupsOf(db)).toHaveLength(0);
    expect(auditsOf(db)).toHaveLength(0);
  });

  it('refuses a consistency that is not point-in-time, and writes nothing', async () => {
    const db = fakeDb();
    await expect(
      finalizeBackup(
        db,
        CONTEXT,
        { mongoContents, otherContents, consistency: { pointInTime: false as unknown as true, method: '' } },
        { now: () => AT, schemaVersion: 19, newId: () => 'backup-inconsistent' },
      ),
    ).rejects.toThrow(BackupError);
    expect(backupsOf(db)).toHaveLength(0);
  });

  it('refuses a second backup filed under an identifier already recorded', async () => {
    const db = fakeDb();
    const options = { now: () => AT, schemaVersion: 19, newId: () => 'backup-again' };
    await finalizeBackup(db, CONTEXT, { mongoContents, otherContents, consistency }, options);
    await expect(finalizeBackup(db, CONTEXT, { mongoContents, otherContents, consistency }, options)).rejects.toThrow(
      BackupError,
    );
    expect(backupsOf(db)).toHaveLength(1);
  });
});

describe('the backup index', () => {
  it('orders backups by when they were made, most recent first', () => {
    expect(BACKUP_INDEXES).toEqual([{ name: 'backup_time', keys: { at: -1 }, options: {} }]);
  });
});

describe('reading back what has been backed up', () => {
  const runsOn = async (db: FakeDb): Promise<void> => {
    for (const [day, snapshot] of [
      ['2026-09-17', 'aaa111'],
      ['2026-09-19', 'ccc333'],
      ['2026-09-18', 'bbb222'],
    ] as const) {
      await finalizeBackup(
        db,
        CONTEXT,
        {
          mongoContents,
          otherContents: [{ class: 'settings', count: 1, bytes: 4, hash: `restic:${snapshot}` }],
          consistency,
        },
        { now: () => `${day}T02:00:00.000Z`, schemaVersion: 19, newId: () => `backup-${day}` },
      );
    }
  };

  it('answers newest-first, whatever order the collection holds them in', async () => {
    const db = fakeDb();
    await runsOn(db);
    const recorded = await recordedBackups(db, CONTEXT);
    expect(recorded.map((run) => run.backupId)).toEqual(['backup-2026-09-19', 'backup-2026-09-18', 'backup-2026-09-17']);
  });

  // Which snapshots a run's restore set spans is read off the manifest rather than stored beside it, so
  // there is exactly one place a run names them and it is the thing a restore would be reading.
  it('names the snapshots each run is spread across, and only those', async () => {
    const db = fakeDb();
    await runsOn(db);
    const [newest] = await recordedBackups(db, CONTEXT);
    expect(newest?.snapshots).toEqual(['ccc333']);
    expect(newest?.production.consistency).toEqual(consistency);
  });

  it('answers with nothing when nothing has been backed up', async () => {
    await expect(recordedBackups(fakeDb(), CONTEXT)).resolves.toEqual([]);
  });
});
