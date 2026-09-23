import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { FORBIDDEN, guardMutations } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { OPERATIONS_READ } from './roles.js';
import { OPERATIONS_HEALTH_PATH, serveOperationsRoutes } from './operations-routes.js';
import { queueOn } from './queue.js';
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
import type { MediaLibrary, MediaRecord } from './media.js';
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
let media: MediaLibrary;
let mediaRows: readonly MediaRecord[];
let admin: StartedSession;

const withHeaders = (held: StartedSession = admin) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  cookie: sessionCookie(held.token, 60),
});

const served = async (missing?: 'db' | 'queue' | 'media' | 'identity' | 'all'): Promise<FastifyInstance> => {
  const built = Fastify({ logger: false });
  withSafeErrors(built);
  guardMutations(built, { sessions });
  enforceAuthorization(built, { sessions, identity: undefined });
  serveOperationsRoutes(built, {
    db: missing === 'db' || missing === 'all' ? undefined : trail,
    queue: missing === 'queue' || missing === 'all' ? undefined : queue,
    media: missing === 'media' || missing === 'all' ? undefined : media,
    dataDir: '/tmp/holydeck-operations-routes-test',
    now,
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
      verify: async (password, stored) => stored === `test-hash:${password}`,
    }),
    audit: auditOn(trail, { now, newId: () => 'e0' }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  const jobs: Document[] = [];
  const db: QueueDb = {
    collection: () => ({
      async insertOne(document) {
        jobs.push(document);
        return { insertedId: document['_id'] };
      },
      findOne: async () => null,
      findOneAndUpdate: async () => null,
      updateOne: async () => ({ matchedCount: 0 }),
      find: () => ({ toArray: async () => jobs }),
      countDocuments: async () => jobs.length,
      createIndex: async () => '',
      dropIndex: async () => {},
    }),
  };
  queue = queueOn(db, { now, newId: () => 'job-1' });
  mediaRows = [];
  media = {
    upload: async () => { throw new Error('not used in this test'); },
    inspect: async () => undefined,
    list: async () => mediaRows,
    archive: async () => undefined,
    restore: async () => undefined,
    startProcessing: async () => undefined,
    completeProcessing: async () => undefined,
    failProcessing: async () => undefined,
    retryProcessing: async () => undefined,
    purgeArchived: async () => { throw new Error('not used in this test'); },
    purgeReport: async () => { throw new Error('not used in this test'); },
  };
  app = await served();
  admin = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [OPERATIONS_READ] });
});

afterEach(async () => {
  await app.close();
});

describe('the operational health report', () => {
  test('reports a graded envelope built from the wired sources', async () => {
    const response = await app.inject({ method: 'GET', url: OPERATIONS_HEALTH_PATH, headers: withHeaders() });
    expect(response.statusCode).toBe(200);
    const { health } = response.json().data;
    expect(health.at).toBe(NOW);
    expect(health.statuses).toHaveLength(7);
    expect(health.statuses.map((status: { readonly domain: string }) => status.domain)).toEqual([
      'health', 'storage', 'queue', 'backup', 'restore', 'media', 'readiness',
    ]);
  });

  test('reflects what its sources report, not a fixed answer', async () => {
    trail.rows.set('backups', [{
      _id: 'backup:backup-1',
      actor: ADMINISTRATOR,
      correlationId: CORRELATION,
      backupId: 'backup-1',
      at: NOW,
      manifest: {
        id: 'backup-1',
        createdAt: NOW,
        schemaVersion: 19,
        contents: [{ class: 'settings', count: 1, bytes: 12, hash: 'restic:settings-snap' }],
        excludedSecrets: [],
      },
      consistency: { pointInTime: true, method: 'snapshot' },
    }]);
    const before = await app.inject({ method: 'GET', url: OPERATIONS_HEALTH_PATH, headers: withHeaders() });
    const after = trail.rows.get('backups');
    expect(before.statusCode).toBe(200);
    expect(after).toHaveLength(1);
  });
});

describe('who may read operational health', () => {
  test('refuses without operations.read', async () => {
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [] });
    const response = await app.inject({ method: 'GET', url: OPERATIONS_HEALTH_PATH, headers: withHeaders(guest) });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
  });

  test.each(['db', 'queue', 'media', 'identity', 'all'] as const)('answers not-found without %s', async (missing) => {
    await app.close();
    app = await served(missing);
    const response = await app.inject({ method: 'GET', url: OPERATIONS_HEALTH_PATH, headers: withHeaders() });
    expect(response.statusCode).toBe(404);
  });
});
