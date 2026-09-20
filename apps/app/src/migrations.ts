// Versioned schema changes, recorded in an append-only ledger.
//
// The ledger is itself a durable record class, which is what makes this safe: a run claims a version by
// appending `v{version}.{direction}.{attempt}.start` and the identifier is unique, so a second runner
// collides instead of migrating the same database twice. A run that never reaches `done` leaves the
// recorded version exactly where it was and the next boot refuses to serve until it is rolled back, which
// is the promise ADR 0009 makes: the version moves forward, and a rollback restores the one before it.

import { ACCOUNT_INDEXES, createAccountIndexOn, dropAccountIndexOn } from './accounts.js';
import { ATTEMPT_INDEXES, createAttemptIndexOn, dropAttemptIndexOn } from './attempts.js';
import { CAPABILITY_INDEXES, createCapabilityIndexOn, dropCapabilityIndexOn } from './capabilities.js';
import { SHELF_INDEXES, SHELF_RECORD } from './conflicts.js';
import { CONTENT_LANGUAGE_INDEXES, CONTENT_LANGUAGE_RECORD } from './content-languages.js';
import { LIBRARY_INDEXES, LIBRARY_RECORD } from './library.js';
import { MEDIA_ASSET_RECORD, MEDIA_INDEXES } from './media.js';
import { MID_SERVICE_INDEXES, MID_SERVICE_RECORD } from './mid-service-additions.js';
import { PASSKEY_INDEXES, createPasskeyIndexOn, dropPasskeyIndexOn } from './passkeys.js';
import { PRESENCE_INDEXES, createPresenceIndexOn, dropPresenceIndexOn } from './presence.js';
import { QUEUE_INDEXES, createQueueIndexOn, dropQueueIndexOn } from './queue.js';
import { RUN_INDEXES, RUN_RECORD } from './runs.js';
import { SERVICE_INDEXES, SERVICE_RECORD } from './services.js';
import { SESSION_INDEXES, createSessionIndexOn, dropSessionIndexOn } from './sessions.js';
import { SLIDE_LABEL_INDEXES, SLIDE_LABEL_RECORD } from './slide-labels.js';
import { LAYOUT_INDEXES, LAYOUT_RECORD } from './slide-layouts.js';
import { TOTP_INDEXES, createTotpIndexOn, dropTotpIndexOn } from './totp.js';
import { createIndexOn, dropIndexOn, repositoriesOn, RepositoryError } from './repositories.js';

import type { AccountIndex } from './accounts.js';
import type { AttemptIndex } from './attempts.js';
import type { CapabilityIndex } from './capabilities.js';
import type { RequestContext } from './context.js';
import type { PasskeyIndex } from './passkeys.js';
import type { PresenceIndex } from './presence.js';
import type { QueueIndex } from './queue.js';
import type { RecordName } from './records.js';
import type { Document, Repository, RepositoryDb } from './repositories.js';
import type { SessionIndex } from './sessions.js';
import type { TotpIndex } from './totp.js';

export type Direction = 'up' | 'down';

export type Phase = 'start' | 'done' | 'failed';

export interface LedgerEntry {
  readonly version: number;
  readonly direction: Direction;
  readonly attempt: number;
  readonly phase: Phase;
  readonly at: string;
  readonly detail?: string;
}

export interface SchemaStatus {
  /** The newest version every step up to which has been applied. */
  readonly recorded: number;
  readonly required: number;
  readonly pending: readonly number[];
  readonly blocked?: {
    readonly version: number;
    readonly direction: Direction;
    readonly attempt: number;
    readonly phase: 'start' | 'failed';
  };
}

/** What a migration may do: write records through the ordinary guards, and change indexes. */
export interface MigrationApi {
  readonly repositories: Readonly<Record<RecordName, Repository>>;
  createIndex(
    name: RecordName,
    keys: Readonly<Record<string, 1 | -1>>,
    options: Readonly<Record<string, unknown>>,
  ): Promise<string>;
  dropIndex(name: RecordName, index: string): Promise<void>;
  /** The queue is not a record class, so its indexes are named by the queue and built through it. */
  createQueueIndex(index: QueueIndex): Promise<string>;
  dropQueueIndex(name: string): Promise<void>;
  /** Nor is a session, for the same reason: operational state, kept beside the records and not among them. */
  createSessionIndex(index: SessionIndex): Promise<string>;
  dropSessionIndex(name: string): Promise<void>;
  /** Nor is an account: operational state too, changed over its life, and in a collection of its own. */
  createAccountIndex(index: AccountIndex): Promise<string>;
  dropAccountIndex(name: string): Promise<void>;
  /** Nor is a count of failed sign-ins, which is the shortest-lived operational state of the four. */
  createAttemptIndex(index: AttemptIndex): Promise<string>;
  dropAttemptIndex(name: string): Promise<void>;
  /** Nor is a second factor: one credential per account, kept where revoking it cannot reach a password. */
  createTotpIndex(index: TotpIndex): Promise<string>;
  dropTotpIndex(name: string): Promise<void>;
  /** Nor is a passkey, which is two collections: the keys an account holds and the challenges they answer. */
  createPasskeyIndex(index: PasskeyIndex): Promise<string>;
  dropPasskeyIndex(name: string): Promise<void>;
  /** Nor is a capability: a Guest's invitation or an output window's grant, gone the moment it expires. */
  createCapabilityIndex(index: CapabilityIndex): Promise<string>;
  dropCapabilityIndex(name: string): Promise<void>;
  /** Nor is presence: who is editing something right now, refreshed while they are and gone when they stop. */
  createPresenceIndex(index: PresenceIndex): Promise<string>;
  dropPresenceIndex(name: string): Promise<void>;
}

export interface SchemaMigration {
  readonly version: number;
  readonly name: string;
  up(api: MigrationApi, context: RequestContext): Promise<void>;
  down(api: MigrationApi, context: RequestContext): Promise<void>;
}

export interface RunOptions {
  /** Injected so a test can pin the ledger timestamps. */
  readonly now: () => string;
  readonly migrations?: readonly SchemaMigration[];
}

export type MigrationRefusal = 'blocked' | 'ahead' | 'claimed' | 'failed' | 'empty' | 'missing' | 'ledger';

export class MigrationError extends Error {
  readonly kind: MigrationRefusal;

  constructor(kind: MigrationRefusal, message: string) {
    super(message);
    this.name = 'MigrationError';
    this.kind = kind;
  }
}

const INDEXES = [
  { record: 'contentRevisions', name: 'content_revision', keys: { contentId: 1, revision: 1 }, options: { unique: true } },
  { record: 'contentRevisions', name: 'content_hash', keys: { hash: 1 }, options: {} },
  { record: 'preparedSnapshots', name: 'snapshot_service', keys: { serviceId: 1, preparedAt: -1 }, options: {} },
  { record: 'runEvents', name: 'run_order', keys: { runId: 1, sequence: 1 }, options: { unique: true } },
  { record: 'auditEvents', name: 'audit_time', keys: { at: -1 }, options: {} },
  { record: 'schemaMigrations', name: 'schema_version', keys: { version: 1 }, options: {} },
] as const satisfies readonly {
  record: RecordName;
  name: string;
  keys: Readonly<Record<string, 1 | -1>>;
  options: Readonly<Record<string, unknown>>;
}[];

export const MIGRATIONS: readonly SchemaMigration[] = Object.freeze([
  {
    version: 1,
    name: 'the indexes the durable records are read by',
    async up(api) {
      for (const index of INDEXES) {
        await api.createIndex(index.record, index.keys, { name: index.name, ...index.options });
      }
    },
    async down(api) {
      for (const index of [...INDEXES].reverse()) await api.dropIndex(index.record, index.name);
    },
  },
  {
    version: 2,
    name: 'the indexes the leased job queue is claimed by',
    async up(api) {
      for (const index of QUEUE_INDEXES) await api.createQueueIndex(index);
    },
    async down(api) {
      for (const index of [...QUEUE_INDEXES].reverse()) await api.dropQueueIndex(index.name);
    },
  },
  {
    version: 3,
    name: 'the indexes a session is found and forgotten by',
    async up(api) {
      for (const index of SESSION_INDEXES) await api.createSessionIndex(index);
    },
    async down(api) {
      for (const index of [...SESSION_INDEXES].reverse()) await api.dropSessionIndex(index.name);
    },
  },
  {
    version: 4,
    name: 'the indexes an account is named and an instance is claimed by',
    async up(api) {
      for (const index of ACCOUNT_INDEXES) await api.createAccountIndex(index);
    },
    async down(api) {
      for (const index of [...ACCOUNT_INDEXES].reverse()) await api.dropAccountIndex(index.name);
    },
  },
  {
    version: 5,
    name: 'the index a scope nobody is guessing at is forgotten by',
    async up(api) {
      for (const index of ATTEMPT_INDEXES) await api.createAttemptIndex(index);
    },
    async down(api) {
      for (const index of [...ATTEMPT_INDEXES].reverse()) await api.dropAttemptIndex(index.name);
    },
  },
  {
    version: 6,
    name: 'the index an enrolment nobody proved is forgotten by',
    async up(api) {
      for (const index of TOTP_INDEXES) await api.createTotpIndex(index);
    },
    async down(api) {
      for (const index of [...TOTP_INDEXES].reverse()) await api.dropTotpIndex(index.name);
    },
  },
  {
    version: 7,
    name: 'the indexes a passkey is listed by and a challenge nobody answered is forgotten by',
    async up(api) {
      for (const index of PASSKEY_INDEXES) await api.createPasskeyIndex(index);
    },
    async down(api) {
      for (const index of [...PASSKEY_INDEXES].reverse()) await api.dropPasskeyIndex(index.name);
    },
  },
  {
    version: 8,
    name: 'the index a capability nobody revoked is forgotten by',
    async up(api) {
      for (const index of CAPABILITY_INDEXES) await api.createCapabilityIndex(index);
    },
    async down(api) {
      for (const index of [...CAPABILITY_INDEXES].reverse()) await api.dropCapabilityIndex(index.name);
    },
  },
  // A Slide Layout is a record class, unlike the seven above, so its index is built through the same
  // `createIndex` the durable records use rather than through a helper of its own.
  {
    version: 9,
    name: 'the index a Slide Layout’s standing stamp is found by',
    async up(api) {
      for (const index of LAYOUT_INDEXES) {
        await api.createIndex(LAYOUT_RECORD, index.keys, { name: index.name, ...index.options });
      }
    },
    async down(api) {
      for (const index of [...LAYOUT_INDEXES].reverse()) await api.dropIndex(LAYOUT_RECORD, index.name);
    },
  },
  {
    version: 10,
    name: 'the index a Service’s standing stamp is found by',
    async up(api) {
      for (const index of SERVICE_INDEXES) {
        await api.createIndex(SERVICE_RECORD, index.keys, { name: index.name, ...index.options });
      }
    },
    async down(api) {
      for (const index of [...SERVICE_INDEXES].reverse()) await api.dropIndex(SERVICE_RECORD, index.name);
    },
  },
  {
    version: 11,
    name: 'the index a library item’s standing stamp is found by',
    async up(api) {
      for (const index of LIBRARY_INDEXES) {
        await api.createIndex(LIBRARY_RECORD, index.keys, { name: index.name, ...index.options });
      }
    },
    async down(api) {
      for (const index of [...LIBRARY_INDEXES].reverse()) await api.dropIndex(LIBRARY_RECORD, index.name);
    },
  },
  {
    version: 12,
    name: 'the index a slide label’s standing stamp is found by',
    async up(api) {
      for (const index of SLIDE_LABEL_INDEXES) {
        await api.createIndex(SLIDE_LABEL_RECORD, index.keys, { name: index.name, ...index.options });
      }
    },
    async down(api) {
      for (const index of [...SLIDE_LABEL_INDEXES].reverse()) await api.dropIndex(SLIDE_LABEL_RECORD, index.name);
    },
  },
  {
    version: 13,
    name: 'the index a media asset’s standing stamp is found by',
    async up(api) {
      for (const index of MEDIA_INDEXES) {
        await api.createIndex(MEDIA_ASSET_RECORD, index.keys, { name: index.name, ...index.options });
      }
    },
    async down(api) {
      for (const index of [...MEDIA_INDEXES].reverse()) await api.dropIndex(MEDIA_ASSET_RECORD, index.name);
    },
  },
  {
    version: 14,
    name: 'the index everyone editing one piece of content is listed by',
    async up(api) {
      for (const index of PRESENCE_INDEXES) await api.createPresenceIndex(index);
    },
    async down(api) {
      for (const index of [...PRESENCE_INDEXES].reverse()) await api.dropPresenceIndex(index.name);
    },
  },
  // The conflict shelf is a record class, unlike presence above, so its index is built through the same
  // `createIndex` the durable records use rather than through a helper of its own.
  {
    version: 15,
    name: 'the index a content’s shelved conflicts are read in order by',
    async up(api) {
      for (const index of SHELF_INDEXES) {
        await api.createIndex(SHELF_RECORD, index.keys, { name: index.name, ...index.options });
      }
    },
    async down(api) {
      for (const index of [...SHELF_INDEXES].reverse()) await api.dropIndex(SHELF_RECORD, index.name);
    },
  },
  {
    version: 16,
    name: 'the index a content language’s standing stamp is found by',
    async up(api) {
      for (const index of CONTENT_LANGUAGE_INDEXES) {
        await api.createIndex(CONTENT_LANGUAGE_RECORD, index.keys, { name: index.name, ...index.options });
      }
    },
    async down(api) {
      for (const index of [...CONTENT_LANGUAGE_INDEXES].reverse()) await api.dropIndex(CONTENT_LANGUAGE_RECORD, index.name);
    },
  },
  {
    version: 17,
    name: 'the index a presentation run’s standing row is found by',
    async up(api) {
      for (const index of RUN_INDEXES) {
        await api.createIndex(RUN_RECORD, index.keys, { name: index.name, ...index.options });
      }
    },
    async down(api) {
      for (const index of [...RUN_INDEXES].reverse()) await api.dropIndex(RUN_RECORD, index.name);
    },
  },
  {
    version: 18,
    name: 'the index everything a run took on mid-service is read in order by',
    async up(api) {
      for (const index of MID_SERVICE_INDEXES) {
        await api.createIndex(MID_SERVICE_RECORD, index.keys, { name: index.name, ...index.options });
      }
    },
    async down(api) {
      for (const index of [...MID_SERVICE_INDEXES].reverse()) await api.dropIndex(MID_SERVICE_RECORD, index.name);
    },
  },
]);

export const SCHEMA_VERSION = MIGRATIONS.length;

const DIRECTIONS: readonly string[] = ['up', 'down'];

const PHASES: readonly string[] = ['start', 'done', 'failed'];

const ordinal = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 1;

const oneOf =
  (allowed: readonly string[]) =>
  (value: unknown): boolean =>
    typeof value === 'string' && allowed.includes(value);

const LEDGER_FIELDS: Readonly<Record<string, (value: unknown) => boolean>> = {
  version: ordinal,
  direction: oneOf(DIRECTIONS),
  attempt: ordinal,
  phase: oneOf(PHASES),
  at: (value) => typeof value === 'string' && value.length > 0,
};

/** A ledger nobody can read is a ledger nobody can trust, so an entry this code could not have written stops the run. */
export function ledgerFrom(rows: readonly Document[]): LedgerEntry[] {
  return rows.map((row) => {
    for (const [field, valid] of Object.entries(LEDGER_FIELDS)) {
      if (!valid(row[field])) {
        throw new MigrationError(
          'ledger',
          `the schema ledger entry ${String(row['_id'])} has no ${field} this code could have written`,
        );
      }
    }
    const detail = row['detail'];
    return {
      version: row['version'] as number,
      direction: row['direction'] as Direction,
      attempt: row['attempt'] as number,
      phase: row['phase'] as Phase,
      at: row['at'] as string,
      ...(typeof detail === 'string' ? { detail } : {}),
    };
  });
}

/** Pure, because the decision to serve or to refuse is worth testing without a database. */
export function statusFrom(entries: readonly LedgerEntry[], required = SCHEMA_VERSION): SchemaStatus {
  const latest = new Map<number, LedgerEntry>();
  const finished = new Map<number, LedgerEntry>();
  for (const item of entries) {
    if ((latest.get(item.version)?.attempt ?? 0) <= item.attempt) latest.set(item.version, item);
    if (item.phase === 'done' && (finished.get(item.version)?.attempt ?? 0) <= item.attempt) {
      finished.set(item.version, item);
    }
  }
  let recorded = 0;
  while (finished.get(recorded + 1)?.direction === 'up') recorded += 1;
  const pending: number[] = [];
  for (let version = recorded + 1; version <= required; version += 1) pending.push(version);
  const [unfinished] = [...latest.values()]
    .filter((item) => item.phase !== 'done')
    .sort((left, right) => left.version - right.version);
  return {
    recorded,
    required,
    pending: Object.freeze(pending),
    ...(unfinished === undefined
      ? {}
      : {
          blocked: {
            version: unfinished.version,
            direction: unfinished.direction,
            attempt: unfinished.attempt,
            phase: unfinished.phase as 'start' | 'failed',
          },
        }),
  };
}

export function migrationApi(db: RepositoryDb): MigrationApi {
  return Object.freeze({
    repositories: repositoriesOn(db),
    createIndex: (name: RecordName, keys: Readonly<Record<string, 1 | -1>>, options: Readonly<Record<string, unknown>>) =>
      createIndexOn(db, name, keys, options),
    dropIndex: (name: RecordName, index: string) => dropIndexOn(db, name, index),
    createQueueIndex: (index: QueueIndex) => createQueueIndexOn(db, index),
    dropQueueIndex: (name: string) => dropQueueIndexOn(db, name),
    createSessionIndex: (index: SessionIndex) => createSessionIndexOn(db, index),
    dropSessionIndex: (name: string) => dropSessionIndexOn(db, name),
    createAccountIndex: (index: AccountIndex) => createAccountIndexOn(db, index),
    dropAccountIndex: (name: string) => dropAccountIndexOn(db, name),
    createAttemptIndex: (index: AttemptIndex) => createAttemptIndexOn(db, index),
    dropAttemptIndex: (name: string) => dropAttemptIndexOn(db, name),
    createTotpIndex: (index: TotpIndex) => createTotpIndexOn(db, index),
    dropTotpIndex: (name: string) => dropTotpIndexOn(db, name),
    createPasskeyIndex: (index: PasskeyIndex) => createPasskeyIndexOn(db, index),
    dropPasskeyIndex: (name: string) => dropPasskeyIndexOn(db, name),
    createCapabilityIndex: (index: CapabilityIndex) => createCapabilityIndexOn(db, index),
    dropCapabilityIndex: (name: string) => dropCapabilityIndexOn(db, name),
    createPresenceIndex: (index: PresenceIndex) => createPresenceIndexOn(db, index),
    dropPresenceIndex: (name: string) => dropPresenceIndexOn(db, name),
  });
}

async function readLedger(db: RepositoryDb, context: RequestContext): Promise<LedgerEntry[]> {
  const rows = await repositoriesOn(db).schemaMigrations.read(context, {}, { sort: { version: 1 } });
  return ledgerFrom(rows);
}

export async function schemaStatus(
  db: RepositoryDb,
  context: RequestContext,
  required = SCHEMA_VERSION,
): Promise<SchemaStatus> {
  return statusFrom(await readLedger(db, context), required);
}

const requiredBy = (migrations: readonly SchemaMigration[]): number =>
  migrations.reduce((top, migration) => Math.max(top, migration.version), 0);

function stepAt(migrations: readonly SchemaMigration[], version: number): SchemaMigration {
  const migration = migrations.find((candidate) => candidate.version === version);
  if (migration === undefined) {
    throw new MigrationError('missing', `version ${version} is not one this deployment ships`);
  }
  return migration;
}

function refuseUnusable(status: SchemaStatus): void {
  const blocked = status.blocked;
  if (blocked !== undefined) {
    const how = blocked.phase === 'start' ? 'was started and never finished' : 'failed';
    throw new MigrationError(
      'blocked',
      `version ${blocked.version} ${how} (${blocked.direction}, attempt ${blocked.attempt}); roll it back first`,
    );
  }
  if (status.recorded > status.required) throw new MigrationError('ahead', aheadMessage(status.recorded, status.required));
}

const aheadMessage = (recorded: number, required: number): string =>
  `the database is at schema version ${recorded} and this deployment ships ${required}`;

async function apply(
  db: RepositoryDb,
  context: RequestContext,
  now: () => string,
  entries: readonly LedgerEntry[],
  migration: SchemaMigration,
  direction: Direction,
): Promise<LedgerEntry[]> {
  const ledger = repositoriesOn(db).schemaMigrations;
  const attempt =
    entries.filter((item) => item.version === migration.version && item.phase === 'start').length + 1;
  const write = async (phase: Phase, detail?: string): Promise<LedgerEntry> => {
    const entry: LedgerEntry = {
      version: migration.version,
      direction,
      attempt,
      phase,
      at: now(),
      ...(detail === undefined ? {} : { detail }),
    };
    await ledger.append(context, {
      _id: `v${migration.version}.${direction}.${attempt}.${phase}`,
      ...entry,
      actor: context.actor,
      correlationId: context.correlationId,
    });
    return entry;
  };

  let started: LedgerEntry;
  try {
    started = await write('start');
  } catch (error) {
    if (error instanceof RepositoryError && error.kind === 'duplicate') {
      throw new MigrationError('claimed', `another process is already applying version ${migration.version}`);
    }
    throw error;
  }

  const api = migrationApi(db);
  try {
    await (direction === 'up' ? migration.up(api, context) : migration.down(api, context));
  } catch (error) {
    const why = (error as Error).message;
    await write('failed', why);
    const what = direction === 'up' ? 'failed' : 'could not be undone';
    throw new MigrationError(
      'failed',
      `version ${migration.version} (${migration.name}) ${what}, so the recorded schema version did not move: ${why}`,
    );
  }
  return [...entries, started, await write('done')];
}

/** Applies every pending version in order. Running it twice is the same as running it once. */
export async function migrate(
  db: RepositoryDb,
  context: RequestContext,
  { now, migrations = MIGRATIONS }: RunOptions,
): Promise<SchemaStatus> {
  const required = requiredBy(migrations);
  let entries = await readLedger(db, context);
  const status = statusFrom(entries, required);
  refuseUnusable(status);
  for (const version of status.pending) {
    entries = await apply(db, context, now, entries, stepAt(migrations, version), 'up');
  }
  return statusFrom(entries, required);
}

/** Undoes the newest applied version, or the one a failed run left behind, which is how a blocked database recovers. */
export async function rollback(
  db: RepositoryDb,
  context: RequestContext,
  { now, migrations = MIGRATIONS }: RunOptions,
): Promise<SchemaStatus> {
  const required = requiredBy(migrations);
  const entries = await readLedger(db, context);
  const status = statusFrom(entries, required);
  const version = status.blocked?.version ?? status.recorded;
  if (version === 0) throw new MigrationError('empty', 'there is no applied migration to roll back');
  if (version > required) throw new MigrationError('ahead', aheadMessage(version, required));
  return statusFrom(await apply(db, context, now, entries, stepAt(migrations, version), 'down'), required);
}
