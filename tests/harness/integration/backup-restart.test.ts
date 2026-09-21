// Failure injection for T100's third and fourth requirements: a backup producer is a leased job like any
// other, so the T22 recovery semantics `worker-restart.test.ts` proves generically have to hold for the
// real `backup-run` kind this build registers a handler for, not only for a synthetic one. The process
// killed here is killed while holding a `backup-run` lease specifically — the mid-run failure the brief
// asks for injected, for real, rather than assumed from the generic case.

import { LEASE_LOST, queueDb, queueOn } from '@holydeck/app/queue';
import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { mongoFor } from '../src/mongo.js';
import { serve } from '../src/processes.js';

import type { Queue } from '@holydeck/app/queue';
import type { JobRecord } from '@holydeck/contracts/jobs';
import type { HarnessMongo } from '../src/mongo.js';
import type { Served } from '../src/processes.js';

const DATABASE = 'harness_backup_restart';
const KIND = 'backup-run';
const LEASE_MS = 1_500;
const FIXTURE = fileURLToPath(new URL('./restart-fixture.ts', import.meta.url));

const CONTEXT = {
  actor: 'system',
  permissions: ['jobs.enqueue', 'jobs.read', 'jobs.run'],
  correlationId: 'harness-backup-restart',
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let mongo: HarnessMongo;
let client: MongoClient;
let queue: Queue;

beforeAll(async () => {
  mongo = await mongoFor(undefined);
  client = new MongoClient(mongo.base);
  await client.connect();
  queue = queueOn(queueDb(client.db(DATABASE)), {
    now: () => new Date().toISOString(),
    leaseMs: LEASE_MS,
  });
});

afterAll(async () => {
  await client.close();
  await mongo.stop();
});

/** One worker process, run to its end, however it ended. */
async function worker(name: string, mode: 'die' | 'finish'): Promise<Served> {
  const served = serve([FIXTURE, mongo.base, DATABASE, name, KIND, String(LEASE_MS), mode], {});
  await served.stopped();
  return served;
}

const stored = async (): Promise<JobRecord | undefined> => (await queue.list(CONTEXT, { kinds: [KIND] }))[0];

test('a backup-run job outlives the producer that was running it, and the next worker runs it again', async () => {
  const { id, created } = await queue.enqueue(CONTEXT, {
    kind: KIND,
    idempotencyKey: 'backup-run:scheduled',
    retryLimit: 3,
  });
  expect(created).toBe(true);

  // The mid-run failure injection: a real process holding a real `backup-run` lease is killed outright,
  // the way a producer dying partway through a restic invocation would be, not stopped in an orderly way.
  const dead = await worker('backup-worker-down', 'die');
  expect(dead.output()).toContain(`claimed ${id} on attempt 1`);
  expect(dead.exit()).toEqual({ code: null, signal: 'SIGKILL' });

  expect(await stored()).toMatchObject({ id, state: 'leased', attempt: 1, workers: ['backup-worker-down'] });
  expect(await queue.recover(CONTEXT)).toEqual([]);

  await sleep(LEASE_MS + 200);

  const back = await worker('backup-worker-back', 'finish');
  expect(back.output()).toContain(`claimed ${id} on attempt 2`);
  expect(back.exit()).toEqual({ code: 0, signal: null });

  expect(await stored()).toMatchObject({
    id,
    state: 'succeeded',
    attempt: 2,
    workers: ['backup-worker-back'],
    lastError: LEASE_LOST,
  });
  expect((await stored())?.leaseExpiresAt).toBeUndefined();
}, 30_000);
