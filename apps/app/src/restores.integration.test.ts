// The rehearsal against a real MongoDB, because three of the four things it claims are only true of a
// real database: that the archive reconstitutes into a database that is not the one it came from, that
// production is untouched while it does, and that a session held across the restore stops working. A fake
// can be made to agree with all three without any of them being so.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { backupContext, backupDb, finalizeBackup, readMongoArchive } from './backups.js';
import { SCHEMA_VERSION } from './migrations.js';
import { RECORDS } from './records.js';
import { repositoryDb } from './repositories.js';
import {
  RestoreError,
  rehearsalDatabaseName,
  rehearseRestore,
  restoreContext,
  restoreDb,
} from './restores.js';
import { SessionError, sessionContext, sessionDb, sessionsOn } from './sessions.js';
import { startTestMongoReplicaSet } from '../test/helpers/mongo.js';

import type { BackupContent, BackupProduction } from '@holydeck/contracts/backups';
import type { Db, MongoClient } from 'mongodb';
import type { ReplicaSetMongo } from '../test/helpers/mongo.js';
import type { SessionStore } from './sessions.js';

const BACKED_UP_AT = '2026-09-19T02:00:00.000Z';
const STARTED_AT = '2026-09-19T02:10:00.000Z';
const FINISHED_AT = '2026-09-19T02:12:00.000Z';

const BACKUP = backupContext('system', 'req-backup');
const REHEARSAL = restoreContext('system', 'req-rehearsal');
const GATEKEEPER = sessionContext('req-sign-in');

/** A class Restic addresses by snapshot. It rides along in the manifest and is nothing this module rehashes. */
const RESTIC_CONTENT: BackupContent = { class: 'settings', count: 1, bytes: 512, hash: 'restic:1a2b3c' };

interface ContentDoc {
  readonly _id: string;
  readonly [field: string]: unknown;
}

const CONTENT_COLLECTIONS = [
  RECORDS.services.collection,
  RECORDS.contentRevisions.collection,
  RECORDS.preparedSnapshots.collection,
  RECORDS.runEvents.collection,
];

let mongo: ReplicaSetMongo;
let live: Db;
let rehearsal: Db;
let client: MongoClient;
let dumpDir: string;
let store: SessionStore;

beforeAll(async () => {
  mongo = await startTestMongoReplicaSet();
  live = mongo.db;
  client = mongo.client;
  rehearsal = client.db(rehearsalDatabaseName(live.databaseName));
}, 120_000);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  for (const collection of CONTENT_COLLECTIONS) {
    await live.collection(collection).deleteMany({});
    await rehearsal.collection(collection).deleteMany({});
  }
  for (const collection of [RECORDS.backups.collection, RECORDS.restores.collection, RECORDS.auditEvents.collection]) {
    await live.collection(collection).deleteMany({});
  }
  await live.collection('sessions').deleteMany({});
  store = sessionsOn(sessionDb(live), { now: () => STARTED_AT });
  dumpDir = await mkdtemp(join(tmpdir(), 'holydeck-rehearsal-integration-'));
});

afterEach(async () => {
  await rm(dumpDir, { recursive: true, force: true });
});

/** Takes a real backup of whatever `live` holds right now, through the same path a backup run uses. */
const takeBackup = async (): Promise<BackupProduction> => {
  const archive = await readMongoArchive(backupDb(client, live), BACKUP, { dumpDir });
  return finalizeBackup(
    repositoryDb(live),
    BACKUP,
    { mongoContents: archive.contents, otherContents: [RESTIC_CONTENT], consistency: archive.consistency },
    { now: () => BACKED_UP_AT, schemaVersion: SCHEMA_VERSION },
  );
};

const clockOf = (...instants: readonly string[]) => {
  let at = 0;
  return (): string => instants[Math.min(at++, instants.length - 1)] as string;
};

const rehearse = async (production: BackupProduction, afterRestore?: () => Promise<void>) =>
  rehearseRestore(repositoryDb(live), REHEARSAL, production, {
    restoredRoot: dumpDir,
    target: restoreDb(rehearsal),
    sessions: store,
    now: clockOf(STARTED_AT, FINISHED_AT),
    schemaVersion: SCHEMA_VERSION,
    ...(afterRestore === undefined ? {} : { afterRestore }),
  });

describe('rehearsing a restore against a real database', () => {
  test('reconstitutes the archive somewhere that is not production, and ends the sessions that predate it', async () => {
    await live.collection<ContentDoc>(RECORDS.services.collection).insertOne({ _id: 'svc-1', name: 'Sunday Gathering' });
    await live.collection<ContentDoc>(RECORDS.runEvents.collection).insertOne({ _id: 'evt-1', kind: 'started' });
    const production = await takeBackup();

    // Held across the restore. After it, the world this token has authority over no longer exists.
    const session = await store.start(GATEKEEPER, { actor: 'account:1', permissions: ['services.read'] });
    await expect(store.read(GATEKEEPER, session.token)).resolves.toMatchObject({ actor: 'account:1' });

    // Something else entirely in the rehearsal database, so a restore that did nothing would be visible.
    await rehearsal.collection<ContentDoc>(RECORDS.services.collection).insertOne({ _id: 'svc-9', name: 'Left Over' });

    let observed: { services: number; production: number; rejected: string } | undefined;
    const { manifest, sessionsEnded } = await rehearse(production, async () => {
      observed = {
        services: await rehearsal.collection<ContentDoc>(RECORDS.services.collection).countDocuments({ _id: 'svc-1' }),
        production: await live.collection(RECORDS.services.collection).countDocuments({}),
        rejected: await store
          .read(GATEKEEPER, session.token)
          .then(() => 'still valid')
          .catch((error: unknown) => (error instanceof SessionError ? error.kind : 'other')),
      };
    });

    expect(observed).toEqual({ services: 1, production: 1, rejected: 'unknown' });
    expect(sessionsEnded).toBe(1);
    expect(manifest.restore.sessionsInvalidatedCount).toBe(1);
    expect(manifest.objectives.measured).toEqual({ rpoMinutes: 10, rtoMinutes: 2 });
    expect(manifest.restore.rollback.verified).toBe(true);

    // Production never held the archive's rows put back over it, and the rehearsal database is as found.
    await expect(live.collection(RECORDS.services.collection).countDocuments({})).resolves.toBe(1);
    const left = await rehearsal.collection(RECORDS.services.collection).find({}).toArray();
    expect(left.map((row) => row['_id'])).toEqual(['svc-9']);

    const recorded = await live.collection(RECORDS.restores.collection).find({}).toArray();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ backupId: production.manifest.id, at: FINISHED_AT });
  });

  test('a deliberately corrupted archive stops the restore before it touches the target', async () => {
    await live.collection<ContentDoc>(RECORDS.services.collection).insertOne({ _id: 'svc-1', name: 'Sunday Gathering' });
    const production = await takeBackup();
    await rehearsal.collection<ContentDoc>(RECORDS.services.collection).insertOne({ _id: 'svc-9', name: 'Left Over' });

    await writeFile(join(dumpDir, 'services.json'), '[{"_id":"svc-1","name":"Tampered With"}]', 'utf8');
    const session = await store.start(GATEKEEPER, { actor: 'account:1', permissions: ['services.read'] });

    await expect(rehearse(production)).rejects.toMatchObject({ name: 'RestoreError', kind: 'integrity' });

    const left = await rehearsal.collection(RECORDS.services.collection).find({}).toArray();
    expect(left.map((row) => row['name'])).toEqual(['Left Over']);
    // The session survives a rehearsal that never happened — ending one is part of a restore, not of trying.
    await expect(store.read(GATEKEEPER, session.token)).resolves.toMatchObject({ actor: 'account:1' });
    await expect(live.collection(RECORDS.restores.collection).countDocuments({})).resolves.toBe(0);
  });

  test('will not rehearse into the database it is rehearsing for', () => {
    expect(() => rehearsalDatabaseName(rehearsal.databaseName)).toThrow(RestoreError);
    expect(rehearsalDatabaseName(live.databaseName)).toBe(rehearsal.databaseName);
    expect(rehearsal.databaseName).not.toBe(live.databaseName);
  });
});
