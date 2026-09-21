// The other half of invariant 10: a backup nobody has restored is a backup nobody knows is worth
// anything, so this module restores one — for real, into somewhere that is not production — and writes
// down what it cost. `backups.ts` produces the manifest's first two sections; the three only a restore
// can fill in are produced here, and `parseBackupManifest` refuses the whole thing if any of them is a
// claim rather than a measurement.
//
// Four decisions are worth stating outright, because each could plausibly have gone another way.
//
// *Isolation* is a separate database, named after the production one (`rehearsalDatabaseName`), reached
// through a `RestoreDb` handed in by the caller. Not a separate server: a rehearsal that needs one is a
// rehearsal nobody runs weekly, and the thing being proved is that the archive reconstitutes, not that a
// second machine can be provisioned. The module never learns the production database's name, so the one
// mistake that would matter — writing the archive over the data it was taken from — is not reachable
// from here, only from the caller choosing to hand in production itself.
//
// *Integrity* is honest about two different things a manifest calls a hash. The Mongo classes carry a
// `sha256:` of the exact bytes their dump file holds, so those are re-read and rehashed here, and that
// genuinely proves the archive is the one the manifest describes. The classes Restic holds carry
// `restic:<snapshot>`, which is an address rather than a digest — there is nothing in it to rehash, and
// what stands in for it is the repository's own check with a sample of its pack data read back, which is
// the worker's to run and proves rather less than a digest would. This module
// therefore verifies exactly what it can verify and names it in `INTEGRITY_ALGORITHM` rather than
// implying a single uniform check that does not exist.
//
// *Aborting on a mismatch* is structural, not a flag: every class is verified before the first write to
// the target, so a mismatch anywhere means nothing was written anywhere. That is what makes
// `mismatchAborts` true rather than aspirational.
//
// *Sessions* are invalidated explicitly, because a restore cannot do it implicitly: the archive
// deliberately excludes them, so putting it back leaves every open session exactly as it was — holding
// authority over a world that has just been replaced underneath it.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { parseBackupManifest } from '@holydeck/contracts/backups';

import { auditOn } from './audit.js';
import { BACKUP_RECORD, MONGO_CONTENTS, archiveEntryOf } from './backups.js';
import { contextProblems, requestContext } from './context.js';
import { RECORDS, permissionsFor } from './records.js';
import { repositoriesOn } from './repositories.js';
import { SESSION_PERMISSIONS } from './sessions.js';

import type { Db as MongoDb } from 'mongodb';

import type { BackupManifest, BackupProduction, RecoveryMeasurement } from '@holydeck/contracts/backups';
import type { RequestContext } from './context.js';
import type { RecordName } from './records.js';
import type { Document, Filter, RepositoryDb } from './repositories.js';

export const RESTORE_RECORD: RecordName = 'restores';

export interface RestoreIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

const DECLARED_INDEXES: readonly RestoreIndex[] = [{ name: 'restore_time', keys: { at: -1 }, options: {} }];

export const RESTORE_INDEXES = Object.freeze(DECLARED_INDEXES);

/**
 * What a recovery is held to. Both are stated in minutes because both are measured in minutes, but only
 * one of them is a threshold: a rehearsal that takes longer than `rtoMinutes` is refused, while
 * `rpoMinutes` is the figure the measurement is recorded against. The backup cadence — daily, and never
 * oftener than every two hours — is what decides how old the newest backup is at rehearsal time, so
 * 25 hours is the cadence plus headroom rather than a bound a restore could ever be at fault for missing.
 */
export const RECOVERY_OBJECTIVES = Object.freeze({ rpoMinutes: 1500, rtoMinutes: 240 });

/** Says what was actually checked, and by implication what was not — see this module's header. */
export const INTEGRITY_ALGORITHM =
  'sha256 over each restored dump file, compared to the digest the manifest recorded for that class; ' +
  'the snapshot-addressed classes are proved by a repository structure check plus a 5% data-read sample ' +
  'instead, having no digest to compare';

export const ROLLBACK_PLAN =
  'Every collection the restore replaces is read out and digested before the first write, and written ' +
  'back and re-digested afterwards; a rehearsal that cannot reproduce the digest it started from is ' +
  'reported as a failed rollback rather than left in place. The sessions the restore ended stay ended.';

/** The suffix that makes a rehearsal database impossible to mistake for the one it rehearses for. */
const REHEARSAL_SUFFIX = '__restore_rehearsal';

export type RestoreRefusal =
  | 'context'
  | 'permission'
  | 'isolation'
  | 'archive'
  | 'integrity'
  | 'objective'
  | 'rollback'
  | 'schema';

/** Carries why a rehearsal stopped, so a caller can tell a corrupt archive from a missed objective. */
export class RestoreError extends Error {
  readonly kind: RestoreRefusal;

  constructor(kind: RestoreRefusal, message: string) {
    super(message);
    this.name = 'RestoreError';
    this.kind = kind;
  }
}

/**
 * The name of the database a rehearsal restores into. Derived rather than configured, so a deployment
 * cannot forget to set it and quietly rehearse over production — and refused when it is already one,
 * because a rehearsal of a rehearsal is a name being reused rather than a second isolated environment.
 */
export function rehearsalDatabaseName(production: string): string {
  if (production.trim() === '') {
    throw new RestoreError('isolation', 'a rehearsal needs the name of the database it is rehearsing for');
  }
  if (production.endsWith(REHEARSAL_SUFFIX)) {
    throw new RestoreError('isolation', `${production} is already a rehearsal database, not one to rehearse for`);
  }
  return `${production}${REHEARSAL_SUFFIX}`;
}

/** The slice of a Mongo collection a restore uses. A restore replaces, so unlike a record class it removes. */
export interface RestoreCollection {
  find(filter: Filter): { toArray(): Promise<Document[]> };
  deleteMany(filter: Filter): Promise<{ deletedCount: number }>;
  insertMany(documents: readonly Document[]): Promise<{ insertedCount: number }>;
}

export interface RestoreDb {
  collection(name: string): RestoreCollection;
}

/** The driver satisfies this in practice; the cast is only about the document types it reports. */
export function restoreDb(db: MongoDb): RestoreDb {
  return { collection: (name) => db.collection(name) as unknown as RestoreCollection };
}

/** Exactly what a rehearsal needs of the session store, so nothing here can reach the rest of it. */
export interface RestoreSessions {
  revokeEvery(context: unknown): Promise<number>;
}

/** The context a rehearsal runs under: record itself, read the backup it is restoring, end every session. */
export function restoreContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [
      permissionsFor(RESTORE_RECORD).append,
      permissionsFor(RESTORE_RECORD).read,
      permissionsFor(BACKUP_RECORD).read,
      permissionsFor('auditEvents').append,
      SESSION_PERMISSIONS.end,
    ],
    correlationId,
  });
}

function permit(context: unknown): RequestContext {
  const problems = contextProblems(context);
  if (problems.length > 0) throw new RestoreError('context', `restores: ${problems.join('; ')}`);
  const need = permissionsFor(RESTORE_RECORD).append;
  const checked = context as RequestContext;
  if (!checked.permissions.includes(need)) {
    throw new RestoreError('permission', `restores: the actor may not rehearse one, which needs ${need}`);
  }
  return checked;
}

const digestOf = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** One archived class, read back off disk and proved to be the bytes the manifest recorded. */
export interface RestoredClass {
  readonly class: string;
  readonly collection: string;
  readonly documents: readonly Document[];
}

const DUMP_FILES = MONGO_CONTENTS.map((pair) => `${pair.class}.json`);

/**
 * Where the dump actually landed. Restic puts a snapshot back under the absolute path it was taken from,
 * so the directory a restore was pointed at is the root of a tree rather than the directory holding the
 * files — and the only honest way to find them is to look for the whole set together.
 */
async function dumpDirectoryIn(root: string): Promise<string> {
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift() as string;
    const entries = await readdir(directory, { withFileTypes: true });
    const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    if (DUMP_FILES.every((name) => files.has(name))) return directory;
    for (const entry of entries) if (entry.isDirectory()) queue.push(join(directory, entry.name));
  }
  throw new RestoreError('archive', `the restored archive holds no dump of ${DUMP_FILES.join(', ')}`);
}

/**
 * Re-reads every Mongo-held class out of a restored archive and proves it is the one the manifest
 * describes, before a caller has written anything anywhere. A class the manifest never inventoried and a
 * class whose bytes changed are both refusals: the first is an archive that cannot be restored whole, the
 * second an archive that must not be.
 */
export async function verifyMongoArchive(
  restoredRoot: string,
  production: BackupProduction,
): Promise<readonly RestoredClass[]> {
  const where = production.manifest.id;
  const directory = await dumpDirectoryIn(restoredRoot);
  const verified: RestoredClass[] = [];
  for (const { record, class: className } of MONGO_CONTENTS) {
    const content = production.manifest.contents.find((candidate) => candidate.class === className);
    if (content === undefined) {
      throw new RestoreError('archive', `restore ${where}: the manifest never inventoried ${className}`);
    }
    const text = await readFile(join(directory, `${className}.json`), 'utf8');
    if (digestOf(text) !== content.hash) {
      throw new RestoreError(
        'integrity',
        `restore ${where}: the restored ${className} archive does not match the digest the manifest recorded`,
      );
    }
    const documents: unknown = JSON.parse(text);
    if (!Array.isArray(documents)) {
      throw new RestoreError('archive', `restore ${where}: the restored ${className} archive is not a list of documents`);
    }
    verified.push({ class: className, collection: RECORDS[record].collection, documents: documents as Document[] });
  }
  return verified;
}

/** A digest over a whole collection, in a fixed order, so "what was there" can be compared with "what is". */
const stateOf = (collection: string, documents: readonly Document[]): string => {
  const ordered = [...documents].sort((left, right) => String(left['_id']).localeCompare(String(right['_id'])));
  return archiveEntryOf(collection, ordered).content.hash;
};

interface CapturedCollection {
  readonly collection: string;
  readonly documents: readonly Document[];
  readonly digest: string;
}

const replace = async (target: RestoreDb, collection: string, documents: readonly Document[]): Promise<void> => {
  const rows = target.collection(collection);
  await rows.deleteMany({});
  if (documents.length > 0) await rows.insertMany(documents);
};

const MINUTE_MS = 60_000;

/** Whole minutes, rounded up: half a minute over an objective is over it. */
const minutesBetween = (from: string, to: string): number =>
  Math.max(0, Math.ceil((Date.parse(to) - Date.parse(from)) / MINUTE_MS));

export interface RecoveryTargets {
  readonly rpoMinutes: number;
  readonly rtoMinutes: number;
}

export interface RehearsalOptions {
  /** The directory the archive was restored into, anywhere inside which the dump files can be found. */
  readonly restoredRoot: string;
  /** Where the archive is applied. Never production — see `rehearsalDatabaseName`. */
  readonly target: RestoreDb;
  readonly sessions: RestoreSessions;
  /** Injected, so every figure this records comes from one clock and a test does not have to wait. */
  readonly now: () => string;
  readonly newId?: () => string;
  readonly schemaVersion: number;
  readonly objectives?: RecoveryTargets;
  /**
   * Runs once the target is serving the restored world with every session already ended, and before the
   * rollback puts it back — the one moment anything can observe what a real cutover would leave behind.
   * Deliberately outside the timed window: watching a rehearsal is not part of recovering from a disaster.
   */
  readonly afterRestore?: () => Promise<void> | void;
}

export interface Rehearsal {
  readonly restoreId: string;
  /** The whole manifest, graded — what the backup held, and what restoring it proved. */
  readonly manifest: BackupManifest;
  readonly sessionsEnded: number;
}

/**
 * Restores a backup into an isolated target, times it, ends every session, puts the target back, and
 * records the manifest the whole of that produces. Every refusal after the context is checked is audited
 * before it is raised: a rehearsal that failed is exactly the one somebody needs to find later.
 */
export async function rehearseRestore(
  db: RepositoryDb,
  context: unknown,
  production: BackupProduction,
  options: RehearsalOptions,
): Promise<Rehearsal> {
  const checked = permit(context);
  const trail = auditOn(db, { now: options.now });
  const backupId = production.manifest.id;
  try {
    return await run(db, checked, production, options);
  } catch (error) {
    if (error instanceof RestoreError) {
      await trail.record(context, {
        action: 'restore.run',
        subject: backupId,
        outcome: 'refused',
        detail: error.message,
      });
    }
    throw error;
  }
}

async function run(
  db: RepositoryDb,
  checked: RequestContext,
  production: BackupProduction,
  options: RehearsalOptions,
): Promise<Rehearsal> {
  const backupId = production.manifest.id;
  const targets = options.objectives ?? RECOVERY_OBJECTIVES;
  const startedAt = options.now();

  // Read out what the target holds before anything replaces it. Done first so a rollback is possible even
  // for the archive that turns out to be corrupt — and so the digests it is checked against were taken
  // from the same reads the write-back will use.
  const captured: CapturedCollection[] = [];
  for (const { record } of MONGO_CONTENTS) {
    const collection = RECORDS[record].collection;
    const documents = await options.target.collection(collection).find({}).toArray();
    captured.push({ collection, documents, digest: stateOf(collection, documents) });
  }

  // Everything, before anything: a mismatch in the last class has to stop the first one being written.
  const verified = await verifyMongoArchive(options.restoredRoot, production);

  for (const entry of verified) await replace(options.target, entry.collection, entry.documents);

  // The archive carries no session, so putting it back leaves every open one holding authority over a
  // world that has just been replaced underneath it. Ending them is part of the restore, not after it.
  const sessionsEnded = await options.sessions.revokeEvery(checked);

  const finishedAt = options.now();
  const measured: RecoveryMeasurement = {
    rpoMinutes: minutesBetween(production.manifest.createdAt, startedAt),
    rtoMinutes: minutesBetween(startedAt, finishedAt),
  };

  await options.afterRestore?.();

  // The rollback is carried out rather than described, and then checked: `verified: true` in the manifest
  // means this deployment put the target back and reproduced the digest it started from.
  for (const entry of captured) {
    await replace(options.target, entry.collection, entry.documents);
    const after = await options.target.collection(entry.collection).find({}).toArray();
    if (stateOf(entry.collection, after) !== entry.digest) {
      throw new RestoreError(
        'rollback',
        `restore ${backupId}: rolling ${entry.collection} back did not reproduce what was there before it`,
      );
    }
  }

  // Only the recovery time can fail a rehearsal. The recovery point is how long ago the backup being
  // rehearsed was taken, which the backup cadence decided and this restore had no part in, so it is
  // recorded in the manifest below and not something a rehearsal is stopped for.
  if (measured.rtoMinutes > targets.rtoMinutes) {
    throw new RestoreError(
      'objective',
      `restore ${backupId}: the recovery time measured ${measured.rtoMinutes} minutes against a ${targets.rtoMinutes}-minute objective`,
    );
  }

  const graded = parseBackupManifest({
    manifest: production.manifest,
    consistency: production.consistency,
    integrity: { verifiedBeforeRestore: true, algorithm: INTEGRITY_ALGORITHM, mismatchAborts: true },
    objectives: { ...targets, measured },
    restore: {
      sessionsInvalidated: true,
      // The count as well as the fact: a rehearsal that ended none because there were none to end is a
      // different thing to have proved than one that ended every session a congregation was holding.
      sessionsInvalidatedCount: sessionsEnded,
      // A date, not the instant: what is being recorded is the day the plan was last carried out.
      rollback: { plan: ROLLBACK_PLAN, verified: true, verifiedOn: finishedAt.slice(0, 10) },
    },
  });
  if (!graded.ok) {
    const reasons = graded.problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ');
    throw new RestoreError('schema', `a rehearsal this code ran fails its own contract: ${reasons}`);
  }

  const newId = options.newId ?? ((): string => `restore-${finishedAt.replace(/[:.]/gu, '-')}`);
  const restoreId = newId();
  await repositoriesOn(db)[RESTORE_RECORD].append(checked, {
    _id: `restore:${restoreId}`,
    actor: checked.actor,
    correlationId: checked.correlationId,
    restoreId,
    backupId,
    at: finishedAt,
    manifest: graded.value.manifest,
    consistency: graded.value.consistency,
    integrity: graded.value.integrity,
    objectives: graded.value.objectives,
    restore: graded.value.restore,
  });

  await auditOn(db, { now: () => finishedAt }).record(checked, {
    action: 'restore.run',
    subject: backupId,
    outcome: 'allowed',
    detail: `recovery point ${measured.rpoMinutes} minutes, recovery time ${measured.rtoMinutes} minutes, ${sessionsEnded} sessions ended`,
  });

  return { restoreId, manifest: graded.value, sessionsEnded };
}
