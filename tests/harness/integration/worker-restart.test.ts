// Failure injection, specification 14.3: an application restart in the middle of a job, and the lease
// expiry that makes recovery possible. Both are injected for real — a worker process is killed outright
// while it holds a lease, and the next one is started only once that lease has run out.
//
// The queue is reached the way a deployment reaches it, over a MongoDB of the harness's own, and the
// worker that claims the job is a separate process running the built package. Nothing here stubs a clock:
// the lease is short so that waiting one out is a test and not a delay.

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

const DATABASE = 'harness_restart';
const KIND = 'restart-probe';
const LEASE_MS = 1_500;
const FIXTURE = fileURLToPath(new URL('./restart-fixture.ts', import.meta.url));

// The producer's context, which a worker's is not: enqueuing is not something a worker may do.
const CONTEXT = {
  actor: 'system',
  permissions: ['jobs.enqueue', 'jobs.read', 'jobs.run'],
  correlationId: 'harness-restart',
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

test('a job outlives the worker that was running it, and the next worker runs it again', async () => {
  const { id, created } = await queue.enqueue(CONTEXT, {
    kind: KIND,
    idempotencyKey: 'restart-probe:once',
    retryLimit: 3,
  });
  expect(created).toBe(true);

  const dead = await worker('worker-down', 'die');
  expect(dead.output()).toContain(`claimed ${id} on attempt 1`);
  expect(dead.exit()).toEqual({ code: null, signal: 'SIGKILL' });

  // The lease it was holding is still the record's, because nothing but time can tell the difference
  // between a worker that stopped and one that is slow.
  expect(await stored()).toMatchObject({ id, state: 'leased', attempt: 1, workers: ['worker-down'] });
  expect(await queue.recover(CONTEXT)).toEqual([]);

  await sleep(LEASE_MS + 200);

  const back = await worker('worker-back', 'finish');
  expect(back.output()).toContain(`claimed ${id} on attempt 2`);
  expect(back.exit()).toEqual({ code: 0, signal: null });

  expect(await stored()).toMatchObject({
    id,
    state: 'succeeded',
    attempt: 2,
    workers: ['worker-back'],
    // Why there was a second attempt is kept, so an operator reading a succeeded job can still see it.
    lastError: LEASE_LOST,
  });
  expect((await stored())?.leaseExpiresAt).toBeUndefined();
}, 30_000);
