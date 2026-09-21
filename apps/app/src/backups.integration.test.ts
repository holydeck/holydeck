// Proves invariant 10 against a real MongoDB: a write that lands after the archive's snapshot starts is
// invisible to every content class the archive reads, the one already read and the ones still to come
// alike — not merely absent from the collection it happened to land in. A fake session cannot prove this;
// only a real transaction, on a real replica set, against a write a separate connection actually commits.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { backupContext, backupDb, readMongoArchive } from './backups.js';
import { RECORDS } from './records.js';
import { startTestMongoReplicaSet } from '../test/helpers/mongo.js';

import type { Db, MongoClient } from 'mongodb';
import type { ReplicaSetMongo } from '../test/helpers/mongo.js';

const CONTEXT = backupContext('system', 'req-backup-consistency');

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
let client: MongoClient;
let dumpDir: string;

beforeAll(async () => {
  mongo = await startTestMongoReplicaSet();
  live = mongo.db;
  client = mongo.client;
}, 120_000);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  for (const collection of CONTENT_COLLECTIONS) await live.collection(collection).deleteMany({});
  dumpDir = await mkdtemp(join(tmpdir(), 'holydeck-backups-integration-'));
});

afterEach(async () => {
  await rm(dumpDir, { recursive: true, force: true });
});

describe('reading the Mongo archive inside a real snapshot transaction', () => {
  test('a concurrent write is invisible to a class already read and one not yet read alike', async () => {
    await live.collection<ContentDoc>(RECORDS.services.collection).insertOne({ _id: 'svc-1', name: 'Sunday Gathering' });
    await live.collection<ContentDoc>(RECORDS.runEvents.collection).insertOne({ _id: 'evt-1', kind: 'started' });

    const db = backupDb(client, live);
    const archive = await readMongoArchive(db, CONTEXT, {
      dumpDir,
      afterRead: async (className) => {
        if (className !== 'services') return;
        // Lands after the snapshot has already read `services`, and before the same transaction ever
        // reaches `run-events` — a moment a non-snapshot read could still see land in either collection.
        await live.collection<ContentDoc>(RECORDS.services.collection).insertOne({ _id: 'svc-2', name: 'Concurrent Write' });
        await live.collection<ContentDoc>(RECORDS.runEvents.collection).insertOne({ _id: 'evt-2', kind: 'concurrent' });
      },
    });

    const services = archive.contents.find((content) => content.class === 'services');
    const events = archive.contents.find((content) => content.class === 'run-events');
    expect(services?.count).toBe(1);
    expect(events?.count).toBe(1);

    // The writes did land — proving the invisibility above is the snapshot's doing, not a race this test
    // lost, and not a write that silently failed to commit.
    await expect(live.collection<ContentDoc>(RECORDS.services.collection).countDocuments({})).resolves.toBe(2);
    await expect(live.collection<ContentDoc>(RECORDS.runEvents.collection).countDocuments({})).resolves.toBe(2);
  });

  test('a backup taken after the concurrent write settles carries it, proving the exclusion above was timing, not loss', async () => {
    await live.collection<ContentDoc>(RECORDS.services.collection).insertOne({ _id: 'svc-1', name: 'Sunday Gathering' });
    const db = backupDb(client, live);
    await readMongoArchive(db, CONTEXT, {
      dumpDir,
      afterRead: async (className) => {
        if (className === 'services') await live.collection<ContentDoc>(RECORDS.services.collection).insertOne({ _id: 'svc-2', name: 'Later' });
      },
    });
    const next = await readMongoArchive(db, CONTEXT, { dumpDir });
    const services = next.contents.find((content) => content.class === 'services');
    expect(services?.count).toBe(2);
  });

  test('hashes what a real snapshot actually read, addressably, and dumps the same bytes to disk', async () => {
    await live.collection<ContentDoc>(RECORDS.services.collection).insertMany([
      { _id: 'svc-1', name: 'Sunday Gathering' },
      { _id: 'svc-2', name: 'Wednesday Study' },
    ]);
    const db = backupDb(client, live);
    const archive = await readMongoArchive(db, CONTEXT, { dumpDir });
    const services = archive.contents.find((content) => content.class === 'services');
    expect(services?.count).toBe(2);
    expect(services?.hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(archive.consistency).toEqual({ pointInTime: true, method: expect.any(String) });

    // Against a real snapshot read, not just a fake: the dump file this archive wrote for `services`
    // rehashes to the exact hash the manifest recorded for it.
    const dumped = await readFile(join(dumpDir, 'services.json'), 'utf8');
    expect(`sha256:${createHash('sha256').update(dumped).digest('hex')}`).toBe(services?.hash);
  });
});
