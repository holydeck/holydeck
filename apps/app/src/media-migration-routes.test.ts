import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { MEDIA_MIGRATION_CLEANUP_PATH, MEDIA_MIGRATION_PATH, serveMediaMigrationRoutes } from './media-migration-routes.js';
import { passkeysOn } from './passkeys.js';
import { queueOn } from './queue.js';
import { MEDIA_MANAGE } from './roles.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { MediaMigrationRecord, MediaMigrationStateStore } from './media-migration-state.js';
import type { Queue, QueueDb } from './queue.js';
import type { Document } from './repositories.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { SettingsAdmin } from './settings-admin.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const NOW = '2026-09-23T05:00:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-media-migration-route';
const ID = 'B'.repeat(22);
const CLAIM = { name: 'lucia', displayName: 'Lucia Brandt', password: 'a-long-enough-passphrase' };

const now = (): string => NOW;

let app: FastifyInstance;
let sessions: SessionStore;
let trail: FakeDb;
let identity: Identity;
let queue: Queue;
let migrationState: MediaMigrationStateStore;
let admin: StartedSession;
let jobs: Document[];
let liveMediaRoot: string;
let dataDir: string;

const settingsAdmin: Pick<SettingsAdmin, 'current'> = {
  current: () => ({
    values: { ...DEFAULT_SETTINGS, mediaRoot: liveMediaRoot, dataDir },
    sources: {} as never,
    path: '/data/holydeck/config/settings.yaml',
  }),
};

/** A minimal in-memory `MediaMigrationStateStore` — no Mongo doc shape needed for a route test. */
const fakeMigrationState = (): MediaMigrationStateStore & { readonly cleanups: string[] } => {
  let record: MediaMigrationRecord | undefined;
  const cleanups: string[] = [];
  return {
    cleanups,
    async read() {
      return record;
    },
    async recordCompletion(next) {
      record = next;
    },
    async recordCleanup(at) {
      cleanups.push(at);
      if (record !== undefined) record = { ...record, cleanedUpAt: at };
    },
  };
};

const entries = (): Document[] => trail.rows.get('audit_events') ?? [];
const withHeaders = (held: StartedSession = admin) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  cookie: sessionCookie(held.token, 60),
  [CSRF_HEADER]: held.record.csrf,
});
const requesting = (url: string, payload: unknown = {}, held: StartedSession = admin) =>
  app.inject({ method: 'POST', url, headers: withHeaders(held), payload: payload as never });

const served = async (
  missing?: 'queue' | 'migrationState' | 'identity' | 'settingsAdmin' | 'all',
): Promise<FastifyInstance> => {
  const built = Fastify({ logger: false });
  withSafeErrors(built);
  guardMutations(built, { sessions });
  enforceAuthorization(built, { sessions, identity: undefined });
  serveMediaMigrationRoutes(built, {
    queue: missing === 'queue' || missing === 'all' ? undefined : queue,
    migrationState: missing === 'migrationState' || missing === 'all' ? undefined : migrationState,
    identity: missing === 'identity' || missing === 'all' ? undefined : identity,
    settingsAdmin: missing === 'settingsAdmin' || missing === 'all' ? undefined : settingsAdmin,
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
  migrationState = fakeMigrationState();
  liveMediaRoot = DEFAULT_SETTINGS.mediaRoot;
  dataDir = DEFAULT_SETTINGS.dataDir;
  app = await served();
  admin = await sessions.start(sessionContext(CORRELATION), { actor: actorFor(ID), permissions: [MEDIA_MANAGE] });
});

afterEach(async () => {
  await app.close();
});

describe('asking this deployment to migrate its media storage root', () => {
  test('queues the migration and audits the request', async () => {
    const response = await requesting(MEDIA_MIGRATION_PATH, { targetRoot: '/mnt/media-new' });
    expect(response.statusCode).toBe(202);
    expect(response.json().data).toEqual({ id: 'job-1', created: true });
    expect(jobs).toMatchObject([{
      kind: 'media-root-migrate',
      idempotencyKey: `media-root-migrate:/mnt/media-new:${NOW}`,
      payload: { targetRoot: '/mnt/media-new' },
    }]);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      actor: actorFor(ID),
      action: 'media.storageMigration.request',
      subject: '/mnt/media-new',
      outcome: 'allowed',
    });
  });

  test.each([
    [{}],
    [{ targetRoot: '' }],
    [{ targetRoot: 'relative/not/absolute' }],
  ])('refuses a malformed request before anything is queued: %j', async (payload) => {
    const response = await requesting(MEDIA_MIGRATION_PATH, payload);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(jobs).toEqual([]);
    expect(entries()).toEqual([]);
  });

  test('refuses a target root that overlaps the live media root, before anything is queued', async () => {
    const response = await requesting(MEDIA_MIGRATION_PATH, { targetRoot: `${liveMediaRoot}/nested` });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(jobs).toEqual([]);
    expect(entries()).toEqual([]);
  });

  test('refuses a target root that overlaps the live data directory, before anything is queued', async () => {
    const response = await requesting(MEDIA_MIGRATION_PATH, { targetRoot: dataDir });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(jobs).toEqual([]);
    expect(entries()).toEqual([]);
  });

  test('a failed audit append does not lose an accepted request', async () => {
    identity = { ...identity, audit: { record: vi.fn(async () => { throw new Error('trail unavailable'); }) } };
    await app.close();
    app = await served();
    const response = await requesting(MEDIA_MIGRATION_PATH, { targetRoot: '/mnt/media-new' });
    expect(response.statusCode).toBe(202);
    expect(jobs).toHaveLength(1);
  });
});

describe('cleaning up the previous media root after a migration', () => {
  let fromRoot: string;

  beforeEach(async () => {
    fromRoot = await mkdtemp(join(tmpdir(), 'holydeck-media-migration-cleanup-'));
    await mkdir(join(fromRoot, 'nested'), { recursive: true });
    await writeFile(join(fromRoot, 'leftover.jpg'), 'leftover-bytes', 'utf8');
  });

  test('removes the old root, records the cleanup, and audits it', async () => {
    await migrationState.recordCompletion({ fromRoot, toRoot: '/mnt/media-new', completedAt: '2026-09-23T04:00:00.000Z' });
    liveMediaRoot = '/mnt/media-new';
    const response = await requesting(MEDIA_MIGRATION_CLEANUP_PATH);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ fromRoot, cleanedUpAt: NOW });

    await expect(readFile(join(fromRoot, 'leftover.jpg'), 'utf8')).rejects.toThrow();
    expect((migrationState as ReturnType<typeof fakeMigrationState>).cleanups).toEqual([NOW]);
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      actor: actorFor(ID),
      action: 'media.storageMigration.cleanup',
      subject: fromRoot,
      outcome: 'allowed',
    });
  });

  test('refuses when no migration has ever completed', async () => {
    const response = await requesting(MEDIA_MIGRATION_CLEANUP_PATH);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
    expect(entries()).toEqual([]);
    await expect(readFile(join(fromRoot, 'leftover.jpg'), 'utf8')).resolves.toBe('leftover-bytes');
  });

  test('refuses a second cleanup of an already-cleaned-up migration', async () => {
    await migrationState.recordCompletion({ fromRoot, toRoot: '/mnt/media-new', completedAt: '2026-09-23T04:00:00.000Z' });
    liveMediaRoot = '/mnt/media-new';
    await migrationState.recordCleanup('2026-09-23T04:30:00.000Z');
    const response = await requesting(MEDIA_MIGRATION_CLEANUP_PATH);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
  });

  test('refuses cleanup until the live media root has actually reloaded onto the migrated root', async () => {
    await migrationState.recordCompletion({ fromRoot, toRoot: '/mnt/media-new', completedAt: '2026-09-23T04:00:00.000Z' });
    const response = await requesting(MEDIA_MIGRATION_CLEANUP_PATH);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
    await expect(readFile(join(fromRoot, 'leftover.jpg'), 'utf8')).resolves.toBe('leftover-bytes');
    expect((migrationState as ReturnType<typeof fakeMigrationState>).cleanups).toEqual([]);
  });
});

describe('who may ask for a media storage migration', () => {
  test('registers both routes behind the mutation guard, in order', () => {
    expect(mutatingRoutesOf(app)).toEqual([
      { method: 'POST', url: MEDIA_MIGRATION_PATH },
      { method: 'POST', url: MEDIA_MIGRATION_CLEANUP_PATH },
    ]);
  });

  test.each([MEDIA_MIGRATION_PATH, MEDIA_MIGRATION_CLEANUP_PATH])('refuses POST %s without media.manage', async (url) => {
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: actorFor(ID), permissions: [] });
    const response = await requesting(url, { targetRoot: '/mnt/media-new' }, guest);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
    expect(jobs).toEqual([]);
  });

  test.each(['queue', 'migrationState', 'identity', 'settingsAdmin', 'all'] as const)('answers not-found without %s', async (missing) => {
    await app.close();
    app = await served(missing);
    const trigger = await requesting(MEDIA_MIGRATION_PATH, { targetRoot: '/mnt/media-new' });
    expect(trigger.statusCode).toBe(404);
    const cleanup = await requesting(MEDIA_MIGRATION_CLEANUP_PATH);
    expect(cleanup.statusCode).toBe(404);
  });
});
