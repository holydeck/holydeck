import { describe, expect, test } from 'vitest';

import { ACCOUNT_INDEXES } from './accounts.js';
import { ATTEMPT_INDEXES } from './attempts.js';
import { CAPABILITY_INDEXES } from './capabilities.js';
import { requestContext, systemContext } from './context.js';
import {
  MIGRATIONS,
  MigrationError,
  SCHEMA_VERSION,
  ledgerFrom,
  migrate,
  migrationApi,
  rollback,
  schemaStatus,
  statusFrom,
} from './migrations.js';
import { QUEUE_INDEXES } from './queue.js';
import { RESTORE_INDEXES } from './restores.js';
import { SESSION_INDEXES } from './sessions.js';
import { TOTP_INDEXES } from './totp.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { FakeDb } from '../test/helpers/fake-db.js';
import type { LedgerEntry, SchemaMigration } from './migrations.js';

const CONTEXT = systemContext('migration-test');
const AT = '2026-09-13T09:00:00.000Z';
const clock = (): string => AT;

const entry = (fields: Partial<LedgerEntry> = {}): LedgerEntry => ({
  version: 1,
  direction: 'up',
  attempt: 1,
  phase: 'done',
  at: AT,
  ...fields,
});

const row = (fields: Partial<LedgerEntry> = {}): Record<string, unknown> => {
  const full = entry(fields);
  return {
    _id: `v${full.version}.${full.direction}.${full.attempt}.${full.phase}`,
    ...full,
    actor: CONTEXT.actor,
    correlationId: CONTEXT.correlationId,
  };
};

const ledger = async (db: FakeDb): Promise<LedgerEntry[]> =>
  ledgerFrom(db.rows.get('schema_migrations') ?? []);

const counting = (applied: string[], version: number): SchemaMigration => ({
  version,
  name: `step ${version}`,
  async up() {
    applied.push(`up ${version}`);
  },
  async down() {
    applied.push(`down ${version}`);
  },
});

const thrown = async (call: Promise<unknown>): Promise<MigrationError> => {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationError);
    return error as MigrationError;
  }
  throw new Error('the call was expected to be refused');
};

describe('the shipped migrations', () => {
  test('are numbered from one without a gap or a repeated name', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(
      MIGRATIONS.map((_migration, at) => at + 1),
    );
    expect(new Set(MIGRATIONS.map((migration) => migration.name)).size).toBe(MIGRATIONS.length);
  });

  test('decide the schema version this deployment requires', () => {
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });

  test('create the indexes the durable records are read by, and drop exactly those again', async () => {
    const db = fakeDb();
    await migrate(db, CONTEXT, { now: clock });
    const created = new Map([...db.indexes].filter(([, names]) => names.length > 0));
    expect([...created.keys()].sort()).toEqual([
      'accounts',
      'audit_events',
      'backups',
      'capabilities',
      'conflict_shelf',
      'content_languages',
      'content_library',
      'content_revisions',
      'jobs',
      'media_assets',
      'mid_service_additions',
      'passkey_challenges',
      'passkey_credentials',
      'prepared_snapshots',
      'presence',
      'presentation_runs',
      'restores',
      'run_events',
      'schema_migrations',
      'services',
      'sessions',
      'sign_in_attempts',
      'slide_labels',
      'slide_layouts',
      'song_singer_chords',
      'totp_credentials',
    ]);

    for (let step = SCHEMA_VERSION; step > 0; step -= 1) await rollback(db, CONTEXT, { now: clock });
    expect([...db.indexes.values()].flat()).toEqual([]);
  });

  // The queue is claimed by a query, and a claim that scans is a claim that slows down as the queue
  // grows, so the indexes it needs ship as a version rather than as something a deployment sets up.
  test('build the queue the indexes a claim is served by, under the names the queue declares', async () => {
    const db = fakeDb();
    await migrate(db, CONTEXT, { now: clock });
    expect(db.indexes.get('jobs')).toEqual(QUEUE_INDEXES.map((index) => index.name));
  });

  // One of the two forgets: the expiry index is what removes a session the moment its absolute deadline
  // passes, so an abandoned session stops existing without anything having to sweep for it.
  test('build the sessions the indexes one is found and forgotten by', async () => {
    const db = fakeDb();
    await migrate(db, CONTEXT, { now: clock });
    expect(db.indexes.get('sessions')).toEqual(SESSION_INDEXES.map((index) => index.name));
  });

  // The founder index is what makes claiming an instance a decision the database takes: unique over a
  // field only the founder carries, so two claims arriving together are a duplicate key rather than two
  // founders.
  test('build the accounts the indexes one is named and an instance is claimed by', async () => {
    const db = fakeDb();
    await migrate(db, CONTEXT, { now: clock });
    expect(db.indexes.get('accounts')).toEqual(ACCOUNT_INDEXES.map((index) => index.name));
  });

  // The other of the two that forgets: a scope nobody has failed against for a day stops existing, so a
  // deployment that has been running for a year holds counts for the people signing in this week.
  test('build the sign-in attempts the index a scope nobody is using is forgotten by', async () => {
    const db = fakeDb();
    await migrate(db, CONTEXT, { now: clock });
    expect(db.indexes.get('sign_in_attempts')).toEqual(ATTEMPT_INDEXES.map((index) => index.name));
  });

  // The third that forgets, and the one with the shortest patience: a secret shown on a screen and never
  // proved is enrollable for a quarter of an hour, and afterwards it is not there to be enrolled.
  test('build the second factors the index an enrolment nobody proved is forgotten by', async () => {
    const db = fakeDb();
    await migrate(db, CONTEXT, { now: clock });
    expect(db.indexes.get('totp_credentials')).toEqual(TOTP_INDEXES.map((index) => index.name));
  });

  // The fourth that forgets: a capability nobody revoked is not one a deployment running for a year should
  // still be holding open, so it stops existing on its own deadline rather than needing to be swept for.
  test('build the capabilities the index one nobody revoked is forgotten by', async () => {
    const db = fakeDb();
    await migrate(db, CONTEXT, { now: clock });
    expect(db.indexes.get('capabilities')).toEqual(CAPABILITY_INDEXES.map((index) => index.name));
  });

  // A rehearsal is read newest-first — the last one that proved a backup restorable is the answer to
  // whether one has been proved lately — so the index it is read by ships as a version like the rest.
  test('build the restore rehearsals the index the newest one is found by', async () => {
    const db = fakeDb();
    await migrate(db, CONTEXT, { now: clock });
    expect(db.indexes.get('restores')).toEqual(RESTORE_INDEXES.map((index) => index.name));
  });
});

describe('replaying the ledger', () => {
  test('reports every version as pending when nothing has run', () => {
    expect(statusFrom([])).toEqual({
      recorded: 0,
      required: SCHEMA_VERSION,
      pending: MIGRATIONS.map((migration) => migration.version),
    });
  });

  test('counts a version as applied once its run finished', () => {
    expect(statusFrom([entry({ phase: 'start' }), entry()], 1)).toMatchObject({ recorded: 1, pending: [] });
  });

  test('leaves the version unadvanced while a run is unfinished', () => {
    expect(statusFrom([entry({ phase: 'start' })])).toMatchObject({
      recorded: 0,
      blocked: { version: 1, direction: 'up', attempt: 1, phase: 'start' },
    });
  });

  test('leaves the version unadvanced when a run failed', () => {
    expect(statusFrom([entry({ phase: 'start' }), entry({ phase: 'failed' })])).toMatchObject({
      recorded: 0,
      blocked: { version: 1, phase: 'failed' },
    });
  });

  test('takes the newest attempt even when the ledger is read out of order', () => {
    const entries = [entry({ direction: 'down', attempt: 2 }), entry({ attempt: 1 })];
    expect(statusFrom(entries, 1)).toMatchObject({ recorded: 0, pending: [1] });
  });

  test('takes a later rollback over an earlier run of the same version', () => {
    const entries = [entry(), entry({ direction: 'down', attempt: 2 })];
    expect(statusFrom(entries, 1)).toMatchObject({ recorded: 0, pending: [1] });
  });

  test('takes a re-run over an earlier rollback of the same version', () => {
    const entries = [entry(), entry({ direction: 'down', attempt: 2 }), entry({ attempt: 3 })];
    expect(statusFrom(entries, 1)).toMatchObject({ recorded: 1, pending: [] });
  });

  test('names the oldest unfinished version, because that is the one that has to be undone first', () => {
    const entries = [entry({ phase: 'failed', version: 2 }), entry({ phase: 'start' })];
    expect(statusFrom(entries, 2).blocked).toEqual({ version: 1, direction: 'up', attempt: 1, phase: 'start' });
  });

  test('stops counting at the first version that never ran', () => {
    expect(statusFrom([entry({ version: 2 })], 1)).toMatchObject({ recorded: 0, pending: [1] });
  });

  test('reports a database that ran a version this deployment does not ship', () => {
    expect(statusFrom([entry(), entry({ version: 2 })], 1)).toMatchObject({ recorded: 2, pending: [] });
  });
});

describe('reading the ledger out of the database', () => {
  test('reads the entries a run appended', async () => {
    const db = fakeDb();
    await migrate(db, CONTEXT, { now: clock });
    expect(await schemaStatus(db, CONTEXT)).toMatchObject({ recorded: SCHEMA_VERSION, pending: [] });
  });

  test('refuses an entry no run of this code could have written', async () => {
    const db = fakeDb();
    db.rows.set('schema_migrations', [{ ...row(), phase: 'halfway' }]);
    const error = await thrown(schemaStatus(db, CONTEXT));
    expect(error.kind).toBe('ledger');
    expect(error.message).toContain('v1.up.1.done');
  });
});

describe('applying migrations', () => {
  test('runs every pending version in order and records each one', async () => {
    const db = fakeDb();
    const applied: string[] = [];
    const migrations = [counting(applied, 1), counting(applied, 2)];
    const status = await migrate(db, CONTEXT, { now: clock, migrations });

    expect(applied).toEqual(['up 1', 'up 2']);
    expect(status).toMatchObject({ recorded: 2, required: 2, pending: [] });
    expect((await ledger(db)).map((item) => `${item.version}.${item.phase}`)).toEqual([
      '1.start',
      '1.done',
      '2.start',
      '2.done',
    ]);
  });

  test('does nothing the second time it runs', async () => {
    const db = fakeDb();
    const applied: string[] = [];
    const migrations = [counting(applied, 1)];
    await migrate(db, CONTEXT, { now: clock, migrations });
    const status = await migrate(db, CONTEXT, { now: clock, migrations });

    expect(applied).toEqual(['up 1']);
    expect(status).toMatchObject({ recorded: 1, pending: [] });
    expect(await ledger(db)).toHaveLength(2);
  });

  test('leaves the schema version unadvanced when a migration fails', async () => {
    const db = fakeDb();
    const migrations: SchemaMigration[] = [
      {
        version: 1,
        name: 'the one that fails',
        async up() {
          throw new Error('the index could not be built');
        },
        async down() {
          /* nothing to undo */
        },
      },
    ];
    const error = await thrown(migrate(db, CONTEXT, { now: clock, migrations }));

    expect(error.kind).toBe('failed');
    expect(error.message).toContain('the index could not be built');
    expect(statusFrom(await ledger(db))).toMatchObject({
      recorded: 0,
      blocked: { version: 1, phase: 'failed' },
    });
  });

  test('records the failure even when a later version would have succeeded', async () => {
    const db = fakeDb();
    const applied: string[] = [];
    const migrations: SchemaMigration[] = [
      {
        version: 1,
        name: 'the one that fails',
        async up() {
          throw new Error('no');
        },
        async down() {
          /* nothing to undo */
        },
      },
      counting(applied, 2),
    ];
    await thrown(migrate(db, CONTEXT, { now: clock, migrations }));
    expect(applied).toEqual([]);
  });

  test('refuses to migrate over a run that never finished', async () => {
    const db = fakeDb();
    db.rows.set('schema_migrations', [row({ phase: 'start' })]);
    const error = await thrown(migrate(db, CONTEXT, { now: clock, migrations: [counting([], 1)] }));

    expect(error.kind).toBe('blocked');
    expect(error.message).toContain('roll it back');
  });

  test('refuses to migrate over a run that failed', async () => {
    const db = fakeDb();
    db.rows.set('schema_migrations', [row({ phase: 'start' }), row({ phase: 'failed', detail: 'no' })]);
    const error = await thrown(migrate(db, CONTEXT, { now: clock, migrations: [counting([], 1)] }));

    expect(error.kind).toBe('blocked');
    expect(error.message).toContain('failed (up, attempt 1)');
  });

  test('refuses a version it was not given the step for', async () => {
    const error = await thrown(migrate(fakeDb(), CONTEXT, { now: clock, migrations: [counting([], 2)] }));

    expect(error.kind).toBe('missing');
    expect(error.message).toContain('version 1');
  });

  test('refuses to run against a database a newer deployment has already migrated', async () => {
    const db = fakeDb();
    db.rows.set('schema_migrations', [row(), row({ version: 2 })]);
    const error = await thrown(migrate(db, CONTEXT, { now: clock, migrations: [counting([], 1)] }));

    expect(error.kind).toBe('ahead');
    expect(error.message).toContain('schema version 2');
  });

  test('refuses when another process has already claimed the version', async () => {
    const applied: string[] = [];
    // Two runners started at once: the loser's claim collides on the ledger identifier and it stands down.
    const race = fakeDb();
    race.failOn = (collection) =>
      collection === 'schema_migrations'
        ? Object.assign(new Error('E11000 duplicate key'), { code: 11_000 })
        : undefined;
    const error = await thrown(migrate(race, CONTEXT, { now: clock, migrations: [counting(applied, 1)] }));
    expect(error.kind).toBe('claimed');
    expect(error.message).toContain('version 1');
  });

  test('lets a database that cannot be written reach the caller as itself', async () => {
    const db = fakeDb();
    const outage = new Error('the replica set has no primary');
    db.failOn = () => outage;
    await expect(migrate(db, CONTEXT, { now: clock, migrations: [counting([], 1)] })).rejects.toBe(outage);
  });

  test('runs the migrations this deployment ships when it is not told otherwise', async () => {
    const db = fakeDb();
    expect(await migrate(db, CONTEXT, { now: clock })).toMatchObject({
      recorded: SCHEMA_VERSION,
      required: SCHEMA_VERSION,
    });
  });
});

describe('rolling back', () => {
  test('undoes the newest applied version and records the rollback', async () => {
    const db = fakeDb();
    const applied: string[] = [];
    const migrations = [counting(applied, 1), counting(applied, 2)];
    await migrate(db, CONTEXT, { now: clock, migrations });
    const status = await rollback(db, CONTEXT, { now: clock, migrations });

    expect(applied).toEqual(['up 1', 'up 2', 'down 2']);
    expect(status).toMatchObject({ recorded: 1, pending: [2] });
    expect((await ledger(db)).map((item) => `${item.version}.${item.direction}.${item.attempt}`)).toEqual([
      '1.up.1',
      '1.up.1',
      '2.up.1',
      '2.up.1',
      '2.down.2',
      '2.down.2',
    ]);
  });

  test('undoes a run that never finished, which is how a blocked database is recovered', async () => {
    const db = fakeDb();
    const applied: string[] = [];
    db.rows.set('schema_migrations', [row({ phase: 'start' })]);
    const status = await rollback(db, CONTEXT, { now: clock, migrations: [counting(applied, 1)] });

    expect(applied).toEqual(['down 1']);
    expect(status).toMatchObject({ recorded: 0, pending: [1] });
    expect(status.blocked).toBeUndefined();
  });

  test('refuses when there is nothing to roll back', async () => {
    const error = await thrown(rollback(fakeDb(), CONTEXT, { now: clock, migrations: [counting([], 1)] }));
    expect(error.kind).toBe('empty');
  });

  test('refuses when the version to undo is not one this deployment ships', async () => {
    const db = fakeDb();
    db.rows.set('schema_migrations', [row(), row({ version: 2 })]);
    const error = await thrown(rollback(db, CONTEXT, { now: clock, migrations: [counting([], 1)] }));
    expect(error.kind).toBe('ahead');
  });

  test('leaves the version applied when the rollback itself fails', async () => {
    const db = fakeDb();
    const migrations: SchemaMigration[] = [
      {
        version: 1,
        name: 'the one that cannot be undone',
        async up() {
          /* nothing to do */
        },
        async down() {
          throw new Error('the index is gone already');
        },
      },
    ];
    await migrate(db, CONTEXT, { now: clock, migrations });
    const error = await thrown(rollback(db, CONTEXT, { now: clock, migrations }));

    expect(error.kind).toBe('failed');
    expect(statusFrom(await ledger(db))).toMatchObject({
      recorded: 1,
      blocked: { version: 1, direction: 'down', phase: 'failed' },
    });
  });

  test('runs the migrations this deployment ships when it is not told otherwise', async () => {
    const db = fakeDb();
    await migrate(db, CONTEXT, { now: clock });
    expect(await rollback(db, CONTEXT, { now: clock })).toMatchObject({ recorded: SCHEMA_VERSION - 1 });
  });
});

describe('rolling back what an `up()` never finished building', () => {
  /** What Mongo answers with when the index named in a drop is not there: code 27, `IndexNotFound`. */
  const gone = Object.assign(new Error('index not found with name [an_index]'), {
    code: 27,
    codeName: 'IndexNotFound',
  });

  /** A database that refuses every drop for the given reason, which is the state a failed `up()` leaves. */
  const refusing = (reason: unknown): FakeDb => {
    const db = fakeDb();
    return {
      ...db,
      collection: (name: string) => ({
        ...db.collection(name),
        dropIndex: async () => {
          throw reason;
        },
      }),
    };
  };

  test('every rollback this deployment ships finishes when the index it drops was never created', async () => {
    for (const migration of MIGRATIONS) {
      await expect(migration.down(migrationApi(refusing(gone)), CONTEXT)).resolves.toBeUndefined();
    }
  });

  test('a rollback still fails on any other reason an index would not drop', async () => {
    const denied = Object.assign(new Error('not authorized on this database'), { code: 13, codeName: 'Unauthorized' });
    for (const migration of MIGRATIONS) {
      await expect(migration.down(migrationApi(refusing(denied)), CONTEXT)).rejects.toThrow(/not authorized/u);
    }
  });

  test('a rollback drives through to the end, rather than stopping at the first index already gone', async () => {
    const db = fakeDb();
    await MIGRATIONS[0]!.up(migrationApi(db), CONTEXT);
    for (const [collection, named] of db.indexes) db.indexes.set(collection, named.slice(1));
    await expect(MIGRATIONS[0]!.down(migrationApi(db), CONTEXT)).resolves.toBeUndefined();
    expect([...db.indexes.values()].flat()).toEqual([]);
  });
});

describe('what a migration is handed', () => {
  test('offers the repositories and the index calls, and nothing that could rewrite history', () => {
    expect(Object.keys(migrationApi(fakeDb())).sort()).toEqual([
      'createAccountIndex',
      'createAttemptIndex',
      'createCapabilityIndex',
      'createIndex',
      'createPasskeyIndex',
      'createPresenceIndex',
      'createQueueIndex',
      'createSessionIndex',
      'createTotpIndex',
      'dropAccountIndex',
      'dropAttemptIndex',
      'dropCapabilityIndex',
      'dropIndex',
      'dropPasskeyIndex',
      'dropPresenceIndex',
      'dropQueueIndex',
      'dropSessionIndex',
      'dropTotpIndex',
      'repositories',
    ]);
  });

  test('writes a record through the same guards every other caller goes through', async () => {
    const api = migrationApi(fakeDb());
    const context = requestContext({
      actor: 'migration',
      permissions: ['auditEvents.append'],
      correlationId: 'migration-test',
    });
    await expect(api.repositories.auditEvents.append(context, {})).rejects.toThrow(/needs a value for/u);
  });
});
