// The job queue: a leased Mongo collection, and the only way work is handed to a worker.
//
// Jobs are operational state, not history, so they do not go through the repositories in records.ts —
// that layer has no update verb on purpose (ADR 0009), and a lease is nothing but an update. The queue
// owns one collection instead, and keeps the two promises a lease exists for: one claim wins a race,
// because claiming is a single conditional update the database performs; and work a worker abandoned is
// recovered, because the lease it left behind runs out and the attempt it used up is counted.
//
// Every time here is written by one clock in one format, because the database compares a lease as text.

import { randomUUID } from 'node:crypto';

import { JOB_FIELDS, JOB_STATES, parseJobRecord } from '@holydeck/contracts/jobs';

import { contextProblems, requestContext } from './context.js';
import { droppedIndex } from './repositories.js';

import type { JobPayload, JobRecord, JobState, LeasedJob } from '@holydeck/contracts/jobs';
import type { Db } from 'mongodb';

import type { RequestContext } from './context.js';
import type { Document, Filter, ReadOptions } from './repositories.js';

export const JOBS_COLLECTION = 'jobs';

/** What an actor needs to reach the queue. Running jobs is the worker's; requeuing one is an administrator's. */
export const QUEUE_PERMISSIONS = Object.freeze({
  enqueue: 'jobs.enqueue',
  run: 'jobs.run',
  read: 'jobs.read',
  requeue: 'jobs.requeue',
} as const);

export type QueueNeed = keyof typeof QUEUE_PERMISSIONS;

/** Five attempts, and the fifth failure retires the job rather than queueing a sixth. */
export const DEFAULT_RETRY_LIMIT = 5;

/** How long a claim holds a job without a heartbeat. Long enough to start work, short enough to recover. */
export const DEFAULT_LEASE_MS = 30_000;

/** How many abandoned jobs one recovery sweeps, so recovery is a step in a worker's loop and not the loop. */
export const DEFAULT_SWEEP = 25;

export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 500;

/** What a job says happened when the worker holding it stopped saying anything at all. */
export const LEASE_LOST = 'the attempt stopped without a result and its lease ran out';

export interface QueueIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// The key is unique: that index is what makes a replayed key one job rather than two. The claim's index
// carries every field the claim filters and sorts by, because every worker runs that query on every tick.
const DECLARED_INDEXES: readonly QueueIndex[] = [
  { name: 'job_key', keys: { idempotencyKey: 1 }, options: { unique: true } },
  { name: 'job_claim', keys: { state: 1, kind: 1, leaseExpiresAt: 1, queuedAt: 1 }, options: {} },
];

export const QUEUE_INDEXES = Object.freeze(DECLARED_INDEXES);

export type QueueRefusal = 'context' | 'permission' | 'schema' | 'lease' | 'state' | 'duplicate';

/** Carries why the call was refused, so a caller can tell a defect from a lease it lost fairly. */
export class QueueError extends Error {
  readonly kind: QueueRefusal;

  constructor(kind: QueueRefusal, message: string) {
    super(message);
    this.name = 'QueueError';
    this.kind = kind;
  }
}

export interface FindOneAndUpdateOptions {
  readonly sort?: Readonly<Record<string, 1 | -1>>;
  readonly returnDocument: 'after';
}

/** The slice of a Mongo collection the queue uses. Narrow on purpose: a test can supply all of it. */
export interface QueueCollection {
  insertOne(document: Document): Promise<{ insertedId: unknown }>;
  findOne(filter: Filter): Promise<Document | null>;
  findOneAndUpdate(
    filter: Filter,
    update: readonly Document[] | Document,
    options: FindOneAndUpdateOptions,
  ): Promise<Document | null>;
  updateOne(filter: Filter, update: Document): Promise<{ matchedCount: number }>;
  find(filter: Filter, options?: ReadOptions): { toArray(): Promise<Document[]> };
  countDocuments(filter: Filter): Promise<number>;
  createIndex(keys: Readonly<Record<string, 1 | -1>>, options?: Readonly<Record<string, unknown>>): Promise<string>;
  dropIndex(index: string): Promise<void>;
}

export interface QueueDb {
  collection(name: string): QueueCollection;
}

/**
 * Building an index needs no queue verb, so the call asks for none: a migration runs against the database
 * the durable records are written through, which answers with a collection that can index and nothing else.
 */
export interface IndexDb {
  collection(name: string): Pick<QueueCollection, 'createIndex' | 'dropIndex'>;
}

/** The context a worker runs under: the product acting as itself, allowed to run jobs and to read them. */
export function workerContext(correlationId: string): RequestContext {
  return requestContext({
    actor: 'system',
    permissions: [QUEUE_PERMISSIONS.run, QUEUE_PERMISSIONS.read],
    correlationId,
  });
}

/**
 * The context the scheduler runs under: the product acting as itself, allowed to enqueue what is due, see
 * what already failed, and requeue a due job whose earlier attempt was retired — never to run one itself.
 */
export function schedulerContext(correlationId: string): RequestContext {
  return requestContext({
    actor: 'system',
    permissions: [QUEUE_PERMISSIONS.enqueue, QUEUE_PERMISSIONS.read, QUEUE_PERMISSIONS.requeue],
    correlationId,
  });
}

// Mongo compares `leaseExpiresAt` as a string, which is the comparison of the instants it names only while
// every one of them is written the same way. A clock that writes them any other way is refused here rather
// than producing a lease that never expires or one that expires at once.
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const checkTime = (value: string): string => {
  if (!CANONICAL_TIME.test(value)) {
    throw new QueueError(
      'schema',
      `a lease is compared as text, so ${value} has to be an instant in UTC written with milliseconds`,
    );
  }
  return value;
};

export const leaseExpiry = (now: string, leaseMs: number): string =>
  new Date(Date.parse(checkTime(now)) + leaseMs).toISOString();

const RECLAIMED = { $eq: ['$state', 'leased'] };
const EXHAUSTED = { $gte: ['$attempt', '$retryLimit'] };
const RETIRED = { $and: [RECLAIMED, EXHAUSTED] };

/** A job of one of these kinds that nobody is running: queued, or leased to a worker that went quiet. */
export function claimFilter(kinds: readonly string[], now: string): Filter {
  return {
    kind: { $in: [...kinds] },
    $or: [{ state: 'queued' }, { state: 'leased', leaseExpiresAt: { $lte: checkTime(now) } }],
  };
}

/**
 * One update with three outcomes, which is what makes the claim atomic: a queued job is leased as the
 * attempt it already is; one whose lease ran out is leased as the next attempt, and says why there is a
 * next one; and one with no attempt left is retired instead, so the worker finds it once and never again.
 */
export function claimUpdate(worker: string, now: string, leaseMs: number): Document[] {
  return [
    {
      $set: {
        state: { $cond: [RETIRED, 'failed', 'leased'] },
        attempt: { $cond: [{ $and: [RECLAIMED, { $not: EXHAUSTED }] }, { $add: ['$attempt', 1] }, '$attempt'] },
        workers: { $cond: [RETIRED, '$workers', [worker]] },
        leaseExpiresAt: { $cond: [RETIRED, '$$REMOVE', leaseExpiry(now, leaseMs)] },
        heartbeatAt: { $cond: [RETIRED, '$$REMOVE', now] },
        lastError: { $cond: [RECLAIMED, LEASE_LOST, '$lastError'] },
      },
    },
  ];
}

/**
 * Letting a job go, whether the attempt failed or its lease ran out: the two leave the same job behind and
 * differ only in what there is to tell an operator, so the reason is carried rather than implied. A job
 * whose last attempt this was keeps the worker that held it, because a failure nobody is named in is a
 * failure nobody can look into.
 */
export function releaseUpdate(error: string): Document[] {
  return [
    {
      $set: {
        state: { $cond: [EXHAUSTED, 'failed', 'queued'] },
        attempt: { $cond: [EXHAUSTED, '$attempt', { $add: ['$attempt', 1] }] },
        workers: { $cond: [EXHAUSTED, '$workers', []] },
        leaseExpiresAt: '$$REMOVE',
        heartbeatAt: '$$REMOVE',
        lastError: error,
      },
    },
  ];
}

export function enqueueDocument(input: {
  readonly id: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: JobPayload;
  readonly retryLimit: number;
  readonly queuedAt: string;
}): Document {
  return {
    _id: input.id,
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    state: 'queued',
    attempt: 1,
    retryLimit: input.retryLimit,
    queuedAt: input.queuedAt,
    workers: [],
  };
}

/**
 * Grades a stored document against the contract. The identifier lives in `_id`, where Mongo keeps it, and
 * is carried across as it was stored rather than coerced: a job's identifier is text, so a document
 * holding anything else there is a document this code cannot read, which is the parser's answer to give.
 */
export function jobFrom(document: Document): JobRecord {
  const { _id: id, ...fields } = document;
  const parsed = parseJobRecord({ ...fields, id });
  if (!parsed.ok) {
    const problems = parsed.problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ');
    throw new QueueError('schema', `the queue holds a job this code cannot read: ${problems}`);
  }
  return parsed.value;
}

const SERIES = /#(\d+)$/u;

const familyOf = (key: string): string => key.replace(SERIES, '');

const asText = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Every key a requeue can have given the same work: the key it was enqueued under, and the numbered ones
 * an administrator's requeues produced. A producer replaying the original key has to find the requeued job
 * — otherwise it queues a second job doing the work the first one is already queued to do.
 */
export function familyFilter(key: string): Filter {
  return { idempotencyKey: { $regex: `^${asText(familyOf(key))}(?:#\\d+)?$` } };
}

export function requeueKey(key: string): string {
  const series = SERIES.exec(key);
  return series === null ? `${key}#2` : `${familyOf(key)}#${Number(series[1]) + 1}`;
}

const isDuplicate = (error: unknown): boolean => (error as { code?: unknown }).code === 11_000;

const carries = (field: string): boolean =>
  field === '_id' || (field !== 'id' && (JOB_FIELDS as readonly string[]).includes(field));

const declaredIndex = (name: string): QueueIndex => {
  const index = QUEUE_INDEXES.find((candidate) => candidate.name === name);
  if (index === undefined) throw new QueueError('schema', `${name} is not an index the queue declares`);
  return index;
};

/**
 * Indexes are not jobs: building one changes how the collection is read, never what it holds, which is why
 * a migration may do it. Only the ones the queue declares, and only on fields a job carries.
 */
export function createQueueIndexOn(db: IndexDb, index: QueueIndex): Promise<string> {
  declaredIndex(index.name);
  for (const field of Object.keys(index.keys)) {
    if (!carries(field)) throw new QueueError('schema', `${index.name}: a job carries no field named ${field}`);
  }
  return db.collection(JOBS_COLLECTION).createIndex(index.keys, { name: index.name, ...index.options });
}

export function dropQueueIndexOn(db: IndexDb, name: string): Promise<void> {
  declaredIndex(name);
  return droppedIndex(() => db.collection(JOBS_COLLECTION).dropIndex(name));
}

export interface QueueOptions {
  /** Injected so a test can pin a lease, and so every time in one queue comes from one clock. */
  readonly now: () => string;
  readonly newId?: () => string;
  readonly leaseMs?: number;
}

export interface Queue {
  enqueue(
    context: unknown,
    input: { readonly kind: string; readonly idempotencyKey: string; readonly payload?: JobPayload; readonly retryLimit?: number },
  ): Promise<{ readonly id: string; readonly created: boolean }>;
  claim(
    context: unknown,
    input: { readonly worker: string; readonly kinds: readonly string[] },
  ): Promise<LeasedJob | undefined>;
  heartbeat(context: unknown, input: { readonly worker: string; readonly id: string }): Promise<boolean>;
  succeed(context: unknown, input: { readonly worker: string; readonly id: string }): Promise<JobRecord>;
  fail(
    context: unknown,
    input: { readonly worker: string; readonly id: string; readonly error: string },
  ): Promise<JobRecord>;
  recover(context: unknown, options?: { readonly limit?: number }): Promise<readonly JobRecord[]>;
  list(
    context: unknown,
    input?: {
      readonly states?: readonly JobState[];
      readonly kinds?: readonly string[];
      readonly limit?: number;
    },
  ): Promise<readonly JobRecord[]>;
  summary(context: unknown): Promise<Readonly<Record<JobState, number>>>;
  requeue(
    context: unknown,
    input: { readonly id: string; readonly idempotencyKey: string },
  ): Promise<JobRecord>;
}

const checkName = (worker: string): string => {
  if (worker.trim() === '') throw new QueueError('schema', 'a lease names the worker holding it, and this one names none');
  return worker;
};

const checkReason = (error: string): string => {
  if (error.trim() === '') {
    throw new QueueError('schema', 'a failed attempt says what went wrong, because an operator reads nothing else');
  }
  return error;
};

const heldBy = (id: string, worker: string, now: string): Filter => ({
  _id: id,
  state: 'leased',
  workers: [worker],
  leaseExpiresAt: { $gt: now },
});

const lost = (id: string, worker: string): QueueError =>
  new QueueError('lease', `job ${id}: ${worker} no longer holds the lease, so this attempt is not the queue’s to record`);

/** The queue over one database. Nothing here reads an ambient clock, a global database or a current user. */
export function queueOn(db: QueueDb, options: QueueOptions): Queue {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const newId = options.newId ?? ((): string => randomUUID());
  const collection = (): QueueCollection => db.collection(JOBS_COLLECTION);
  const clock = (): string => checkTime(options.now());

  const permit = (context: unknown, need: QueueNeed): RequestContext => {
    const problems = contextProblems(context);
    if (problems.length > 0) throw new QueueError('context', `jobs: ${problems.join('; ')}`);
    const permission = QUEUE_PERMISSIONS[need];
    if (!(context as RequestContext).permissions.includes(permission)) {
      throw new QueueError('permission', `jobs: the actor may not ${need}, which needs ${permission}`);
    }
    return context as RequestContext;
  };

  const whole = (count: number, most: number, what: string): number => {
    if (!Number.isInteger(count) || count < 1 || count > most) {
      throw new QueueError('schema', `${what}, not ${String(count)}`);
    }
    return count;
  };

  const queue: Queue = {
    async enqueue(context, { kind, idempotencyKey, payload = {}, retryLimit = DEFAULT_RETRY_LIMIT }) {
      permit(context, 'enqueue');
      whole(retryLimit, Number.MAX_SAFE_INTEGER, 'a retry limit is a count of attempts');
      const id = newId();
      const document = enqueueDocument({ id, kind, idempotencyKey, payload, retryLimit, queuedAt: clock() });
      // Graded before the database holds it: a job the contract refuses is a job no worker could read back.
      jobFrom(document);
      const family = familyFilter(idempotencyKey);
      const existing = await collection().findOne(family);
      if (existing !== null) return { id: jobFrom(existing).id, created: false };
      try {
        await collection().insertOne(document);
      } catch (error) {
        if (!isDuplicate(error)) throw error;
        // The key arrived between the look and the insert. The index refused it, which is the answer.
        const raced = await collection().findOne(family);
        if (raced === null) throw new QueueError('duplicate', `job ${id}: the queue already holds that identifier`);
        return { id: jobFrom(raced).id, created: false };
      }
      return { id, created: true };
    },

    async claim(context, { worker, kinds }) {
      permit(context, 'run');
      const name = checkName(worker);
      if (kinds.length === 0) {
        throw new QueueError('schema', 'a claim names the kinds of job this worker runs, and this one names none');
      }
      const now = clock();
      const filter = claimFilter(kinds, now);
      const update = claimUpdate(name, now, leaseMs);
      for (;;) {
        const document = await collection().findOneAndUpdate(filter, update, {
          sort: { queuedAt: 1 },
          returnDocument: 'after',
        });
        if (document === null) return undefined;
        const job = jobFrom(document);
        // The claim retired a job that had no attempt left. That was worth doing and is not work to run.
        if (job.state === 'leased') return job;
      }
    },

    async heartbeat(context, { worker, id }) {
      permit(context, 'run');
      const now = clock();
      const { matchedCount } = await collection().updateOne(heldBy(id, checkName(worker), now), {
        $set: { heartbeatAt: now, leaseExpiresAt: leaseExpiry(now, leaseMs) },
      });
      return matchedCount === 1;
    },

    async succeed(context, { worker, id }) {
      permit(context, 'run');
      const name = checkName(worker);
      const now = clock();
      const document = await collection().findOneAndUpdate(
        heldBy(id, name, now),
        { $set: { state: 'succeeded' }, $unset: { leaseExpiresAt: '', heartbeatAt: '' } },
        { returnDocument: 'after' },
      );
      if (document === null) throw lost(id, name);
      return jobFrom(document);
    },

    async fail(context, { worker, id, error }) {
      permit(context, 'run');
      const name = checkName(worker);
      const reason = checkReason(error);
      const document = await collection().findOneAndUpdate(heldBy(id, name, clock()), releaseUpdate(reason), {
        returnDocument: 'after',
      });
      if (document === null) throw lost(id, name);
      return jobFrom(document);
    },

    async recover(context, { limit = DEFAULT_SWEEP } = {}) {
      permit(context, 'run');
      whole(limit, Number.MAX_SAFE_INTEGER, 'a recovery sweeps at least one job');
      const now = clock();
      const update = releaseUpdate(LEASE_LOST);
      const released: JobRecord[] = [];
      while (released.length < limit) {
        const document = await collection().findOneAndUpdate(
          { state: 'leased', leaseExpiresAt: { $lte: now } },
          update,
          { sort: { leaseExpiresAt: 1 }, returnDocument: 'after' },
        );
        if (document === null) break;
        released.push(jobFrom(document));
      }
      return Object.freeze(released);
    },

    async list(context, { states, kinds, limit = DEFAULT_PAGE } = {}) {
      permit(context, 'read');
      whole(limit, MAX_PAGE, `a page of jobs is between 1 and ${MAX_PAGE} of them`);
      const filter: Filter = {
        ...(states === undefined ? {} : { state: { $in: [...states] } }),
        ...(kinds === undefined ? {} : { kind: { $in: [...kinds] } }),
      };
      const rows = await collection().find(filter, { sort: { queuedAt: -1 }, limit }).toArray();
      return Object.freeze(rows.map((row) => jobFrom(row)));
    },

    async summary(context) {
      permit(context, 'read');
      const counts = await Promise.all(
        JOB_STATES.map(async (state) => [state, await collection().countDocuments({ state })] as const),
      );
      return Object.freeze(Object.fromEntries(counts)) as Readonly<Record<JobState, number>>;
    },

    async requeue(context, { id, idempotencyKey }) {
      permit(context, 'requeue');
      const next = requeueKey(idempotencyKey);
      const now = clock();
      let document: Document | null;
      try {
        document = await collection().findOneAndUpdate(
          { _id: id, state: 'failed' },
          {
            $set: { state: 'queued', attempt: 1, queuedAt: now, workers: [], idempotencyKey: next },
            $unset: { leaseExpiresAt: '', heartbeatAt: '' },
          },
          { returnDocument: 'after' },
        );
      } catch (error) {
        if (!isDuplicate(error)) throw error;
        throw new QueueError('duplicate', `job ${id}: ${next} is already another job’s key`);
      }
      if (document === null) {
        throw new QueueError('state', `job ${id}: only a job that failed is an administrator’s to requeue`);
      }
      return jobFrom(document);
    },
  };
  return Object.freeze(queue);
}

/**
 * The driver satisfies this interface in practice; the cast is about the document types the driver reports,
 * which nothing here reads back except through `jobFrom`.
 */
export function queueDb(db: Db): QueueDb {
  return { collection: (name) => db.collection(name) as unknown as QueueCollection };
}
