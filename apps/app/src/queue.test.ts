import { ADMIN_VISIBLE_FIELDS, JOB_FIELDS } from '@holydeck/contracts/jobs';
import { beforeEach, describe, expect, test } from 'vitest';

import { requestContext } from './context.js';
import {
  DEFAULT_LEASE_MS,
  DEFAULT_RETRY_LIMIT,
  JOBS_COLLECTION,
  LEASE_LOST,
  QUEUE_INDEXES,
  QUEUE_PERMISSIONS,
  QueueError,
  claimFilter,
  claimUpdate,
  createQueueIndexOn,
  dropQueueIndexOn,
  enqueueDocument,
  familyFilter,
  jobFrom,
  leaseExpiry,
  queueOn,
  releaseUpdate,
  requeueKey,
  workerContext,
} from './queue.js';

import type { Document, Filter } from './repositories.js';
import type { Queue, QueueDb, QueueIndex } from './queue.js';

const NOW = '2026-09-13T09:30:00.000Z';
const LATER = '2026-09-13T09:30:30.000Z';
const WORKER = 'worker-a';

const OPERATOR = requestContext({
  actor: 'account:7f3a',
  permissions: [QUEUE_PERMISSIONS.enqueue, QUEUE_PERMISSIONS.read, QUEUE_PERMISSIONS.requeue],
  correlationId: 'req-0f9c2a41',
});

const RECLAIMED = { $eq: ['$state', 'leased'] };
const EXHAUSTED = { $gte: ['$attempt', '$retryLimit'] };
const RETIRED = { $and: [RECLAIMED, EXHAUSTED] };

const stored = (fields: Document = {}): Document => ({
  _id: 'job-1',
  kind: 'prepare',
  idempotencyKey: 'prepare:service-1:rev-5',
  payload: {},
  state: 'queued',
  attempt: 1,
  retryLimit: DEFAULT_RETRY_LIMIT,
  queuedAt: NOW,
  workers: [],
  ...fields,
});

const leased = (fields: Document = {}): Document =>
  stored({ state: 'leased', workers: [WORKER], leaseExpiresAt: LATER, heartbeatAt: NOW, ...fields });

interface Call {
  readonly op: string;
  readonly args: readonly unknown[];
}

interface Stub {
  readonly calls: Call[];
  readonly names: string[];
  readonly db: QueueDb;
}

/**
 * A collection that answers what a test scripts and records how it was asked. An operation with no
 * answer left throws: a queue that reached the database once more than the test expected is a defect,
 * not a detail, because every one of these operations changes a job.
 */
const stub = (answers: Readonly<Record<string, readonly unknown[]>>): Stub => {
  const calls: Call[] = [];
  const names: string[] = [];
  const remaining = new Map(Object.entries(answers).map(([op, list]) => [op, [...list]]));
  const answer = (op: string, ...args: readonly unknown[]): unknown => {
    calls.push({ op, args });
    const list = remaining.get(op);
    if (list === undefined || list.length === 0) throw new Error(`the queue asked for ${op} once more than scripted`);
    const next = list.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const collection = {
    insertOne: async (document: Document) => answer('insertOne', document) as { insertedId: unknown },
    findOne: async (filter: Filter) => answer('findOne', filter) as Document | null,
    findOneAndUpdate: async (filter: Filter, update: unknown, options: unknown) =>
      answer('findOneAndUpdate', filter, update, options) as Document | null,
    updateOne: async (filter: Filter, update: unknown) => answer('updateOne', filter, update) as { matchedCount: number },
    find: (filter: Filter, options?: unknown) => ({
      toArray: async () => answer('find', filter, options) as Document[],
    }),
    countDocuments: async (filter: Filter) => answer('countDocuments', filter) as number,
    createIndex: async (keys: unknown, options?: unknown) => answer('createIndex', keys, options) as string,
    dropIndex: async (index: string) => answer('dropIndex', index) as undefined,
  };
  return {
    calls,
    names,
    db: {
      collection: (name: string) => {
        names.push(name);
        return collection;
      },
    },
  };
};

const duplicateKey = (): Error => Object.assign(new Error('E11000 duplicate key'), { code: 11_000 });

let scripted: Stub;
let queue: Queue;

const open = (answers: Readonly<Record<string, readonly unknown[]>>, ids: readonly string[] = ['job-1']): void => {
  scripted = stub(answers);
  const made = [...ids];
  queue = queueOn(scripted.db, { now: () => NOW, newId: () => made.shift() ?? 'exhausted' });
};

const refusal = async (run: () => Promise<unknown>): Promise<QueueError> => {
  const error = await run().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(QueueError);
  return error as QueueError;
};

beforeEach(() => {
  open({});
});

describe('what the queue is', () => {
  test('names the collection it owns and the permissions it is reached through', () => {
    expect(JOBS_COLLECTION).toBe('jobs');
    expect(QUEUE_PERMISSIONS).toEqual({
      enqueue: 'jobs.enqueue',
      run: 'jobs.run',
      read: 'jobs.read',
      requeue: 'jobs.requeue',
    });
  });

  // The claim is the one query in the product that has to be fast under contention: every worker runs it
  // on every idle tick, so the fields it filters and sorts by are declared here or it scans the collection.
  test('declares an index for the key and one the claim is served by, on fields a job carries', () => {
    expect(QUEUE_INDEXES.map((index) => index.name)).toEqual(['job_key', 'job_claim']);
    expect(QUEUE_INDEXES[0]).toEqual({ name: 'job_key', keys: { idempotencyKey: 1 }, options: { unique: true } });
    expect(QUEUE_INDEXES[1]?.keys).toEqual({ state: 1, kind: 1, leaseExpiresAt: 1, queuedAt: 1 });
    const carried = [...JOB_FIELDS.filter((field) => field !== 'id'), '_id'];
    for (const index of QUEUE_INDEXES) {
      for (const field of Object.keys(index.keys)) expect(carried).toContain(field);
    }
  });

  test('runs a worker as the product itself, allowed to run jobs and to read them', () => {
    expect(workerContext('worker-a-1')).toEqual({
      actor: 'system',
      permissions: ['jobs.run', 'jobs.read'],
      correlationId: 'worker-a-1',
    });
  });
});

describe('the claim, as a query', () => {
  test('takes a queued job or one whose lease ran out, and nothing else', () => {
    expect(claimFilter(['prepare', 'transcode'], NOW)).toEqual({
      kind: { $in: ['prepare', 'transcode'] },
      $or: [{ state: 'queued' }, { state: 'leased', leaseExpiresAt: { $lte: NOW } }],
    });
  });

  // One update, three outcomes: a queued job is leased as the attempt it already is, a job whose lease ran
  // out is leased as the next attempt, and one with no attempt left is retired instead of leased again.
  test('leases the job, counts a reclaimed attempt, and retires one with no attempt left', () => {
    expect(claimUpdate(WORKER, NOW, DEFAULT_LEASE_MS)).toEqual([
      {
        $set: {
          state: { $cond: [RETIRED, 'failed', 'leased'] },
          attempt: { $cond: [{ $and: [RECLAIMED, { $not: EXHAUSTED }] }, { $add: ['$attempt', 1] }, '$attempt'] },
          workers: { $cond: [RETIRED, '$workers', [WORKER]] },
          leaseExpiresAt: { $cond: [RETIRED, '$$REMOVE', LATER] },
          heartbeatAt: { $cond: [RETIRED, '$$REMOVE', NOW] },
          lastError: { $cond: [RECLAIMED, LEASE_LOST, '$lastError'] },
        },
      },
    ]);
  });

  test('a lease expires the lease length after it was taken', () => {
    expect(leaseExpiry(NOW, DEFAULT_LEASE_MS)).toBe(LATER);
    expect(DEFAULT_LEASE_MS).toBe(30_000);
  });
});

describe('letting a job go, as a query', () => {
  // An attempt that failed and one whose lease ran out leave the same job behind, differing only in what
  // there is to tell an operator, so one update serves both and the reason is carried rather than implied.
  test('requeues the job as its next attempt, or fails it when that attempt was its last', () => {
    expect(releaseUpdate('the renderer ran out of memory')).toEqual([
      {
        $set: {
          state: { $cond: [EXHAUSTED, 'failed', 'queued'] },
          attempt: { $cond: [EXHAUSTED, '$attempt', { $add: ['$attempt', 1] }] },
          workers: { $cond: [EXHAUSTED, '$workers', []] },
          leaseExpiresAt: '$$REMOVE',
          heartbeatAt: '$$REMOVE',
          lastError: 'the renderer ran out of memory',
        },
      },
    ]);
  });

  test('says a lease ran out in words an operator can act on', () => {
    expect(LEASE_LOST).toBe('the attempt stopped without a result and its lease ran out');
  });
});

describe('the documents the queue writes and reads', () => {
  test('an enqueued job is queued, on its first attempt, held by nobody', () => {
    expect(
      enqueueDocument({
        id: 'job-9',
        kind: 'prepare',
        idempotencyKey: 'prepare:service-1:rev-5',
        payload: {},
        retryLimit: 3,
        queuedAt: NOW,
      }),
    ).toEqual({
      _id: 'job-9',
      kind: 'prepare',
      idempotencyKey: 'prepare:service-1:rev-5',
      payload: {},
      state: 'queued',
      attempt: 1,
      retryLimit: 3,
      queuedAt: NOW,
      workers: [],
    });
  });

  test('reads the identifier out of _id, because that is where the queue stores it', () => {
    expect(jobFrom(stored())).toEqual({
      id: 'job-1',
      kind: 'prepare',
      idempotencyKey: 'prepare:service-1:rev-5',
      payload: {},
      state: 'queued',
      attempt: 1,
      retryLimit: DEFAULT_RETRY_LIMIT,
      queuedAt: NOW,
      workers: [],
      leaseExpiresAt: undefined,
      heartbeatAt: undefined,
      lastError: undefined,
    });
  });

  test('refuses a stored document the contract would not accept, naming every problem', () => {
    const error = (): QueueError => {
      try {
        jobFrom(stored({ kind: 'Prepare', attempt: 9 }));
      } catch (caught) {
        return caught as QueueError;
      }
      throw new Error('the queue read a job it should have refused');
    };
    const refused = error();
    expect(refused).toBeInstanceOf(QueueError);
    expect(refused.kind).toBe('schema');
    expect(refused.message).toContain('job.kind');
    expect(refused.message).toContain('job.attempt');
  });

  test('gives a requeued job the next key, so the first one stays the key of the job that failed', () => {
    expect(requeueKey('prepare:service-1:rev-5')).toBe('prepare:service-1:rev-5#2');
    expect(requeueKey('prepare:service-1:rev-5#2')).toBe('prepare:service-1:rev-5#3');
  });

  // Every lease comparison the database makes is a comparison of these strings, which is only the
  // comparison of the instants they name while every one of them is written the same way.
  test('refuses a clock whose instants a database could not compare as text', () => {
    const loose = queueOn(scripted.db, { now: () => '2026-09-13T09:30:00Z' });
    return refusal(() => loose.claim(workerContext('worker-a-1'), { worker: WORKER, kinds: ['prepare'] })).then(
      (error) => {
        expect(error.kind).toBe('schema');
        expect(error.message).toContain('2026-09-13T09:30:00Z');
        expect(scripted.calls).toEqual([]);
      },
    );
  });
});

describe('enqueuing work', () => {
  test('inserts the job once and reports the identifier it was given', async () => {
    open({ findOne: [null], insertOne: [{ insertedId: 'job-1' }] });
    await expect(
      queue.enqueue(OPERATOR, { kind: 'prepare', idempotencyKey: 'prepare:service-1:rev-5' }),
    ).resolves.toEqual({ id: 'job-1', created: true });
    expect([...new Set(scripted.names)]).toEqual([JOBS_COLLECTION]);
    expect(scripted.calls.map((call) => call.op)).toEqual(['findOne', 'insertOne']);
    expect(scripted.calls[0]?.args[0]).toEqual(familyFilter('prepare:service-1:rev-5'));
    expect(scripted.calls[1]?.args[0]).toEqual(
      enqueueDocument({
        id: 'job-1',
        kind: 'prepare',
        idempotencyKey: 'prepare:service-1:rev-5',
        payload: {},
        retryLimit: DEFAULT_RETRY_LIMIT,
        queuedAt: NOW,
      }),
    );
  });

  // This is the whole of "a replay does no second side effect": the key is looked for before the insert
  // and the index refuses one that arrived in between, so the answer is the job that is already there.
  test('answers a key that is already queued with the job that holds it, and writes nothing', async () => {
    open({ findOne: [stored({ _id: 'job-earlier', state: 'succeeded' })] });
    await expect(
      queue.enqueue(OPERATOR, { kind: 'prepare', idempotencyKey: 'prepare:service-1:rev-5' }),
    ).resolves.toEqual({ id: 'job-earlier', created: false });
    expect(scripted.calls.map((call) => call.op)).toEqual(['findOne']);
  });

  // A requeued job carries the next key in the same family, so the key it was enqueued under has to find
  // it anyway: otherwise a producer replaying that key queues a second job doing the work of the first.
  test('answers a key whose job an administrator requeued, because that is the same work', async () => {
    open({ findOne: [stored({ _id: 'job-earlier', idempotencyKey: 'prepare:service-1:rev-5#2' })] });
    await expect(
      queue.enqueue(OPERATOR, { kind: 'prepare', idempotencyKey: 'prepare:service-1:rev-5' }),
    ).resolves.toEqual({ id: 'job-earlier', created: false });
    expect(familyFilter('prepare:service-1:rev-5#2')).toEqual(familyFilter('prepare:service-1:rev-5'));
  });

  // The key is whatever the work is named after, including characters a pattern would read as syntax.
  test('looks for the key as text rather than as a pattern', () => {
    const filter = familyFilter('prepare:service(1).rev+5');
    expect(filter).toEqual({
      idempotencyKey: { $regex: '^prepare:service\\(1\\)\\.rev\\+5(?:#\\d+)?$' },
    });
  });

  test('lets the index answer a key that arrived between the look and the insert', async () => {
    open({
      findOne: [null, stored({ _id: 'job-earlier' })],
      insertOne: [duplicateKey()],
    });
    await expect(
      queue.enqueue(OPERATOR, { kind: 'prepare', idempotencyKey: 'prepare:service-1:rev-5' }),
    ).resolves.toEqual({ id: 'job-earlier', created: false });
    expect(scripted.calls.map((call) => call.op)).toEqual(['findOne', 'insertOne', 'findOne']);
  });

  test('refuses a collision that is not the key, rather than reporting a job it did not find', async () => {
    open({ findOne: [null, null], insertOne: [duplicateKey()] });
    const error = await refusal(() => queue.enqueue(OPERATOR, { kind: 'prepare', idempotencyKey: 'prepare:a' }));
    expect(error.kind).toBe('duplicate');
  });

  test('refuses a job the contract would not accept, before the database sees it', async () => {
    const error = await refusal(() => queue.enqueue(OPERATOR, { kind: 'Prepare', idempotencyKey: 'Prepare:a' }));
    expect(error.kind).toBe('schema');
    expect(scripted.calls).toEqual([]);
  });

  test('refuses a retry limit that is not a count of attempts', async () => {
    const error = await refusal(() =>
      queue.enqueue(OPERATOR, { kind: 'prepare', idempotencyKey: 'prepare:a', retryLimit: 0 }),
    );
    expect(error.kind).toBe('schema');
    expect(scripted.calls).toEqual([]);
  });

  test('rethrows a database failure that is not a collision, because it is not the queue’s to answer', async () => {
    open({ findOne: [null], insertOne: [new Error('the primary stepped down')] });
    await expect(
      queue.enqueue(OPERATOR, { kind: 'prepare', idempotencyKey: 'prepare:a' }),
    ).rejects.toThrow('the primary stepped down');
  });
});

describe('claiming work', () => {
  test('leases one job and reads it back as the worker holds it', async () => {
    open({ findOneAndUpdate: [leased({ attempt: 2 })] });
    const job = await queue.claim(workerContext('worker-a-1'), { worker: WORKER, kinds: ['prepare'] });
    expect(job?.state).toBe('leased');
    expect(job?.attempt).toBe(2);
    expect(scripted.calls[0]?.args[0]).toEqual(claimFilter(['prepare'], NOW));
    expect(scripted.calls[0]?.args[1]).toEqual(claimUpdate(WORKER, NOW, DEFAULT_LEASE_MS));
    expect(scripted.calls[0]?.args[2]).toEqual({ sort: { queuedAt: 1 }, returnDocument: 'after' });
  });

  // A job the claim retired had no attempt left: the worker that found it did the queue a service and
  // still has nothing to run, so it looks again rather than reporting an idle queue that is not idle.
  test('keeps looking past a job the claim retired', async () => {
    open({ findOneAndUpdate: [stored({ state: 'failed', attempt: 5, lastError: LEASE_LOST }), leased()] });
    const job = await queue.claim(workerContext('worker-a-1'), { worker: WORKER, kinds: ['prepare'] });
    expect(job?.id).toBe('job-1');
    expect(scripted.calls.map((call) => call.op)).toEqual(['findOneAndUpdate', 'findOneAndUpdate']);
  });

  test('reports nothing to do when no job matches', async () => {
    open({ findOneAndUpdate: [null] });
    await expect(queue.claim(workerContext('worker-a-1'), { worker: WORKER, kinds: ['prepare'] })).resolves.toBeUndefined();
  });

  test('refuses to claim for no kinds at all, because that is a worker that would idle forever', async () => {
    const error = await refusal(() => queue.claim(workerContext('worker-a-1'), { worker: WORKER, kinds: [] }));
    expect(error.kind).toBe('schema');
  });

  test('refuses a worker with no name, because a lease nobody is named in cannot be recovered', async () => {
    const error = await refusal(() => queue.claim(workerContext('worker-a-1'), { worker: ' ', kinds: ['prepare'] }));
    expect(error.kind).toBe('schema');
  });
});

describe('holding and letting go of a lease', () => {
  test('renews the lease and says it still holds it', async () => {
    open({ updateOne: [{ matchedCount: 1 }] });
    await expect(queue.heartbeat(workerContext('worker-a-1'), { worker: WORKER, id: 'job-1' })).resolves.toBe(true);
    expect(scripted.calls[0]?.args[0]).toEqual({
      _id: 'job-1',
      state: 'leased',
      workers: [WORKER],
      leaseExpiresAt: { $gt: NOW },
    });
    expect(scripted.calls[0]?.args[1]).toEqual({ $set: { heartbeatAt: NOW, leaseExpiresAt: LATER } });
  });

  // A worker whose heartbeat matches nothing has lost the job to whoever reclaimed it. Saying so is how
  // the attempt stops instead of finishing work a second worker is already doing.
  test('says the lease is gone when the heartbeat matches nothing', async () => {
    open({ updateOne: [{ matchedCount: 0 }] });
    await expect(queue.heartbeat(workerContext('worker-a-1'), { worker: WORKER, id: 'job-1' })).resolves.toBe(false);
  });

  test('marks the job succeeded and lets the lease go', async () => {
    open({ findOneAndUpdate: [stored({ state: 'succeeded', attempt: 2, workers: [WORKER] })] });
    const job = await queue.succeed(workerContext('worker-a-1'), { worker: WORKER, id: 'job-1' });
    expect(job.state).toBe('succeeded');
    expect(scripted.calls[0]?.args[0]).toEqual({
      _id: 'job-1',
      state: 'leased',
      workers: [WORKER],
      leaseExpiresAt: { $gt: NOW },
    });
    expect(scripted.calls[0]?.args[1]).toEqual({
      $set: { state: 'succeeded' },
      $unset: { leaseExpiresAt: '', heartbeatAt: '' },
    });
  });

  // Succeeding on a lease that is gone would record work a second worker is repeating as finished once.
  test('refuses to succeed a job this worker no longer holds', async () => {
    open({ findOneAndUpdate: [null] });
    const error = await refusal(() => queue.succeed(workerContext('worker-a-1'), { worker: WORKER, id: 'job-1' }));
    expect(error.kind).toBe('lease');
    expect(error.message).toContain('job-1');
  });

  test('releases a failed attempt with the reason it failed', async () => {
    open({ findOneAndUpdate: [stored({ attempt: 2, lastError: 'the renderer ran out of memory' })] });
    const job = await queue.fail(workerContext('worker-a-1'), {
      worker: WORKER,
      id: 'job-1',
      error: 'the renderer ran out of memory',
    });
    expect(job.state).toBe('queued');
    expect(job.lastError).toBe('the renderer ran out of memory');
    expect(scripted.calls[0]?.args[1]).toEqual(releaseUpdate('the renderer ran out of memory'));
  });

  test('refuses to release a job this worker no longer holds', async () => {
    open({ findOneAndUpdate: [null] });
    const error = await refusal(() =>
      queue.fail(workerContext('worker-a-1'), { worker: WORKER, id: 'job-1', error: 'no' }),
    );
    expect(error.kind).toBe('lease');
  });

  test('refuses to release a job with no reason at all', async () => {
    const error = await refusal(() =>
      queue.fail(workerContext('worker-a-1'), { worker: WORKER, id: 'job-1', error: '  ' }),
    );
    expect(error.kind).toBe('schema');
    expect(scripted.calls).toEqual([]);
  });
});

describe('recovering what a worker abandoned', () => {
  test('releases every lease that ran out, one job at a time, until there are none', async () => {
    open({
      findOneAndUpdate: [stored({ attempt: 2, lastError: LEASE_LOST }), stored({ _id: 'job-2', attempt: 2 }), null],
    });
    const released = await queue.recover(workerContext('worker-a-1'));
    expect(released.map((job) => job.id)).toEqual(['job-1', 'job-2']);
    expect(scripted.calls[0]?.args[0]).toEqual({ state: 'leased', leaseExpiresAt: { $lte: NOW } });
    expect(scripted.calls[0]?.args[1]).toEqual(releaseUpdate(LEASE_LOST));
  });

  // A sweep that never stops is a worker that never claims. The limit is what makes recovery a step in
  // the loop rather than the loop itself.
  test('stops at the number of jobs it was asked to sweep', async () => {
    open({ findOneAndUpdate: [stored({ attempt: 2 }), stored({ _id: 'job-2', attempt: 2 })] });
    const released = await queue.recover(workerContext('worker-a-1'), { limit: 2 });
    expect(released).toHaveLength(2);
    expect(scripted.calls).toHaveLength(2);
  });

  test('refuses a sweep of nothing', async () => {
    const error = await refusal(() => queue.recover(workerContext('worker-a-1'), { limit: 0 }));
    expect(error.kind).toBe('schema');
  });
});

describe('what an administrator can see and do', () => {
  test('lists the newest jobs first, and shows every field an administrator is shown', async () => {
    open({ find: [[leased(), stored({ _id: 'job-2' })]] });
    const jobs = await queue.list(OPERATOR, { states: ['leased', 'queued'], kinds: ['prepare'], limit: 20 });
    expect(jobs.map((job) => job.id)).toEqual(['job-1', 'job-2']);
    for (const job of jobs) expect(Object.keys(job).sort()).toEqual([...ADMIN_VISIBLE_FIELDS].sort());
    expect(scripted.calls[0]?.args[0]).toEqual({ state: { $in: ['leased', 'queued'] }, kind: { $in: ['prepare'] } });
    expect(scripted.calls[0]?.args[1]).toEqual({ sort: { queuedAt: -1 }, limit: 20 });
  });

  test('lists every job when asked for no state and no kind in particular', async () => {
    open({ find: [[]] });
    await expect(queue.list(OPERATOR)).resolves.toEqual([]);
    expect(scripted.calls[0]?.args[0]).toEqual({});
    expect(scripted.calls[0]?.args[1]).toEqual({ sort: { queuedAt: -1 }, limit: 50 });
  });

  test('refuses a page that is not a page', async () => {
    for (const limit of [0, 501]) {
      const error = await refusal(() => queue.list(OPERATOR, { limit }));
      expect(error.kind).toBe('schema');
    }
    expect(scripted.calls).toEqual([]);
  });

  test('counts every state, including the ones with nothing in them', async () => {
    open({ countDocuments: [2, 1, 0, 3] });
    await expect(queue.summary(OPERATOR)).resolves.toEqual({ queued: 2, leased: 1, succeeded: 0, failed: 3 });
    expect(scripted.calls.map((call) => call.args[0])).toEqual([
      { state: 'queued' },
      { state: 'leased' },
      { state: 'succeeded' },
      { state: 'failed' },
    ]);
  });

  // `get` is the direct lookup `requeue` needs: a job outside `list`'s own page is still one `get` finds,
  // because it asks the database for that one id rather than filtering a page of the newest jobs.
  test('gets one job by id, whatever page it would fall on', async () => {
    open({ findOne: [stored({ _id: 'job-500' })] });
    const job = await queue.get(OPERATOR, 'job-500');
    expect(job?.id).toBe('job-500');
    expect(scripted.calls[0]?.args[0]).toEqual({ _id: 'job-500' });
  });

  test('answers undefined for an id no job carries', async () => {
    open({ findOne: [null] });
    await expect(queue.get(OPERATOR, 'job-missing')).resolves.toBeUndefined();
  });

  // The requeue is the one thing an administrator does to a job. It resets the attempt and takes a new
  // key, so the work runs again even though the queue refuses to enqueue the key that failed a second time.
  test('requeues a failed job as a first attempt under the next key', async () => {
    open({ findOneAndUpdate: [stored({ idempotencyKey: 'prepare:service-1:rev-5#2', lastError: 'ran out of memory' })] });
    const job = await queue.requeue(OPERATOR, { id: 'job-1', idempotencyKey: 'prepare:service-1:rev-5' });
    expect(job.state).toBe('queued');
    expect(job.attempt).toBe(1);
    expect(scripted.calls[0]?.args[0]).toEqual({ _id: 'job-1', state: 'failed' });
    expect(scripted.calls[0]?.args[1]).toEqual({
      $set: { state: 'queued', attempt: 1, queuedAt: NOW, workers: [], idempotencyKey: 'prepare:service-1:rev-5#2' },
      $unset: { leaseExpiresAt: '', heartbeatAt: '' },
    });
  });

  test('refuses to requeue a job that did not fail, because nothing else is an administrator’s to reset', async () => {
    open({ findOneAndUpdate: [null] });
    const error = await refusal(() => queue.requeue(OPERATOR, { id: 'job-1', idempotencyKey: 'prepare:a' }));
    expect(error.kind).toBe('state');
  });

  test('refuses a requeue whose next key is already another job’s', async () => {
    open({ findOneAndUpdate: [duplicateKey()] });
    const error = await refusal(() => queue.requeue(OPERATOR, { id: 'job-1', idempotencyKey: 'prepare:a' }));
    expect(error.kind).toBe('duplicate');
    expect(error.message).toContain('prepare:a#2');
  });

  test('rethrows a database failure a requeue did not cause', async () => {
    open({ findOneAndUpdate: [new Error('the primary stepped down')] });
    await expect(queue.requeue(OPERATOR, { id: 'job-1', idempotencyKey: 'prepare:a' })).rejects.toThrow(
      'the primary stepped down',
    );
  });
});

describe('building the indexes the queue is read by', () => {
  test('builds a declared index under the name the queue declares it by', async () => {
    open({ createIndex: ['job_key'] });
    await expect(createQueueIndexOn(scripted.db, QUEUE_INDEXES[0] as QueueIndex)).resolves.toBe('job_key');
    expect(scripted.calls[0]?.args).toEqual([{ idempotencyKey: 1 }, { name: 'job_key', unique: true }]);
  });

  test('drops one by name', async () => {
    open({ dropIndex: [undefined] });
    await dropQueueIndexOn(scripted.db, 'job_claim');
    expect(scripted.calls[0]?.args).toEqual(['job_claim']);
  });

  // A migration reaches this, and a migration that can build any index on the jobs collection is a
  // migration that can index a field no job carries and slow every claim down for the life of the database.
  test('refuses an index the queue does not declare, whichever way it is asked', async () => {
    const index = { name: 'job_tenant', keys: { kind: 1 }, options: {} } as const;
    for (const attempt of [() => createQueueIndexOn(scripted.db, index), () => dropQueueIndexOn(scripted.db, 'job_tenant')]) {
      const error = await refusal(async () => attempt());
      expect(error.kind).toBe('schema');
      expect(error.message).toContain('job_tenant');
    }
    expect(scripted.calls).toEqual([]);
  });

  test('refuses an index on a field a job does not carry', async () => {
    const error = await refusal(async () =>
      createQueueIndexOn(scripted.db, { name: 'job_key', keys: { tenantId: 1 }, options: {} }),
    );
    expect(error.kind).toBe('schema');
    expect(error.message).toContain('tenantId');
  });

  // `id` is the contract's name for what Mongo stores as `_id`, so an index on it would index nothing.
  test('refuses an index on the identifier under the name the contract reads it by', async () => {
    const error = await refusal(async () =>
      createQueueIndexOn(scripted.db, { name: 'job_key', keys: { id: 1 }, options: {} }),
    );
    expect(error.kind).toBe('schema');
  });
});

describe('who may reach the queue', () => {
  const attempts: Readonly<Record<string, (open: Queue, context: unknown) => Promise<unknown>>> = {
    'jobs.enqueue': (open, context) => open.enqueue(context, { kind: 'prepare', idempotencyKey: 'prepare:a' }),
    'jobs.run': (open, context) => open.claim(context, { worker: WORKER, kinds: ['prepare'] }),
    'jobs.read': (open, context) => open.list(context),
    'jobs.requeue': (open, context) => open.requeue(context, { id: 'job-1', idempotencyKey: 'prepare:a' }),
  };

  test('refuses a context no log could be followed through, whatever is asked of it', async () => {
    for (const attempt of Object.values(attempts)) {
      const error = await refusal(() => attempt(queue, { actor: '', permissions: [], correlationId: 'x' }));
      expect(error.kind).toBe('context');
    }
    expect(scripted.calls).toEqual([]);
  });

  test('refuses every call the actor has not been granted, naming the permission it needs', async () => {
    const context = requestContext({ actor: 'account:7f3a', permissions: [], correlationId: 'req-0f9c2a41' });
    for (const [permission, attempt] of Object.entries(attempts)) {
      const error = await refusal(() => attempt(queue, context));
      expect(error.kind).toBe('permission');
      expect(error.message).toContain(permission);
    }
    expect(scripted.calls).toEqual([]);
  });

  test('a worker may run and read jobs, and may not enqueue or requeue them', async () => {
    const context = workerContext('worker-a-1');
    for (const permission of ['jobs.enqueue', 'jobs.requeue']) {
      const error = await refusal(() => attempts[permission]?.(queue, context) ?? Promise.reject(new Error('no')));
      expect(error.kind).toBe('permission');
    }
    open({ findOneAndUpdate: [null], find: [[]] });
    await expect(queue.claim(context, { worker: WORKER, kinds: ['prepare'] })).resolves.toBeUndefined();
    await expect(queue.list(context)).resolves.toEqual([]);
  });

  test('every heartbeat, success and release needs the permission to run jobs', async () => {
    const context = requestContext({ actor: 'account:7f3a', permissions: [], correlationId: 'req-0f9c2a41' });
    const runs = [
      () => queue.heartbeat(context, { worker: WORKER, id: 'job-1' }),
      () => queue.succeed(context, { worker: WORKER, id: 'job-1' }),
      () => queue.fail(context, { worker: WORKER, id: 'job-1', error: 'no' }),
      () => queue.recover(context),
      () => queue.summary(context),
    ];
    for (const run of runs) {
      const error = await refusal(run);
      expect(error.kind).toBe('permission');
    }
    expect(scripted.calls).toEqual([]);
  });
});
