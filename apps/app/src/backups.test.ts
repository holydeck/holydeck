import { describe, expect, it } from 'vitest';

import {
  BACKUP_INDEXES,
  BackupError,
  CONSISTENCY_METHOD,
  EXCLUDED_SECRETS,
  backupContext,
  finalizeBackup,
  readMongoArchive,
} from './backups.js';
import { requestContext } from './context.js';
import { RECORDS } from './records.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { BackupContent, BackupConsistency } from '@holydeck/contracts/backups';
import type { BackupCollection, BackupDb, BackupSession } from './backups.js';
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
  it('refuses an actor without the permission to produce a backup', async () => {
    const db = fakeMongoDb({});
    await expect(readMongoArchive(db, NO_PERMISSION)).rejects.toThrow(BackupError);
  });

  it('refuses a value that is not a request context at all', async () => {
    const db = fakeMongoDb({});
    await expect(readMongoArchive(db, undefined)).rejects.toThrow(BackupError);
  });

  it('reads every Mongo content class inside one snapshot transaction', async () => {
    const db = fakeMongoDb({
      [RECORDS.services.collection]: [{ _id: 's1' }],
      [RECORDS.contentRevisions.collection]: [{ _id: 'r1' }, { _id: 'r2' }],
      [RECORDS.preparedSnapshots.collection]: [],
      [RECORDS.runEvents.collection]: [{ _id: 'e1' }],
    });
    const archive = await readMongoArchive(db, CONTEXT);
    expect(archive.consistency).toEqual({ pointInTime: true, method: CONSISTENCY_METHOD });
    expect(archive.contents.map((content) => content.class)).toEqual([
      'services',
      'content-revisions',
      'prepared-snapshots',
      'run-events',
    ]);
    const services = archive.contents.find((content) => content.class === 'services') as BackupContent;
    expect(services.count).toBe(1);
    expect(services.hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const snapshots = archive.contents.find((content) => content.class === 'prepared-snapshots') as BackupContent;
    expect(snapshots.count).toBe(0);
    expect(db.transactions).toBe(1);
    expect(db.sessionsEnded).toBe(1);
  });

  it('ends the session even when the read fails partway through', async () => {
    const db = fakeMongoDb({});
    const failing: FakeMongoDb = {
      ...db,
      collection: () => {
        throw new Error('the archive collection is unreachable');
      },
    };
    await expect(readMongoArchive(failing, CONTEXT)).rejects.toThrow('unreachable');
    expect(db.sessionsEnded).toBe(1);
  });

  it('hashes the same documents to the same value however they were ordered on the wire', async () => {
    const first = fakeMongoDb({ [RECORDS.services.collection]: [{ _id: 's1', name: 'Sunday', kind: 'weekly' }] });
    const second = fakeMongoDb({ [RECORDS.services.collection]: [{ kind: 'weekly', _id: 's1', name: 'Sunday' }] });
    const [archiveA, archiveB] = await Promise.all([readMongoArchive(first, CONTEXT), readMongoArchive(second, CONTEXT)]);
    const hashA = archiveA.contents.find((content) => content.class === 'services')?.hash;
    const hashB = archiveB.contents.find((content) => content.class === 'services')?.hash;
    expect(hashA).toBe(hashB);
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
      afterRead: (className) => {
        seen.push(className);
      },
    });
    expect(seen).toEqual(['services', 'content-revisions', 'prepared-snapshots', 'run-events']);
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
