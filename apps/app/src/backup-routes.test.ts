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
import { BACKUP_MANAGE } from './roles.js';
import { BACKUPS_PATH, serveBackupRoutes } from './backup-routes.js';
import { requestContext } from './context.js';
import { QUEUE_PERMISSIONS, queueOn } from './queue.js';
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
const queueContext = requestContext({
  actor: ADMINISTRATOR,
  correlationId: CORRELATION,
  permissions: [QUEUE_PERMISSIONS.read],
});

let app: FastifyInstance;
let sessions: SessionStore;
let trail: FakeDb;
let identity: Identity;
let queue: Queue;
let admin: StartedSession;
let jobs: Document[];

const leased = (kind: string): Document => ({
  _id: 'running',
  kind,
  state: 'leased',
  payload: {},
  workers: ['worker-1'],
  idempotencyKey: `${kind}:previous`,
  attempt: 1,
  retryLimit: 2,
  queuedAt: NOW,
  heartbeatAt: NOW,
  leaseExpiresAt: '2026-09-21T23:31:00.000Z',
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
const requesting = (payload: unknown = {}, held: StartedSession = admin) =>
  app.inject({ method: 'POST', url: BACKUPS_PATH, headers: withHeaders(held), payload: payload as never });

const served = async (missing?: 'db' | 'queue' | 'identity' | 'all'): Promise<FastifyInstance> => {
  const built = Fastify({ logger: false });
  withSafeErrors(built);
  guardMutations(built, { sessions });
  enforceAuthorization(built, { sessions, identity: undefined });
  serveBackupRoutes(built, {
    db: missing === 'db' || missing === 'all' ? undefined : trail,
    queue: missing === 'queue' || missing === 'all' ? undefined : queue,
    identity: missing === 'identity' || missing === 'all' ? undefined : identity,
    now,
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
      verify: async (password, stored) => stored === `test-hash:${password}`,
    }),
    audit: auditOn(trail, { now, newId: () => `e${entries().length}` }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  jobs = [];
  const db: QueueDb = {
    collection: () => ({
      async insertOne(document) {
        jobs.push(document);
        return { insertedId: document['_id'] };
      },
      findOne: async () => null,
      findOneAndUpdate: async () => null,
      updateOne: async () => ({ matchedCount: 0 }),
      find: (filter) => ({
        toArray: async () => jobs.filter((job) => Object.entries(filter).every(([key, value]) =>
          typeof value === 'object' && value !== null && '$in' in value
            ? (value.$in as unknown[]).includes(job[key]) : job[key] === value,
        )),
      }),
      countDocuments: async () => jobs.length,
      createIndex: async () => '',
      dropIndex: async () => {},
    }),
  };
  queue = queueOn(db, { now, newId: () => 'job-1' });
  app = await served();
  admin = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [BACKUP_MANAGE] });
});

afterEach(async () => {
  await app.close();
});

describe('recorded backups and on-demand requests', () => {
  test('lists recorded backups in a collection envelope', async () => {
    const manifest = {
      id: 'backup-1',
      createdAt: NOW,
      schemaVersion: 19,
      contents: [{ class: 'settings', count: 1, bytes: 12, hash: 'restic:settings-snap' }],
      excludedSecrets: [],
    };
    const consistency = { pointInTime: true, method: 'snapshot' };
    trail.rows.set('backups', [{
      _id: 'backup:backup-1',
      actor: ADMINISTRATOR,
      correlationId: CORRELATION,
      backupId: 'backup-1',
      at: NOW,
      manifest,
      consistency,
    }]);
    const response = await app.inject({ method: 'GET', url: BACKUPS_PATH, headers: withHeaders() });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ backups: [{
      backupId: 'backup-1',
      at: NOW,
      production: { manifest, consistency },
      snapshots: ['settings-snap'],
    }] });
  });

  test.each([{}, { components: ['settings'] }])(
    'queues a request under its own key, never the scheduler’s daily one, and audits allowance: %j',
    async (payload) => {
      const response = await requesting(payload);
      expect(response.statusCode).toBe(202);
      expect(response.json().data).toEqual({ id: 'job-1', created: true });
      expect(await queue.list(queueContext)).toMatchObject([{
        kind: 'backup-run',
        idempotencyKey: `backup-run:operator:${NOW}`,
        payload: {
          components: 'components' in payload ? ['settings'] : ['mongo', 'settings', 'media'],
          trigger: 'operator',
        },
      }]);
      expect(entries()).toHaveLength(1);
      expect(entries()[0]).toMatchObject({
        actor: ADMINISTRATOR,
        action: 'backup.request',
        subject: 'backup-run',
        outcome: 'allowed',
        detail: 'requested on demand',
      });
    },
  );

  test('defaults a request without a body to all components', async () => {
    const response = await app.inject({ method: 'POST', url: BACKUPS_PATH, headers: withHeaders() });
    expect(response.statusCode).toBe(202);
    expect(jobs[0]?.['payload']).toEqual({ components: ['mongo', 'settings', 'media'], trigger: 'operator' });
  });

  test.each([{ components: [] }, { components: ['bogus'] }])('refuses invalid components $components before enqueueing', async (payload) => {
    const response = await requesting(payload);
    expect(response.statusCode).toBe(422);
    expect(jobs).toEqual([]);
    expect(entries()).toEqual([]);
  });

  test('refuses and audits an already leased backup', async () => {
    jobs.push(leased('backup-run'));
    const response = await requesting();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
    expect(jobs).toHaveLength(1);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      actor: ADMINISTRATOR,
      action: 'backup.request',
      subject: 'backup-run',
      outcome: 'refused',
    });
  });

  test('a leased job of another kind does not block a backup', async () => {
    jobs.push(leased('prepare'));
    expect((await requesting()).statusCode).toBe(202);
  });

  test('a failed audit append does not lose an accepted request', async () => {
    identity = { ...identity, audit: { record: vi.fn(async () => { throw new Error('trail unavailable'); }) } };
    await app.close();
    app = await served();
    expect((await requesting()).statusCode).toBe(202);
    expect(jobs).toHaveLength(1);
  });
});

describe('who may ask for backups', () => {
  test('registers the trigger behind the mutation guard', () => {
    expect(mutatingRoutesOf(app)).toEqual([{ method: 'POST', url: BACKUPS_PATH }]);
  });

  test.each(['GET', 'POST'] as const)('refuses %s without backup.manage', async (method) => {
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [] });
    const response = await app.inject({ method, url: BACKUPS_PATH, headers: withHeaders(guest) });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
    expect(jobs).toEqual([]);
  });

  test.each(['db', 'queue', 'identity', 'all'] as const)('answers not-found without %s', async (missing) => {
    await app.close();
    app = await served(missing);
    for (const method of ['GET', 'POST'] as const) {
      const response = await app.inject({ method, url: BACKUPS_PATH, headers: withHeaders() });
      expect(response.statusCode).toBe(404);
    }
  });
});
