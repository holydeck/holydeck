import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { accountContext, accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { requestContext } from './context.js';
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { passkeysOn } from './passkeys.js';
import { QUEUE_PERMISSIONS, queueOn } from './queue.js';
import { RESTORE_MANAGE } from './roles.js';
import { RESTORES_PATH, serveRestoreRoutes } from './restore-routes.js';
import { RESTORE_RECORD } from './restores.js';
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

const NOW = '2026-09-22T09:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const ID = 'A'.repeat(22);
const CLAIM = { name: 'lucia', displayName: 'Lucia Brandt', password: 'a-long-enough-passphrase' };
const BACKUP_ID = 'backup-1';

const now = (): string => NOW;
const queueContext = requestContext({
  actor: actorFor(ID),
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

const rehearsal = (backupId: string, at: string): Document => ({
  _id: `restore:${backupId}:${at}`,
  actor: 'system',
  correlationId: CORRELATION,
  restoreId: `restore-${at}`,
  backupId,
  at,
  manifest: {},
  consistency: {},
  integrity: {},
  objectives: {},
  restore: {},
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
  app.inject({ method: 'POST', url: RESTORES_PATH, headers: withHeaders(held), payload: payload as never });

const served = async (missing?: 'db' | 'queue' | 'identity' | 'all'): Promise<FastifyInstance> => {
  const built = Fastify({ logger: false });
  withSafeErrors(built);
  guardMutations(built, { sessions });
  enforceAuthorization(built, { sessions, identity: undefined });
  serveRestoreRoutes(built, {
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
      newId: () => ID,
      hash: async (password) => `test-hash:${password}`,
      verify: async (password, stored) => stored === `test-hash:${password}`,
    }),
    audit: auditOn(trail, { now, newId: () => `e${entries().length}` }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  await identity.accounts.claim(accountContext('req-1a2b3c4d'), CLAIM);
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
  admin = await sessions.start(sessionContext(CORRELATION), { actor: actorFor(ID), permissions: [RESTORE_MANAGE] });
});

afterEach(async () => {
  await app.close();
});

describe('applying a recorded backup to production', () => {
  test('queues a request behind a passing rehearsal, and audits allowance', async () => {
    trail.rows.set(RESTORE_RECORD, [rehearsal(BACKUP_ID, '2026-09-22T08:30:00.000Z')]);
    const response = await requesting({ backupId: BACKUP_ID, confirm: BACKUP_ID, password: CLAIM.password });
    expect(response.statusCode).toBe(202);
    expect(response.json().data).toEqual({ id: 'job-1', created: true });
    expect(await queue.list(queueContext)).toMatchObject([{
      kind: 'restore-apply',
      idempotencyKey: `restore-apply:${BACKUP_ID}:${NOW}`,
      payload: { backupId: BACKUP_ID, components: ['mongo', 'settings', 'media'] },
    }]);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      actor: actorFor(ID),
      action: 'restore.apply.request',
      subject: BACKUP_ID,
      outcome: 'allowed',
    });
  });

  test('narrows to the components asked for', async () => {
    trail.rows.set(RESTORE_RECORD, [rehearsal(BACKUP_ID, '2026-09-22T08:30:00.000Z')]);
    const response = await requesting({
      backupId: BACKUP_ID,
      confirm: BACKUP_ID,
      password: CLAIM.password,
      components: ['settings'],
    });
    expect(response.statusCode).toBe(202);
    expect(jobs[0]?.['payload']).toEqual({ backupId: BACKUP_ID, components: ['settings'] });
  });

  test.each([
    {},
    { backupId: BACKUP_ID },
    { backupId: BACKUP_ID, confirm: 'not-the-backup' },
    { backupId: BACKUP_ID, confirm: BACKUP_ID, components: ['bogus'] },
  ])('refuses a malformed request before anything is queued: %j', async (payload) => {
    const response = await requesting(payload);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(jobs).toEqual([]);
    expect(entries()).toEqual([]);
  });

  test('refuses a session no account holds, before a password is even asked', async () => {
    const service = await sessions.start(sessionContext(CORRELATION), { actor: 'system', permissions: [RESTORE_MANAGE] });
    const response = await requesting({ backupId: BACKUP_ID, confirm: BACKUP_ID, password: CLAIM.password }, service);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
    expect(jobs).toEqual([]);
  });

  test('refuses and audits the wrong password, whether or not a rehearsal is on file', async () => {
    trail.rows.set(RESTORE_RECORD, [rehearsal(BACKUP_ID, '2026-09-22T08:30:00.000Z')]);
    const response = await requesting({ backupId: BACKUP_ID, confirm: BACKUP_ID, password: 'wrong' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('auth.sign_in_refused');
    expect(jobs).toEqual([]);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      actor: actorFor(ID),
      action: 'restore.apply.request',
      subject: BACKUP_ID,
      outcome: 'refused',
    });
  });

  test('refuses and audits a backup with no passing rehearsal in the last 24 hours', async () => {
    trail.rows.set(RESTORE_RECORD, [rehearsal(BACKUP_ID, '2026-09-20T09:30:00.000Z')]);
    const response = await requesting({ backupId: BACKUP_ID, confirm: BACKUP_ID, password: CLAIM.password });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
    expect(jobs).toEqual([]);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      actor: actorFor(ID),
      action: 'restore.apply.request',
      subject: BACKUP_ID,
      outcome: 'refused',
    });
  });

  test('a rehearsal of a different backup does not vouch for this one', async () => {
    trail.rows.set(RESTORE_RECORD, [rehearsal('backup-2', '2026-09-22T08:30:00.000Z')]);
    const response = await requesting({ backupId: BACKUP_ID, confirm: BACKUP_ID, password: CLAIM.password });
    expect(response.statusCode).toBe(409);
    expect(jobs).toEqual([]);
  });

  test('a failed audit append does not lose an accepted request', async () => {
    trail.rows.set(RESTORE_RECORD, [rehearsal(BACKUP_ID, '2026-09-22T08:30:00.000Z')]);
    identity = {
      ...identity,
      audit: {
        record: vi.fn(async () => { throw new Error('trail unavailable'); }),
        list: vi.fn(async () => ({ entries: [] })),
      },
    };
    await app.close();
    app = await served();
    const response = await requesting({ backupId: BACKUP_ID, confirm: BACKUP_ID, password: CLAIM.password });
    expect(response.statusCode).toBe(202);
    expect(jobs).toHaveLength(1);
  });
});

describe('who may ask for a restore', () => {
  test('registers the trigger behind the mutation guard', () => {
    expect(mutatingRoutesOf(app)).toEqual([{ method: 'POST', url: RESTORES_PATH }]);
  });

  test('refuses POST without restore.manage', async () => {
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: actorFor(ID), permissions: [] });
    const response = await requesting({ backupId: BACKUP_ID, confirm: BACKUP_ID, password: CLAIM.password }, guest);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
    expect(jobs).toEqual([]);
  });

  test.each(['db', 'queue', 'identity', 'all'] as const)('answers not-found without %s', async (missing) => {
    await app.close();
    app = await served(missing);
    const response = await requesting({ backupId: BACKUP_ID, confirm: BACKUP_ID, password: CLAIM.password });
    expect(response.statusCode).toBe(404);
  });
});
