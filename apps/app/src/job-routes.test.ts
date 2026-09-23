import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { JOBS_PATH, serveJobRoutes } from './job-routes.js';
import { QueueError, queueOn } from './queue.js';
import { JOBS_MANAGE, JOBS_READ } from './roles.js';
import { passkeysOn } from './passkeys.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { Queue, QueueDb } from './queue.js';
import type { Document } from './repositories.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const NOW = '2026-09-21T23:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const ADMINISTRATOR = 'account:' + 'C'.repeat(22);
const now = (): string => NOW;

let app: FastifyInstance;
let sessions: SessionStore;
let trail: FakeDb;
let identity: Identity;
let queue: Queue;
let admin: StartedSession;
let jobs: Document[];

const matches = (document: Document, filter: Record<string, unknown>): boolean =>
  Object.entries(filter).every(([key, value]) => {
    if (typeof value === 'object' && value !== null && '$in' in value) {
      return (value as { $in: readonly unknown[] }).$in.includes(document[key]);
    }
    return document[key] === value;
  });

const fakeQueueDb = (): QueueDb => ({
  collection: () => ({
    async insertOne(document) {
      jobs.push(document);
      return { insertedId: document['_id'] };
    },
    findOne: async (filter) => jobs.find((job) => matches(job, filter as Record<string, unknown>)) ?? null,
    async findOneAndUpdate(filter, update) {
      const index = jobs.findIndex((job) => matches(job, filter as Record<string, unknown>));
      if (index === -1) return null;
      const stage = update as { readonly $set?: Document; readonly $unset?: Readonly<Record<string, unknown>> };
      const current = jobs[index]!;
      const next: Record<string, unknown> = { ...current, ...(stage.$set ?? {}) };
      for (const key of Object.keys(stage.$unset ?? {})) delete next[key];
      jobs[index] = next;
      return next;
    },
    updateOne: async () => ({ matchedCount: 0 }),
    find: (filter, options) => ({
      toArray: async () => {
        const rows = jobs.filter((job) => matches(job, filter as Record<string, unknown>));
        const sorted = [...rows].sort((left, right) => String(right['queuedAt']).localeCompare(String(left['queuedAt'])));
        return options?.limit === undefined ? sorted : sorted.slice(0, options.limit);
      },
    }),
    countDocuments: async (filter) => jobs.filter((job) => matches(job, filter as Record<string, unknown>)).length,
    createIndex: async () => '',
    dropIndex: async () => {},
  }),
});

const stored = (fields: Document): Document => ({
  idempotencyKey: `${String(fields['kind'])}:${String(fields['_id'])}`,
  payload: {},
  attempt: 5,
  retryLimit: 5,
  queuedAt: NOW,
  workers: ['worker-1'],
  ...fields,
});

const entries = (): Document[] => trail.rows.get('audit_events') ?? [];
const withHeaders = (held: StartedSession = admin) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  cookie: sessionCookie(held.token, 60),
  [CSRF_HEADER]: held.record.csrf,
});

const served = async (missing?: 'queue' | 'identity' | 'all'): Promise<FastifyInstance> => {
  const built = Fastify({ logger: false });
  withSafeErrors(built);
  guardMutations(built, { sessions });
  enforceAuthorization(built, { sessions, identity: undefined });
  serveJobRoutes(built, {
    queue: missing === 'queue' || missing === 'all' ? undefined : queue,
    identity: missing === 'identity' || missing === 'all' ? undefined : identity,
  });
  await built.ready();
  return built;
};

beforeEach(async () => {
  trail = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now });
  identity = {
    accounts: accountsOn(memoryAccounts().db, {
      now,
      newId: () => 'A'.repeat(22),
      hash: async (password) => `test-hash:${password}`,
      verify: async (password, stored_) => stored_ === `test-hash:${password}`,
    }),
    audit: auditOn(trail, { now, newId: () => `e${entries().length}` }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  jobs = [];
  queue = queueOn(fakeQueueDb(), { now, newId: () => 'job-new' });
  app = await served();
  admin = await sessions.start(sessionContext(CORRELATION), {
    actor: ADMINISTRATOR,
    permissions: [JOBS_READ, JOBS_MANAGE],
  });
});

afterEach(async () => {
  await app.close();
});

describe('what the queue is doing', () => {
  test('lists every job with no filter, newest first', async () => {
    jobs.push(
      stored({ _id: 'job-1', kind: 'backup-run', state: 'succeeded', queuedAt: '2026-09-21T20:00:00.000Z' }),
      stored({ _id: 'job-2', kind: 'restore-apply', state: 'failed', queuedAt: '2026-09-21T22:00:00.000Z' }),
    );
    const response = await app.inject({ method: 'GET', url: JOBS_PATH, headers: withHeaders() });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.jobs.map((job: { id: string }) => job.id)).toEqual(['job-2', 'job-1']);
  });

  test('filters by comma-separated kind and state', async () => {
    jobs.push(
      stored({ _id: 'job-1', kind: 'backup-run', state: 'failed' }),
      stored({ _id: 'job-2', kind: 'restore-apply', state: 'failed' }),
      stored({ _id: 'job-3', kind: 'backup-run', state: 'succeeded' }),
    );
    const response = await app.inject({
      method: 'GET',
      url: `${JOBS_PATH}?kind=backup-run,restore-apply&state=failed`,
      headers: withHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.jobs.map((job: { id: string }) => job.id).sort()).toEqual(['job-1', 'job-2']);
  });

  test('summarizes counts per state', async () => {
    jobs.push(
      stored({ _id: 'job-1', kind: 'backup-run', state: 'queued' }),
      stored({ _id: 'job-2', kind: 'backup-run', state: 'failed' }),
      stored({ _id: 'job-3', kind: 'backup-run', state: 'failed' }),
    );
    const response = await app.inject({ method: 'GET', url: `${JOBS_PATH}/summary`, headers: withHeaders() });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.summary).toEqual({ queued: 1, leased: 0, succeeded: 0, failed: 2 });
  });
});

describe('trying a failed job again', () => {
  test('requeues a failed job, answers 200, and audits allowance', async () => {
    jobs.push(stored({ _id: 'job-1', kind: 'backup-run', state: 'failed', idempotencyKey: 'backup-run:2026-09-21' }));
    const response = await app.inject({ method: 'POST', url: `${JOBS_PATH}/job-1/requeue`, headers: withHeaders() });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      id: 'job-1',
      state: 'queued',
      attempt: 1,
      idempotencyKey: 'backup-run:2026-09-21#2',
    });
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ actor: ADMINISTRATOR, action: 'job.requeue', subject: 'job-1', outcome: 'allowed' });
  });

  test('answers not-found for an id no failed job carries', async () => {
    jobs.push(stored({ _id: 'job-1', kind: 'backup-run', state: 'queued' }));
    const response = await app.inject({ method: 'POST', url: `${JOBS_PATH}/job-1/requeue`, headers: withHeaders() });
    expect(response.statusCode).toBe(404);
    expect(entries()).toEqual([]);
  });

  test('answers not-found for an id nothing carries at all', async () => {
    const response = await app.inject({ method: 'POST', url: `${JOBS_PATH}/nope/requeue`, headers: withHeaders() });
    expect(response.statusCode).toBe(404);
    expect(entries()).toEqual([]);
  });

  // `Queue.get` looks the job up by its own id rather than paging through `Queue.list` — so a failed job
  // that would not appear on the first (or only) page a list call returns is still requeued here.
  test('requeues a failed job even when it would not fall on the first page of a list', async () => {
    jobs.push(stored({ _id: 'job-1', kind: 'backup-run', state: 'failed', idempotencyKey: 'backup-run:2026-09-21' }));
    const pagedOut: Queue = { ...queue, list: async () => [] };
    const pagedApp = Fastify({ logger: false });
    withSafeErrors(pagedApp);
    guardMutations(pagedApp, { sessions });
    enforceAuthorization(pagedApp, { sessions, identity: undefined });
    serveJobRoutes(pagedApp, { queue: pagedOut, identity });
    await pagedApp.ready();
    const response = await pagedApp.inject({ method: 'POST', url: `${JOBS_PATH}/job-1/requeue`, headers: withHeaders() });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ id: 'job-1', state: 'queued' });
    await pagedApp.close();
  });

  test('answers conflict and audits refusal when the job stopped being failed between get and requeue', async () => {
    const flaky: Queue = {
      ...queue,
      get: async () => ({
        id: 'job-9', kind: 'backup-run', idempotencyKey: 'backup-run:job-9', state: 'failed',
        attempt: 5, retryLimit: 5, queuedAt: NOW, workers: [], payload: {}, lastError: undefined,
        leaseExpiresAt: undefined, heartbeatAt: undefined,
      }),
      requeue: async () => {
        throw new QueueError('state', 'job job-9: only a job that failed is an administrator’s to requeue');
      },
    };
    const flakyApp = Fastify({ logger: false });
    withSafeErrors(flakyApp);
    guardMutations(flakyApp, { sessions });
    enforceAuthorization(flakyApp, { sessions, identity: undefined });
    serveJobRoutes(flakyApp, { queue: flaky, identity });
    await flakyApp.ready();
    const response = await flakyApp.inject({ method: 'POST', url: `${JOBS_PATH}/job-9/requeue`, headers: withHeaders() });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ action: 'job.requeue', subject: 'job-9', outcome: 'refused' });
    await flakyApp.close();
  });

  test.each(['restore-apply', 'media-root-migrate'] as const)(
    'refuses to requeue a failed %s job, which skips its own step-up and freshness checks',
    async (kind) => {
      jobs.push(stored({ _id: 'job-1', kind, state: 'failed' }));
      const response = await app.inject({ method: 'POST', url: `${JOBS_PATH}/job-1/requeue`, headers: withHeaders() });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe(ENTITY_CONFLICT);
      expect(entries()).toHaveLength(1);
      expect(entries()[0]).toMatchObject({ actor: ADMINISTRATOR, action: 'job.requeue', subject: 'job-1', outcome: 'refused' });
      expect(jobs.find((job) => job['_id'] === 'job-1')).toMatchObject({ state: 'failed' });
    },
  );

  test('a failed audit append does not lose an accepted requeue', async () => {
    jobs.push(stored({ _id: 'job-1', kind: 'backup-run', state: 'failed', idempotencyKey: 'backup-run:2026-09-21' }));
    identity = {
      ...identity,
      audit: {
        record: vi.fn(async () => { throw new Error('trail unavailable'); }),
        list: vi.fn(async () => ({ entries: [] })),
      },
    };
    await app.close();
    app = await served();
    const response = await app.inject({ method: 'POST', url: `${JOBS_PATH}/job-1/requeue`, headers: withHeaders() });
    expect(response.statusCode).toBe(200);
  });
});

describe('who may see or change the queue', () => {
  test('registers only the requeue route behind the mutation guard', () => {
    expect(mutatingRoutesOf(app)).toEqual([{ method: 'POST', url: `${JOBS_PATH}/:id/requeue` }]);
  });

  test.each([
    ['GET', JOBS_PATH],
    ['GET', `${JOBS_PATH}/summary`],
    ['POST', `${JOBS_PATH}/job-1/requeue`],
  ] as const)('refuses %s %s with no permission at all', async (method, url) => {
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [] });
    const response = await app.inject({ method, url, headers: withHeaders(guest) });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
  });

  // `jobs.read` and `jobs.manage` are independent: holding one is not holding the other.
  test.each([
    ['GET', JOBS_PATH],
    ['GET', `${JOBS_PATH}/summary`],
  ] as const)('refuses %s %s to an actor who holds jobs.manage but not jobs.read', async (method, url) => {
    const manager = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [JOBS_MANAGE] });
    const response = await app.inject({ method, url, headers: withHeaders(manager) });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
  });

  test('refuses requeue to an actor who holds jobs.read but not jobs.manage', async () => {
    jobs.push(stored({ _id: 'job-1', kind: 'backup-run', state: 'failed', idempotencyKey: 'backup-run:2026-09-21' }));
    const reader = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [JOBS_READ] });
    const response = await app.inject({
      method: 'POST', url: `${JOBS_PATH}/job-1/requeue`, headers: withHeaders(reader),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
  });

  test.each(['queue', 'identity', 'all'] as const)('answers not-found without %s', async (missing) => {
    await app.close();
    app = await served(missing);
    for (const [method, url] of [
      ['GET', JOBS_PATH],
      ['GET', `${JOBS_PATH}/summary`],
      ['POST', `${JOBS_PATH}/job-1/requeue`],
    ] as const) {
      const response = await app.inject({ method, url, headers: withHeaders() });
      expect(response.statusCode).toBe(404);
    }
  });
});
