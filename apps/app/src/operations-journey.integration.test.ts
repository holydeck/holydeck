// The single journey that proves operations end to end, against a real MongoDB, the same way
// `restores.integration.test.ts` proves a rehearsal does: back up now, see the job, see the notification
// it produces, be refused a restore with no rehearsal on file, rehearse, retry, and find a deleted fixture
// — a service and its media file — back in production once the (simulated) worker applies it.
//
// The worker itself is `apps/worker`, which this package may never import (see that workspace's own
// dependency direction). Every step a worker would run is instead driven directly, through the exact
// functions and `'system'`-actor contexts `apps/worker/src/main.ts` wires its own handlers with — the
// queue is still claimed and succeeded through, so `GET /jobs` shows precisely what a worker would leave
// behind, but the backup and restore-apply work themselves are called in-process rather than through a
// second process this package cannot depend on.

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { accountContext, accountDb, accountsOn } from './accounts.js';
import { attemptDb, attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { buildApp } from './app.js';
import { BACKUPS_PATH } from './backup-routes.js';
import { backupContext, backupDb, finalizeBackup, readMongoArchive } from './backups.js';
import { capabilitiesOn, capabilityDb } from './capabilities.js';
import type { Fetching } from './corpus.js';
import { JOBS_PATH } from './job-routes.js';
import { SCHEMA_VERSION } from './migrations.js';
import { NOTIFICATIONS_PATH } from './notification-routes.js';
import { notificationDb } from './notification-store.js';
import { passkeyDb, passkeysOn } from './passkeys.js';
import { queueDb, queueOn, workerContext } from './queue.js';
import { RECORDS } from './records.js';
import { repositoryDb } from './repositories.js';
import { applyRestore, fileRestoreTarget } from './restore-apply.js';
import { RESTORES_PATH } from './restore-routes.js';
import { rehearsalDatabaseName, rehearseRestore, restoreContext, restoreDb } from './restores.js';
import { BACKUP_MANAGE, JOBS_MANAGE, NOTIFICATIONS_USE, OPERATIONS_READ, RESTORE_MANAGE } from './roles.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { SessionError, sessionContext, sessionDb, sessionsOn } from './sessions.js';
import { totpDb, totpsOn } from './totp.js';
import { startTestMongoReplicaSet } from '../test/helpers/mongo.js';

import type { BackupContent, BackupProduction } from '@holydeck/contracts/backups';
import type { Db, MongoClient } from 'mongodb';
import type { ReplicaSetMongo } from '../test/helpers/mongo.js';
import type { CapabilityStore } from './capabilities.js';
import type { Identity } from './onboarding.js';
import type { LoadedSettings } from './settings.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FastifyInstance } from 'fastify';

interface ContentDoc {
  readonly _id: string;
  readonly [field: string]: unknown;
}

const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const ID = 'A'.repeat(22);
const CLAIM = { name: 'lucia', displayName: 'Lucia Brandt', password: 'a-long-enough-passphrase' };
const SONG_ID = 'svc-song-1';
const MEDIA_FILE = 'song.mp3';

const now = (): string => new Date().toISOString();

const sources: LoadedSettings['sources'] = {
  port: 'default',
  dataDir: 'default',
  mediaRoot: 'default',
  resticRepository: 'default',
  resticPassword: 'default',
  locale: 'file',
  corpusUrl: 'default',
  corpusToken: 'default',
  mongoUrl: 'default',
  timezone: 'default',
  developmentDiagnostics: 'default',
  backupDailyAt: 'default',
  backupComponents: 'default',
  backupMinimumGapMinutes: 'default',
  backupRehearsalWeekday: 'default',
  retentionSweepAt: 'default',
  notificationReadRetentionDays: 'default',
  autosaveRetentionDays: 'default',
  auditRetentionDays: 'default',
  mediaArchivedPurgeGraceDays: 'default',
  mediaUploadLimitBytes: 'default',
  mediaFreeSpaceReserveBytes: 'default',
};
const settings: LoadedSettings = { values: { ...DEFAULT_SETTINGS, locale: 'de' }, sources, path: '/data/holydeck/config/settings.yaml' };
const refusing: Fetching = () => Promise.reject(new Error('nothing in this test may leave the process'));

const withHeaders = (held: StartedSession) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  cookie: sessionCookie(held.token, 60),
  [CSRF_HEADER]: held.record.csrf,
});

let mongo: ReplicaSetMongo;
let live: Db;
let rehearsalDb: Db;
let client: MongoClient;
let dumpDir: string;
let mediaLiveRoot: string;
let sessions: SessionStore;
let capabilities: CapabilityStore;
let identity: Identity;
let app: FastifyInstance;

beforeAll(async () => {
  mongo = await startTestMongoReplicaSet();
  live = mongo.db;
  client = mongo.client;
  rehearsalDb = client.db(rehearsalDatabaseName(live.databaseName));
}, 120_000);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  for (const collection of [
    RECORDS.services.collection,
    RECORDS.backups.collection,
    RECORDS.restores.collection,
    RECORDS.auditEvents.collection,
  ]) {
    await live.collection(collection).deleteMany({});
    await rehearsalDb.collection(collection).deleteMany({});
  }
  for (const collection of ['sessions', 'capabilities', 'jobs', 'notifications', 'notification_watermarks', 'accounts', 'sign_in_attempts']) {
    await live.collection(collection).deleteMany({});
  }

  dumpDir = await mkdtemp(join(tmpdir(), 'holydeck-operations-journey-'));
  mediaLiveRoot = await mkdtemp(join(tmpdir(), 'holydeck-operations-media-'));
  await writeFile(join(mediaLiveRoot, MEDIA_FILE), 'a song, in bytes', 'utf8');

  sessions = sessionsOn(sessionDb(live), { now });
  capabilities = capabilitiesOn(capabilityDb(live), { now });
  identity = {
    accounts: accountsOn(accountDb(live), {
      now,
      newId: () => ID,
      hash: async (password) => `test-hash:${password}`,
      verify: async (password, stored) => stored === `test-hash:${password}`,
    }),
    audit: auditOn(repositoryDb(live), { now }),
    attempts: attemptsOn(attemptDb(live), { now }),
    totp: totpsOn(totpDb(live), { now }),
    passkeys: passkeysOn(passkeyDb(live), { now }),
  };
  await identity.accounts.claim(accountContext('req-claim'), CLAIM);

  const queue = queueOn(queueDb(live), { now });
  app = buildApp({
    settings,
    logger: false,
    fetching: refusing,
    sessions,
    identity,
    capabilities,
    backups: { db: repositoryDb(live), queue },
    notificationDb: notificationDb(live),
  });
});

afterEach(async () => {
  await app.close();
  await rm(dumpDir, { recursive: true, force: true });
  await rm(mediaLiveRoot, { recursive: true, force: true });
});

describe('operations, end to end against a real database', () => {
  test('back up, notify, refuse an unrehearsed restore, rehearse, apply, and recover a deleted fixture', async () => {
    let admin = await sessions.start(sessionContext('req-sign-in'), {
      actor: actorFor(ID),
      permissions: [BACKUP_MANAGE, RESTORE_MANAGE, JOBS_MANAGE, NOTIFICATIONS_USE, OPERATIONS_READ],
    });

    await live.collection<ContentDoc>(RECORDS.services.collection).insertOne({ _id: SONG_ID, name: 'Sunday Gathering' });

    // Back up now.
    const backupResponse = await app.inject({ method: 'POST', url: BACKUPS_PATH, headers: withHeaders(admin), payload: {} });
    expect(backupResponse.statusCode).toBe(202);

    // The job appears via GET /jobs.
    const queuedJobs = await app.inject({ method: 'GET', url: JOBS_PATH, headers: withHeaders(admin) });
    expect(queuedJobs.json().data.jobs).toMatchObject([{ kind: 'backup-run', state: 'queued' }]);

    // The worker claims and runs it — simulated in-process, exactly as `apps/worker/src/main.ts` wires it.
    const queue = queueOn(queueDb(live), { now });
    const leasedBackup = await queue.claim(workerContext('req-claim-backup'), { worker: 'test-worker', kinds: ['backup-run'] });
    expect(leasedBackup).toBeDefined();

    const archive = await readMongoArchive(backupDb(client, live), backupContext('system', 'req-backup-run'), { dumpDir });
    // The per-collection entries in `archive.contents` (services, content-revisions, ...) are what
    // `verifyMongoArchive` reproves a restore's bytes against; the coarse `mongo`/`media` Restic-snapshot
    // entries here are the restore-class-level inventory `applyRestore` checks a request's classes
    // against — the same two-tier shape `apps/worker/src/backup-producer.ts` produces for real.
    const mongoSnapshot: BackupContent = { class: 'mongo', count: 1, bytes: 1, hash: 'restic:mongo-1' };
    const mediaContent: BackupContent = { class: 'media', count: 1, bytes: 16, hash: 'restic:media-1' };
    const production: BackupProduction = await finalizeBackup(
      repositoryDb(live),
      backupContext('system', 'req-backup-run'),
      { mongoContents: archive.contents, otherContents: [mongoSnapshot, mediaContent], consistency: archive.consistency },
      { now, schemaVersion: SCHEMA_VERSION },
    );
    await queue.succeed(workerContext('req-claim-backup'), { worker: 'test-worker', id: leasedBackup!.id });

    // Once materialized, a notification appears via GET /notifications — from the worker's own `backup.run`
    // entry, not the operator's own `backup.request`: a recipient is not notified of their own actions.
    const notified = await app.inject({ method: 'GET', url: NOTIFICATIONS_PATH, headers: withHeaders(admin) });
    expect(notified.json().data.notifications).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'backup.run', outcome: 'allowed' })]),
    );

    // An operator's mistake: the song and its media file are gone.
    await live.collection<ContentDoc>(RECORDS.services.collection).deleteOne({ _id: SONG_ID });
    await rm(join(mediaLiveRoot, MEDIA_FILE));

    // No rehearsal yet, so applying this backup is refused.
    const refused = await app.inject({
      method: 'POST',
      url: RESTORES_PATH,
      headers: withHeaders(admin),
      payload: { backupId: production.manifest.id, confirm: production.manifest.id, password: CLAIM.password },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe(ENTITY_CONFLICT);

    // Rehearse it. Rehearsing restores mongo into a separate database, but still exercises the real
    // security consequence of a mongo restore: every live session and capability is ended, admin's
    // included, so the operator has to sign back in before applying anything for real.
    await rehearseRestore(repositoryDb(live), restoreContext('system', 'req-rehearsal'), production, {
      restoredRoot: dumpDir,
      target: restoreDb(rehearsalDb),
      sessions,
      capabilities,
      now,
      schemaVersion: SCHEMA_VERSION,
    });
    await expect(sessions.read(sessionContext('req-sign-in'), admin.token)).rejects.toBeInstanceOf(SessionError);

    admin = await sessions.start(sessionContext('req-sign-in-2'), {
      actor: actorFor(ID),
      permissions: [BACKUP_MANAGE, RESTORE_MANAGE, JOBS_MANAGE, NOTIFICATIONS_USE, OPERATIONS_READ],
    });

    // Retry: a passing rehearsal is now on file.
    const retried = await app.inject({
      method: 'POST',
      url: RESTORES_PATH,
      headers: withHeaders(admin),
      payload: {
        backupId: production.manifest.id,
        confirm: production.manifest.id,
        password: CLAIM.password,
        components: ['mongo', 'media'],
      },
    });
    expect(retried.statusCode).toBe(202);

    const restoreJobs = await app.inject({ method: 'GET', url: JOBS_PATH, headers: withHeaders(admin) });
    expect(restoreJobs.json().data.jobs).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'restore-apply', state: 'queued' })]),
    );

    // The worker applies it — again simulated in-process, mirroring `apps/worker/src/restore-apply-handler.ts`.
    const leasedRestore = await queue.claim(workerContext('req-claim-restore'), { worker: 'test-worker', kinds: ['restore-apply'] });
    expect(leasedRestore).toBeDefined();

    const mediaRestoredStage = await mkdtemp(join(tmpdir(), 'holydeck-operations-media-restored-'));
    await mkdir(mediaRestoredStage, { recursive: true });
    await writeFile(join(mediaRestoredStage, MEDIA_FILE), 'a song, in bytes', 'utf8');

    await applyRestore(repositoryDb(live), restoreContext('system', 'req-restore-apply'), production, {
      selection: { mode: 'replace', classes: ['mongo', 'media'] },
      targets: {
        mongo: { restoredRoot: dumpDir, target: restoreDb(live) },
        media: fileRestoreTarget({ restoredPath: mediaRestoredStage, livePath: mediaLiveRoot }),
      },
      sessions,
      capabilities,
      now,
    });
    await queue.succeed(workerContext('req-claim-restore'), { worker: 'test-worker', id: leasedRestore!.id });
    await rm(mediaRestoredStage, { recursive: true, force: true });

    // The previously deleted fixture — the song and its media file — exists again.
    await expect(live.collection<ContentDoc>(RECORDS.services.collection).findOne({ _id: SONG_ID })).resolves.toMatchObject({
      _id: SONG_ID,
      name: 'Sunday Gathering',
    });
    await expect(readFile(join(mediaLiveRoot, MEDIA_FILE), 'utf8')).resolves.toBe('a song, in bytes');
  });
});
