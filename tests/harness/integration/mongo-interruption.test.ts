// Failure injection, specification 14.3's third item: MongoDB itself goes away while a worker holds
// a lease on a running job, and the job recovers once it comes back — the real mongod process is
// stopped and started again, not a fake `db.failOn`. `worker-restart.test.ts` and
// `backup-restart.test.ts` already prove the other two items in that list (an application restart,
// and the lease expiry that makes recovery possible after one); this covers the third, distinct
// failure mode neither of those exercises: the worker process itself never dies here, MongoDB does.
//
// This does not reuse `mongoFor()` from `../src/mongo.js` — that helper starts a `MongoMemoryServer`
// with no way to stop and restart it against the same data. This test manages its own instance
// instead, with two things `mongoFor()` doesn't set: a fixed port (so the connection string a
// worker was handed stays valid across the interruption) and the real `wiredTiger` storage engine
// rather than the library's default `ephemeralForTest` (which does not persist data across a
// process restart at all — with it, the job record this test enqueues would simply vanish when
// MongoDB restarts, and the recovery this test means to prove would never really have been
// exercised).
//
// The interruption is shorter than the job's lease on purpose: the worker that claimed the job
// keeps holding a still-valid lease throughout, so what recovers it is the MongoDB driver's own
// standard server-selection retry, not a second worker reclaiming an expired one. That second path
// — a worker dying, or a lease simply outliving whatever interrupted its holder — is already proven,
// mechanically identically regardless of what caused it, by `worker-restart.test.ts`.

import { queueDb, queueOn } from '@holydeck/app/queue';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { MONGO_VERSION } from '../src/mongo.js';
import { freePort, ready, serve } from '../src/processes.js';

import type { Queue } from '@holydeck/app/queue';
import type { JobRecord } from '@holydeck/contracts/jobs';

const DATABASE = 'harness_mongo_interruption';
const KIND = 'interruption-probe';
const LEASE_MS = 8_000;
const DOWNTIME_MS = 2_000;
const FIXTURE = fileURLToPath(new URL('./mongo-interruption-fixture.ts', import.meta.url));

// The producer's context, which a worker's is not: enqueuing is not something a worker may do.
const CONTEXT = {
  actor: 'system',
  permissions: ['jobs.enqueue', 'jobs.read', 'jobs.run'],
  correlationId: 'harness-mongo-interruption',
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let dbPath: string;
let port: number;
let mongod: MongoMemoryServer;
let client: MongoClient;
let queue: Queue;

beforeAll(async () => {
  dbPath = await mkdtemp(join(tmpdir(), 'holydeck-mongo-interruption-'));
  port = await freePort();
  mongod = new MongoMemoryServer({
    instance: { port, dbPath, portGeneration: false, storageEngine: 'wiredTiger' },
    binary: { version: MONGO_VERSION },
  });
  await mongod.start(true);

  client = new MongoClient(`mongodb://127.0.0.1:${port}`, { serverSelectionTimeoutMS: 20_000 });
  await client.connect();
  queue = queueOn(queueDb(client.db(DATABASE)), {
    now: () => new Date().toISOString(),
    leaseMs: LEASE_MS,
  });
});

afterAll(async () => {
  await client.close();
  await mongod.stop({ doCleanup: false, force: false });
  await rm(dbPath, { recursive: true, force: true });
});

const stored = async (): Promise<JobRecord | undefined> => (await queue.list(CONTEXT, { kinds: [KIND] }))[0];

test('a worker holding a lease survives a real MongoDB restart and finishes its job once it returns', async () => {
  const { id, created } = await queue.enqueue(CONTEXT, {
    kind: KIND,
    idempotencyKey: 'interruption-probe:once',
    retryLimit: 3,
  });
  expect(created).toBe(true);

  const worker = serve(
    [FIXTURE, `mongodb://127.0.0.1:${port}`, DATABASE, 'interruption-worker', KIND, String(LEASE_MS)],
    {},
  );
  await ready(worker, 'interruption fixture', async () => worker.output().includes(`claimed ${id}`));

  // MongoDB goes away while the fixture holds its lease and is about to write back the result — the
  // real process is stopped, not a fake failure the driver never actually has to route around.
  await mongod.stop({ doCleanup: false, force: false });
  await sleep(DOWNTIME_MS);
  await mongod.start(true);

  await worker.stopped();
  expect(worker.output()).toContain(`finished ${id}`);
  expect(worker.exit()).toEqual({ code: 0, signal: null });

  expect(await stored()).toMatchObject({ id, state: 'succeeded', attempt: 1, workers: ['interruption-worker'] });
}, 40_000);
