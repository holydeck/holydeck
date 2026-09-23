// The one test in this package that talks to a real MongoDB, because three of the promises this module
// makes are the database's and not ours: the ledger identifier is unique, the indexes are really built,
// and a rollback really drops them again.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { requestContext, systemContext } from './context.js';
import { MIGRATIONS, MigrationError, SCHEMA_VERSION, migrate, rollback, schemaStatus } from './migrations.js';
import { repositoriesOn, repositoryDb } from './repositories.js';
import { SERVICE_RECORD } from './services.js';
import { startTestMongo } from '../test/helpers/mongo.js';

import type { Db } from 'mongodb';
import type { SchemaMigration } from './migrations.js';
import type { RepositoryDb } from './repositories.js';
import type { TestMongo } from '../test/helpers/mongo.js';

const CONTEXT = systemContext('migration-live');
const OPERATOR = requestContext({
  actor: 'account:7f3a',
  permissions: ['runEvents.append', 'runEvents.read'],
  correlationId: 'req-0f9c2a41',
});
const AT = '2026-09-13T09:00:00.000Z';
const clock = (): string => AT;

const EVENT = {
  runId: 'run:1',
  sequence: 1,
  at: AT,
  kind: 'slide.shown',
  pinnedRevisions: { content: 'sha256:abc' },
  actor: OPERATOR.actor,
  correlationId: OPERATOR.correlationId,
};

let mongo: TestMongo;
let live: Db;
let db: RepositoryDb;

const indexNames = async (collection: string): Promise<string[]> =>
  (await live.collection(collection).indexes()).map((index) => String(index.name)).sort();

beforeAll(async () => {
  mongo = await startTestMongo();
  live = mongo.db;
  db = repositoryDb(live);
});

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await live.dropDatabase();
});

describe('migrating a real database', () => {
  // Real index builds on a just-started Mongo, run alongside eight other workspaces' suites, routinely
  // outrun vitest's 5000ms default — and a timeout here doesn't cancel the in-flight migrate() call, so a
  // retry would race its own abandoned attempt. Generous headroom is what keeps a retry from ever needing
  // to happen at all.
  test('builds the indexes the durable records are read by', { timeout: 20_000 }, async () => {
    expect(await migrate(db, CONTEXT, { now: clock })).toMatchObject({ recorded: SCHEMA_VERSION, pending: [] });

    expect(await indexNames('run_events')).toEqual(['_id_', 'run_order']);
    expect(await indexNames('content_revisions')).toEqual(['_id_', 'content_hash', 'content_revision']);
    expect(await indexNames(SERVICE_RECORD)).toEqual(['_id_', 'service_stamp']);
    const [serviceStamp] = (await live.collection(SERVICE_RECORD).indexes()).filter((index) => index.name === 'service_stamp');
    expect(serviceStamp).toMatchObject({ key: { serviceId: 1, sequence: -1 }, unique: true });
    expect(await indexNames('media_assets')).toEqual(['_id_', 'media_asset_stamp']);
    const [mediaStamp] = (await live.collection('media_assets').indexes()).filter((index) => index.name === 'media_asset_stamp');
    expect(mediaStamp).toMatchObject({ key: { assetId: 1, sequence: -1 }, unique: true });
    const [unique] = (await live.collection('run_events').indexes()).filter((index) => index.name === 'run_order');
    expect(unique?.unique).toBe(true);
  });

  // A replayed idempotency key is one job rather than two only because the database refuses the second
  // write, so the index that refuses it is worth seeing built against a real one.
  test('builds the indexes the job queue is claimed by, and keeps its key unique', async () => {
    await migrate(db, CONTEXT, { now: clock });

    expect(await indexNames('jobs')).toEqual(['_id_', 'job_claim', 'job_key']);
    const [key] = (await live.collection('jobs').indexes()).filter((index) => index.name === 'job_key');
    expect(key?.unique).toBe(true);
  });

  test('is the same the second time it runs', async () => {
    await migrate(db, CONTEXT, { now: clock });
    await migrate(db, CONTEXT, { now: clock });

    expect(await live.collection('schema_migrations').countDocuments({})).toBe(MIGRATIONS.length * 2);
    expect(await schemaStatus(db, CONTEXT)).toMatchObject({ recorded: SCHEMA_VERSION, pending: [] });
  });

  test('refuses a second claim on a version, which is what keeps two runners apart', async () => {
    await migrate(db, CONTEXT, { now: clock });
    const claim = {
      _id: 'v1.up.1.start',
      version: 1,
      direction: 'up',
      attempt: 1,
      phase: 'start',
      at: AT,
      actor: CONTEXT.actor,
      correlationId: CONTEXT.correlationId,
    };

    await expect(repositoriesOn(db).schemaMigrations.append(CONTEXT, claim)).rejects.toMatchObject({
      kind: 'duplicate',
    });
  });

  test('leaves the recorded version where it was when a migration fails, and recovers on rollback', async () => {
    const migrations: readonly SchemaMigration[] = [
      {
        version: 1,
        name: 'half an index',
        async up(api) {
          await api.createIndex('runEvents', { runId: 1 }, { name: 'half_way' });
          throw new Error('interrupted after the index');
        },
        async down(api) {
          await api.dropIndex('runEvents', 'half_way');
        },
      },
    ];
    const written = await repositoriesOn(db).runEvents.append(OPERATOR, EVENT);
    const before = JSON.stringify(await repositoriesOn(db).runEvents.read(OPERATOR, { runId: 'run:1' }));

    await expect(migrate(db, CONTEXT, { now: clock, migrations })).rejects.toBeInstanceOf(MigrationError);
    expect(await schemaStatus(db, CONTEXT, 1)).toMatchObject({
      recorded: 0,
      blocked: { version: 1, direction: 'up', phase: 'failed' },
    });
    expect(await indexNames('run_events')).toEqual(['_id_', 'half_way']);

    expect(await rollback(db, CONTEXT, { now: clock, migrations })).toMatchObject({ recorded: 0, pending: [1] });
    expect(await indexNames('run_events')).toEqual(['_id_']);

    // ADR 0009: a schema change moves the version, never the history it was written against.
    expect(JSON.stringify(await repositoriesOn(db).runEvents.read(OPERATOR, { runId: 'run:1' }))).toBe(before);
    expect(written).toMatch(/\S/u);
  });

  test('undoes the shipped migrations and leaves the collections it found', async () => {
    await migrate(db, CONTEXT, { now: clock });
    expect(await rollback(db, CONTEXT, { now: clock })).toMatchObject({ recorded: SCHEMA_VERSION - 1 });
    expect(await indexNames('audit_events')).toEqual(['_id_', 'audit_time']);

    expect(await rollback(db, CONTEXT, { now: clock })).toMatchObject({ recorded: SCHEMA_VERSION - 2 });
    expect(await indexNames('service_templates')).toEqual(['_id_']);
    expect(await indexNames('restores')).toEqual(['_id_', 'restore_time']);

    for (let step = SCHEMA_VERSION - 2; step > 0; step -= 1) await rollback(db, CONTEXT, { now: clock });

    expect(await indexNames('content_languages')).toEqual(['_id_']);
    expect(await indexNames('presentation_runs')).toEqual(['_id_']);
    expect(await indexNames('media_assets')).toEqual(['_id_']);
    expect(await indexNames('presence')).toEqual(['_id_']);
    expect(await indexNames('run_events')).toEqual(['_id_']);
    expect(await indexNames('schema_migrations')).toEqual(['_id_']);
    expect(await indexNames('jobs')).toEqual(['_id_']);
    expect(await indexNames('mid_service_additions')).toEqual(['_id_']);
    expect(await indexNames('restores')).toEqual(['_id_']);
    expect(await indexNames('audit_events')).toEqual(['_id_']);
    expect(await indexNames('song_singer_chords')).toEqual(['_id_']);
  });
});
