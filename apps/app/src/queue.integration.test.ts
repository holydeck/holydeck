// The queue against a real MongoDB, because the promises it makes are the database's: one claim wins a
// race, a lease that ran out is another worker's to take, and a key that is already there is refused by
// an index rather than by a check this process ran a moment earlier.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { requestContext } from './context.js';
import {
  DEFAULT_LEASE_MS,
  JOBS_COLLECTION,
  LEASE_LOST,
  QUEUE_INDEXES,
  QUEUE_PERMISSIONS,
  QueueError,
  createQueueIndexOn,
  queueDb,
  queueOn,
  workerContext,
} from './queue.js';
import { startTestMongo } from '../test/helpers/mongo.js';

import type { Db } from 'mongodb';
import type { JobRecord } from '@holydeck/contracts/jobs';
import type { Queue, QueueDb } from './queue.js';
import type { TestMongo } from '../test/helpers/mongo.js';

const START = Date.parse('2026-09-13T09:30:00.000Z');
const KEY = 'prepare:service-1:rev-5';

const OPERATOR = requestContext({
  actor: 'account:7f3a',
  permissions: [QUEUE_PERMISSIONS.enqueue, QUEUE_PERMISSIONS.read, QUEUE_PERMISSIONS.requeue],
  correlationId: 'req-0f9c2a41',
});
const WORKER = workerContext('worker-a-1');

let mongo: TestMongo;
let live: Db;
let db: QueueDb;
let queue: Queue;
let at: string;

const stamp = (msFromStart: number): string => new Date(START + msFromStart).toISOString();
const advance = (ms: number): void => {
  at = stamp(Date.parse(at) - START + ms);
};

const one = async (): Promise<JobRecord> => {
  const [job] = await queue.list(OPERATOR);
  if (job === undefined) throw new Error('the queue is empty');
  return job;
};

const enqueue = async (key = KEY, retryLimit?: number): Promise<string> =>
  (await queue.enqueue(OPERATOR, { kind: 'prepare', idempotencyKey: key, ...(retryLimit === undefined ? {} : { retryLimit }) }))
    .id;

beforeAll(async () => {
  mongo = await startTestMongo();
  live = mongo.db;
  db = queueDb(live);
});

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await live.collection(JOBS_COLLECTION).deleteMany({});
  for (const index of QUEUE_INDEXES) await createQueueIndexOn(db, index);
  at = stamp(0);
  queue = queueOn(db, { now: () => at });
});

describe('claiming a job out of a real queue', () => {
  // The assertion is the claim's atomicity, not a sample of it: eight workers ask at the same instant for
  // the one job there is, and a claim that is not atomic hands the same job to two of them.
  test('eight workers racing for one job produce exactly one claim', async () => {
    await enqueue();
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_ignored, index) =>
        queue.claim(workerContext(`worker-${index}`), { worker: `worker-${index}`, kinds: ['prepare'] }),
      ),
    );
    const won = claims.filter((job) => job !== undefined);
    expect(won).toHaveLength(1);
    const job = await one();
    expect(job.state).toBe('leased');
    expect(job.attempt).toBe(1);
    expect(job.workers).toEqual([won[0]?.workers[0]]);
  });

  test('a queued job is leased as the attempt it already is, with the lease it was given', async () => {
    await enqueue();
    const job = await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });
    expect(job).toMatchObject({
      state: 'leased',
      attempt: 1,
      workers: ['worker-a'],
      leaseExpiresAt: stamp(DEFAULT_LEASE_MS),
      heartbeatAt: stamp(0),
    });
  });

  test('leaves alone a job of a kind this worker does not run', async () => {
    await enqueue();
    await expect(queue.claim(WORKER, { worker: 'worker-a', kinds: ['transcode'] })).resolves.toBeUndefined();
  });

  test('takes the job that has waited longest', async () => {
    await enqueue('prepare:first');
    advance(1000);
    await enqueue('prepare:second');
    const job = await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });
    expect(job?.idempotencyKey).toBe('prepare:first');
  });
});

describe('a lease that ran out', () => {
  test('is another worker’s to take, and the attempt it lost is counted', async () => {
    await enqueue();
    await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });
    advance(DEFAULT_LEASE_MS + 1000);
    const reclaimed = await queue.claim(workerContext('worker-b-1'), { worker: 'worker-b', kinds: ['prepare'] });
    expect(reclaimed).toMatchObject({ state: 'leased', attempt: 2, workers: ['worker-b'], lastError: LEASE_LOST });
  });

  test('retires the job when the attempt it lost was its last, and the claim keeps looking', async () => {
    await enqueue(KEY, 1);
    await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });
    advance(DEFAULT_LEASE_MS + 1000);
    await expect(
      queue.claim(workerContext('worker-b-1'), { worker: 'worker-b', kinds: ['prepare'] }),
    ).resolves.toBeUndefined();
    expect(await one()).toMatchObject({
      state: 'failed',
      attempt: 1,
      workers: ['worker-a'],
      lastError: LEASE_LOST,
      leaseExpiresAt: undefined,
      heartbeatAt: undefined,
    });
  });

  test('is recovered without being leased, so a worker that runs no such kind still unblocks it', async () => {
    await enqueue();
    await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });
    advance(DEFAULT_LEASE_MS + 1000);
    const released = await queue.recover(WORKER);
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ state: 'queued', attempt: 2, workers: [], lastError: LEASE_LOST });
    await expect(queue.recover(WORKER)).resolves.toEqual([]);
  });

  test('is retired by the recovery when the job has no attempt left', async () => {
    await enqueue(KEY, 1);
    await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });
    advance(DEFAULT_LEASE_MS + 1000);
    expect(await queue.recover(WORKER)).toMatchObject([{ state: 'failed', attempt: 1, lastError: LEASE_LOST }]);
  });

  test('is not recovered while it is still held', async () => {
    await enqueue();
    await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });
    advance(DEFAULT_LEASE_MS - 1000);
    await expect(queue.recover(WORKER)).resolves.toEqual([]);
  });
});

describe('holding a lease while the work runs', () => {
  test('a heartbeat moves the expiry out, and the job stays this worker’s', async () => {
    await enqueue();
    await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });
    advance(10_000);
    await expect(queue.heartbeat(WORKER, { worker: 'worker-a', id: (await one()).id })).resolves.toBe(true);
    expect(await one()).toMatchObject({ leaseExpiresAt: stamp(10_000 + DEFAULT_LEASE_MS), heartbeatAt: stamp(10_000) });
    advance(DEFAULT_LEASE_MS - 1000);
    await expect(queue.recover(WORKER)).resolves.toEqual([]);
  });

  // Losing the heartbeat is how a worker learns the job is gone. The work it is still doing has to stop:
  // another worker is already repeating it, and the result of this attempt is no longer wanted.
  test('a worker that lost the job is told so by its heartbeat, and cannot finish it', async () => {
    const id = await enqueue();
    await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });
    advance(DEFAULT_LEASE_MS + 1000);
    await queue.claim(workerContext('worker-b-1'), { worker: 'worker-b', kinds: ['prepare'] });

    await expect(queue.heartbeat(WORKER, { worker: 'worker-a', id })).resolves.toBe(false);
    const refused = await queue.succeed(WORKER, { worker: 'worker-a', id }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(QueueError);
    expect((refused as QueueError).kind).toBe('lease');
    expect(await one()).toMatchObject({ state: 'leased', workers: ['worker-b'], attempt: 2 });
  });

  test('a worker whose own lease ran out cannot renew it, because it is no longer holding anything', async () => {
    const id = await enqueue();
    await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });
    advance(DEFAULT_LEASE_MS + 1000);
    await expect(queue.heartbeat(WORKER, { worker: 'worker-a', id })).resolves.toBe(false);
  });

  test('finishing the work marks the job succeeded and lets the lease go', async () => {
    const id = await enqueue();
    await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });
    await expect(queue.succeed(WORKER, { worker: 'worker-a', id })).resolves.toMatchObject({
      state: 'succeeded',
      attempt: 1,
      leaseExpiresAt: undefined,
      heartbeatAt: undefined,
    });
    await expect(queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] })).resolves.toBeUndefined();
  });
});

describe('an attempt that fails', () => {
  test('is queued again as the next attempt, carrying what went wrong', async () => {
    const id = await enqueue();
    await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });
    await expect(
      queue.fail(WORKER, { worker: 'worker-a', id, error: 'the renderer ran out of memory' }),
    ).resolves.toMatchObject({
      state: 'queued',
      attempt: 2,
      workers: [],
      lastError: 'the renderer ran out of memory',
    });
    await expect(queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] })).resolves.toMatchObject({ attempt: 2 });
  });

  test('ends in a failed job an operator can read the last reason off, once the retries run out', async () => {
    const id = await enqueue(KEY, 3);
    for (const attempt of [1, 2, 3]) {
      const job = await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });
      expect(job?.attempt).toBe(attempt);
      await queue.fail(WORKER, { worker: 'worker-a', id, error: `attempt ${attempt} ran out of memory` });
    }
    expect(await one()).toMatchObject({
      state: 'failed',
      attempt: 3,
      workers: ['worker-a'],
      lastError: 'attempt 3 ran out of memory',
    });
    await expect(queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] })).resolves.toBeUndefined();
  });
});

describe('the same work enqueued twice', () => {
  test('is one job while it waits, while it runs and after it succeeded', async () => {
    const id = await enqueue();
    await expect(queue.enqueue(OPERATOR, { kind: 'prepare', idempotencyKey: KEY })).resolves.toEqual({
      id,
      created: false,
    });
    await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });
    await expect(queue.enqueue(OPERATOR, { kind: 'prepare', idempotencyKey: KEY })).resolves.toEqual({
      id,
      created: false,
    });
    await queue.succeed(WORKER, { worker: 'worker-a', id });
    await expect(queue.enqueue(OPERATOR, { kind: 'prepare', idempotencyKey: KEY })).resolves.toEqual({
      id,
      created: false,
    });
    await expect(live.collection(JOBS_COLLECTION).countDocuments({})).resolves.toBe(1);
  });

  test('is one job even when eight producers enqueue it at the same instant', async () => {
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => queue.enqueue(OPERATOR, { kind: 'prepare', idempotencyKey: KEY })),
    );
    expect(new Set(answers.map((answer) => answer.id)).size).toBe(1);
    expect(answers.filter((answer) => answer.created)).toHaveLength(1);
    await expect(live.collection(JOBS_COLLECTION).countDocuments({})).resolves.toBe(1);
  });
});

describe('what an administrator does with a queue', () => {
  test('reads every job, newest first, with every field a job carries', async () => {
    await enqueue('prepare:first');
    advance(1000);
    await enqueue('prepare:second');
    await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });

    const jobs = await queue.list(OPERATOR);
    expect(jobs.map((job) => job.idempotencyKey)).toEqual(['prepare:second', 'prepare:first']);
    expect(await queue.list(OPERATOR, { states: ['leased'] })).toMatchObject([{ idempotencyKey: 'prepare:first' }]);
    await expect(queue.summary(OPERATOR)).resolves.toEqual({ queued: 1, leased: 1, succeeded: 0, failed: 0 });
  });

  // The requeue is the only way work that ran out of attempts runs again, and the job it produces has to
  // be reachable by the key it was first enqueued under, or the next producer queues a second one.
  test('requeues a failed job as a first attempt, and the key it was enqueued under still finds it', async () => {
    const id = await enqueue(KEY, 1);
    await queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] });
    await queue.fail(WORKER, { worker: 'worker-a', id, error: 'the renderer ran out of memory' });
    expect(await one()).toMatchObject({ state: 'failed', attempt: 1 });

    await expect(queue.requeue(OPERATOR, { id, idempotencyKey: KEY })).resolves.toMatchObject({
      state: 'queued',
      attempt: 1,
      workers: [],
      idempotencyKey: `${KEY}#2`,
      lastError: 'the renderer ran out of memory',
    });
    await expect(queue.enqueue(OPERATOR, { kind: 'prepare', idempotencyKey: KEY })).resolves.toEqual({
      id,
      created: false,
    });
    await expect(queue.claim(WORKER, { worker: 'worker-a', kinds: ['prepare'] })).resolves.toMatchObject({ attempt: 1 });
  });

  test('refuses to requeue a job that has not failed', async () => {
    const id = await enqueue();
    const refused = await queue.requeue(OPERATOR, { id, idempotencyKey: KEY }).catch((error: unknown) => error);
    expect((refused as QueueError).kind).toBe('state');
  });
});
