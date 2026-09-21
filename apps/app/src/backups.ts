// Invariant 10's Mongo half: a logically consistent archive of what this deployment holds of its own
// accord, read at one snapshot so a write that lands mid-read can never be visible in some of what a
// backup carries and invisible in the rest. Settings and media are somebody else's to fold in — files on
// disk, not documents in Mongo — which is why `apps/worker` runs Restic over them and hands their content
// classes in beside what this module reads; `finalizeBackup` is where the two halves become one manifest.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseBackupProduction } from '@holydeck/contracts/backups';

import { auditOn } from './audit.js';
import { contextProblems, requestContext } from './context.js';
import { permissionsFor } from './records.js';
import { RECORDS } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';

import type { MongoClient, Db as MongoDb } from 'mongodb';

import type { BackupConsistency, BackupContent, BackupProduction } from '@holydeck/contracts/backups';
import type { RequestContext } from './context.js';
import type { RecordName } from './records.js';
import type { Document, Filter, RepositoryDb } from './repositories.js';

export const BACKUP_RECORD: RecordName = 'backups';

export interface MongoContent {
  readonly record: RecordName;
  readonly class: string;
}

/**
 * Every Mongo-held durable record class the archive inventories, and the manifest name each reads as.
 * Exported because a restore has to put back exactly this list, under exactly these names: an archive
 * missing one of them is an archive that cannot be restored whole, and only this list can say so.
 */
export const MONGO_CONTENTS: readonly MongoContent[] = Object.freeze([
  { record: 'services', class: 'services' },
  { record: 'contentRevisions', class: 'content-revisions' },
  { record: 'preparedSnapshots', class: 'prepared-snapshots' },
  { record: 'runEvents', class: 'run-events' },
]);

/** What a backup deliberately never carries, named once so a class here can never also appear in `contents`. */
export const EXCLUDED_SECRETS: readonly string[] = Object.freeze([
  'session-keys',
  'credential-hashes',
  'api-tokens',
  'signing-keys',
]);

export const CONSISTENCY_METHOD = 'a session read at one snapshot cluster time';

export interface BackupIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

const DECLARED_INDEXES: readonly BackupIndex[] = [{ name: 'backup_time', keys: { at: -1 }, options: {} }];

export const BACKUP_INDEXES = Object.freeze(DECLARED_INDEXES);

export type BackupRefusal = 'context' | 'permission' | 'schema';

export class BackupError extends Error {
  readonly kind: BackupRefusal;

  constructor(kind: BackupRefusal, message: string) {
    super(message);
    this.name = 'BackupError';
    this.kind = kind;
  }
}

/** The transaction session a Mongo archive is read under. Narrow on purpose: a test can supply all of it. */
export interface BackupSession {
  withTransaction<T>(
    fn: () => Promise<T>,
    options: Readonly<{ readConcern: { readonly level: 'snapshot' }; writeConcern: { readonly w: 'majority' } }>,
  ): Promise<T>;
  endSession(): Promise<void>;
}

export interface BackupCollection {
  find(filter: Filter, options: { readonly session: BackupSession }): { toArray(): Promise<Document[]> };
}

export interface BackupDb {
  collection(name: string): BackupCollection;
  startSession(): BackupSession;
}

/**
 * The driver satisfies this interface in practice; the cast is only about `withTransaction` accepting a
 * wider option bag than the one narrow shape this module ever passes it.
 */
export function backupDb(client: MongoClient, db: MongoDb): BackupDb {
  return {
    collection: (name) => db.collection(name) as unknown as BackupCollection,
    startSession: () => client.startSession() as unknown as BackupSession,
  };
}

const HASH = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** Sorts every object's keys, recursively, so the same documents hash the same way on every read. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, val]) => [key, canonical(val)]),
    );
  }
  return value;
}

export interface MongoArchiveEntry {
  readonly content: BackupContent;
  /** The exact bytes `content.hash` was computed over — what a dump file must hold, verbatim, for the two
   * to provably agree. */
  readonly text: string;
}

/**
 * One content class, inventoried and serialised together so the hash and the bytes can never disagree.
 * Exported for the restore side, which needs the same canonical form to say whether the state it put back
 * after a rehearsal is the state it found — a comparison that is only worth anything if both sides of it
 * are written the same way.
 */
export function archiveEntryOf(className: string, documents: readonly Document[]): MongoArchiveEntry {
  const text = JSON.stringify(documents.map((document) => canonical(document)));
  return { content: { class: className, count: documents.length, bytes: Buffer.byteLength(text, 'utf8'), hash: HASH(text) }, text };
}

/** The context a backup run needs: to append the record it produces, read its own history, and audit itself. */
export function backupContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [
      permissionsFor(BACKUP_RECORD).append,
      permissionsFor(BACKUP_RECORD).read,
      permissionsFor('auditEvents').append,
    ],
    correlationId,
  });
}

function permit(context: unknown): RequestContext {
  const problems = contextProblems(context);
  if (problems.length > 0) throw new BackupError('context', `backups: ${problems.join('; ')}`);
  const need = permissionsFor(BACKUP_RECORD).append;
  const checked = context as RequestContext;
  if (!checked.permissions.includes(need)) {
    throw new BackupError('permission', `backups: the actor may not produce one, which needs ${need}`);
  }
  return checked;
}

export interface MongoArchiveOptions {
  /**
   * Where this archive's per-class dump files are written — one `<class>.json` per `MONGO_CONTENTS` entry,
   * holding exactly the bytes that class's `BackupContent.hash` was computed over. This is what makes the
   * archive actually restorable rather than a fingerprint of data nothing durable ever holds: the caller
   * (`apps/worker`) hands this same directory to Restic right after, so the dump and the hash can never
   * drift apart.
   */
  readonly dumpDir: string;
  /** Runs once a class has been read and before the next is, so a test can prove point-in-time isolation. */
  readonly afterRead?: (className: string) => Promise<void> | void;
}

export interface MongoArchive {
  readonly contents: readonly BackupContent[];
  readonly consistency: BackupConsistency;
}

/**
 * Reads every Mongo content class inside one snapshot transaction, so a write that lands after the
 * snapshot starts is invisible to every class this reads — the one already read and the ones still to
 * come alike — rather than visible to some and not others. That is the whole of what "logically
 * consistent" asks of the Mongo half of a backup, and it is what makes it provable rather than assumed:
 * a concurrent write during the read cannot appear in what gets recorded, by construction of the read.
 */
export async function readMongoArchive(db: BackupDb, context: unknown, options: MongoArchiveOptions): Promise<MongoArchive> {
  permit(context);
  await mkdir(options.dumpDir, { recursive: true });
  const session = db.startSession();
  try {
    const contents = await session.withTransaction(
      async () => {
        const found: BackupContent[] = [];
        for (const { record, class: className } of MONGO_CONTENTS) {
          const documents = await db.collection(RECORDS[record].collection).find({}, { session }).toArray();
          const { content, text } = archiveEntryOf(className, documents);
          // Written inside the same read that computed `content.hash`, over the same `text`, so a restore
          // that later reads this file back and rehashes it is provably checking the bytes the manifest
          // actually recorded — not a hash computed from data that was, by then, already discarded.
          await writeFile(join(options.dumpDir, `${className}.json`), text, 'utf8');
          found.push(content);
          await options.afterRead?.(className);
        }
        return found;
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    return { contents, consistency: { pointInTime: true, method: CONSISTENCY_METHOD } };
  } finally {
    await session.endSession();
  }
}

export interface FinalizeBackupOptions {
  readonly now: () => string;
  readonly newId?: () => string;
  readonly schemaVersion: number;
}

/**
 * Assembles the two halves of one backup — the Mongo archive and whatever else was folded in, Restic's
 * settings and media contents among them — into one manifest, grades it against the contract, and only
 * then writes it: a manifest the contract refuses is a manifest no restore could read back, so it is
 * never the one persisted or audited.
 */
export async function finalizeBackup(
  db: RepositoryDb,
  context: unknown,
  input: {
    readonly mongoContents: readonly BackupContent[];
    readonly otherContents: readonly BackupContent[];
    readonly consistency: BackupConsistency;
  },
  options: FinalizeBackupOptions,
): Promise<BackupProduction> {
  const checked = permit(context);
  const newId = options.newId ?? (() => `backup-${options.now().replace(/[:.]/gu, '-')}`);
  const production = {
    manifest: {
      id: newId(),
      createdAt: options.now(),
      schemaVersion: options.schemaVersion,
      contents: [...input.mongoContents, ...input.otherContents],
      excludedSecrets: EXCLUDED_SECRETS,
    },
    consistency: input.consistency,
  };
  const graded = parseBackupProduction(production);
  if (!graded.ok) {
    const reasons = graded.problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ');
    throw new BackupError('schema', `a backup this code produced fails its own contract: ${reasons}`);
  }

  const repository = repositoriesOn(db)[BACKUP_RECORD];
  try {
    await repository.append(context, {
      _id: `backup:${graded.value.manifest.id}`,
      actor: checked.actor,
      correlationId: checked.correlationId,
      backupId: graded.value.manifest.id,
      at: graded.value.manifest.createdAt,
      manifest: graded.value.manifest,
      consistency: graded.value.consistency,
    });
  } catch (error) {
    if (error instanceof RepositoryError && error.kind === 'duplicate') {
      throw new BackupError('schema', `backup ${graded.value.manifest.id}: a backup with that identifier is already recorded`);
    }
    throw error;
  }

  await auditOn(db, { now: options.now }).record(context, {
    action: 'backup.run',
    subject: graded.value.manifest.id,
    outcome: 'allowed',
    detail: `${graded.value.manifest.contents.length} content classes recorded`,
  });

  return graded.value;
}

/** How a content class that lives in the Restic repository is addressed, as opposed to digested. */
export const SNAPSHOT_PREFIX = 'restic:';

export interface RecordedBackup {
  readonly backupId: string;
  readonly at: string;
  readonly production: BackupProduction;
  /**
   * Every Restic snapshot this run's restore set is spread across. Derived from the manifest rather than
   * stored beside it, so there is one place a run's snapshots are named and it is the manifest itself —
   * which is what makes "keep or forget a whole run" a statement about the restore set and not a guess.
   */
  readonly snapshots: readonly string[];
}

const snapshotsOf = (production: BackupProduction): readonly string[] =>
  production.manifest.contents
    .filter((content) => content.hash.startsWith(SNAPSHOT_PREFIX))
    .map((content) => content.hash.slice(SNAPSHOT_PREFIX.length));

/**
 * Every backup run this deployment recorded, newest first. Sorted here rather than by the database,
 * because the field is an instant written as text and a reader that assumes otherwise reads them in
 * whatever order the collection happens to hold.
 */
export async function recordedBackups(db: RepositoryDb, context: unknown): Promise<readonly RecordedBackup[]> {
  const rows = await repositoriesOn(db)[BACKUP_RECORD].read(context, {});
  return rows
    .map((row) => {
      const production = {
        manifest: row['manifest'],
        consistency: row['consistency'],
      } as unknown as BackupProduction;
      return {
        backupId: String(row['backupId']),
        at: String(row['at']),
        production,
        snapshots: snapshotsOf(production),
      };
    })
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}
