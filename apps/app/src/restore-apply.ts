// BACK-03: putting a backup back into production, one content class at a time. `restores.ts` proves a
// backup restores at all, into somewhere that is never production; this is the module that actually
// applies one, and the two are deliberately kept apart — `rehearseRestore`'s own header names rehearsal-
// only as an invariant, and a production apply is not that.
//
// Three decisions are worth stating outright.
//
// *Selective and replace-only* is what `RestoreSelection` (see `@holydeck/contracts/backups`) already
// decided at the boundary: `mongo`, `settings` and `media` are independent, so any non-empty subset of
// them may be restored on its own, and `mode` accepts only `'replace'` — there is no merge to ask for.
// This module checks `mode` again rather than trusting the boundary alone, because the one thing worse
// than a merge being refused is a merge being half applied.
//
// *Everything is checked before anything is written*. Every requested class is proved against the
// manifest, and a target was wired to receive it, before the first write — the same guarantee
// `rehearseRestore` makes for the classes it restores at all. Mongo's own bytes are then reproved against
// the manifest's digest, exactly as `verifyMongoArchive` does for a rehearsal, before a single document is
// replaced.
//
// *Settings and media are the caller's to carry out*. Putting a Restic snapshot back onto a live path is
// filesystem surgery this module has no business doing blind — it takes a `RestoreFileTarget` per class
// instead, so the worker that actually owns the disk decides how "replace" happens and this module stays
// provable with a fake standing in for it.

import { cp, rm } from 'node:fs/promises';

import { auditContext, auditOn } from './audit.js';
import { contextProblems } from './context.js';
import { permissionsFor } from './records.js';
import { RESTORE_RECORD, RestoreError, replaceCollection, verifyMongoArchive } from './restores.js';

import type { BackupProduction, RestoreClass, RestoreSelection } from '@holydeck/contracts/backups';
import type { RequestContext } from './context.js';
import type { RepositoryDb } from './repositories.js';
import type { RestoreCapabilities, RestoreDb, RestoreSessions } from './restores.js';

export type RestoreApplyRefusal = 'context' | 'permission' | 'mode' | 'archive' | 'target';

/** Carries why a restore was refused, so a caller can tell an unwired target from a corrupt archive. */
export class RestoreApplyError extends Error {
  readonly kind: RestoreApplyRefusal;

  constructor(kind: RestoreApplyRefusal, message: string) {
    super(message);
    this.name = 'RestoreApplyError';
    this.kind = kind;
  }
}

/** Where Restic already restored the archive's Mongo dump, and the database to replace with it. */
export interface MongoRestoreTarget {
  readonly restoredRoot: string;
  readonly target: RestoreDb;
}

/**
 * One non-Mongo class's own "make it live" step. What restoring the class already staged means is the
 * caller's to know — this module only ever calls it once every class in the selection has been proved
 * restorable, and never partially.
 */
export interface RestoreFileTarget {
  replace(): Promise<void>;
}

/** Where a class was already restored to on disk — a file for settings, a directory for media — and the
 * live path it replaces. */
export interface FileRestoreTarget {
  readonly restoredPath: string;
  readonly livePath: string;
}

/**
 * The ordinary `RestoreFileTarget`: replaces the live path outright with what a caller already restored
 * onto disk, exactly as `MongoRestoreTarget` restores into an already-materialized `restoredRoot` rather
 * than reaching into Restic itself. `cp` rather than `rename`, because the restored path and the live path
 * are not guaranteed to share a filesystem.
 */
export function fileRestoreTarget(target: FileRestoreTarget): RestoreFileTarget {
  return {
    async replace() {
      await rm(target.livePath, { recursive: true, force: true });
      await cp(target.restoredPath, target.livePath, { recursive: true });
    },
  };
}

export interface RestoreApplyTargets {
  readonly mongo?: MongoRestoreTarget;
  readonly settings?: RestoreFileTarget;
  readonly media?: RestoreFileTarget;
}

export interface RestoreApplyOptions {
  readonly selection: RestoreSelection;
  readonly targets: RestoreApplyTargets;
  /** Ended only when `mongo` is part of the selection — see this module's header. */
  readonly sessions: RestoreSessions;
  /** Revoked only when `mongo` is part of the selection, the same as `sessions`. */
  readonly capabilities: RestoreCapabilities;
  readonly now: () => string;
}

export interface RestoreApplication {
  readonly classes: readonly RestoreClass[];
  /** How many sessions were ended, when `mongo` was restored. Absent when it was not. */
  readonly sessionsEnded?: number;
  /** How many capabilities were revoked, when `mongo` was restored. Absent when it was not. */
  readonly capabilitiesRevoked?: number;
}

function permit(context: unknown): RequestContext {
  const problems = contextProblems(context);
  if (problems.length > 0) throw new RestoreApplyError('context', `restore: ${problems.join('; ')}`);
  const need = permissionsFor(RESTORE_RECORD).append;
  const checked = context as RequestContext;
  if (!checked.permissions.includes(need)) {
    throw new RestoreApplyError('permission', `restore: the actor may not apply one, which needs ${need}`);
  }
  return checked;
}

function requireTarget<T>(restoreClass: RestoreClass, target: T | undefined, backupId: string): T {
  if (target === undefined) {
    throw new RestoreApplyError('target', `restore ${backupId}: no target was wired to restore ${restoreClass} into`);
  }
  return target;
}

/**
 * Applies a backup to production: replaces exactly the classes selected, having proved every one of them
 * restorable first, and ends every session once Mongo is among them. Every refusal is audited before it is
 * raised, the same as `rehearseRestore` audits its own.
 */
export async function applyRestore(
  db: RepositoryDb,
  context: unknown,
  production: BackupProduction,
  options: RestoreApplyOptions,
): Promise<RestoreApplication> {
  const trail = auditOn(db, { now: options.now });
  const backupId = production.manifest.id;
  try {
    const checked = permit(context);
    return await run(db, checked, production, options);
  } catch (error) {
    // `verifyMongoArchive` is `restores.ts`'s own, and raises `RestoreError` rather than this module's
    // own kind — audited the same way regardless, because a caller looking for why a restore was refused
    // should not have to know which of the two modules noticed. Recorded under a minimally-scoped
    // `auditContext` rather than the refused context itself: the context `permit` just refused may lack
    // `auditEvents.append`, and writing under it would only fail the append too. A context too malformed
    // to name an actor is the one refusal nothing here can audit — there is no identity to attribute it to.
    if ((error instanceof RestoreApplyError || error instanceof RestoreError) && contextProblems(context).length === 0) {
      const { actor, correlationId } = context as RequestContext;
      await trail.record(auditContext(actor, correlationId), {
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
  options: RestoreApplyOptions,
): Promise<RestoreApplication> {
  const backupId = production.manifest.id;
  const classes = options.selection.classes;

  // A merge attempt is refused here as well as at the boundary that parses it: the one thing worse than
  // refusing it is refusing it after some of it was already applied.
  if (options.selection.mode !== 'replace') {
    throw new RestoreApplyError('mode', `restore ${backupId}: only a replace restore is supported`);
  }

  // Every class, proved against the manifest and wired to a target, before the first write — so a request
  // this backup or this deployment cannot fully satisfy writes nothing at all rather than some of it.
  for (const restoreClass of classes) {
    if (!production.manifest.contents.some((content) => content.class === restoreClass)) {
      throw new RestoreApplyError('archive', `restore ${backupId}: the manifest never inventoried ${restoreClass}`);
    }
  }
  const mongoTarget = classes.includes('mongo') ? requireTarget('mongo', options.targets.mongo, backupId) : undefined;
  const settingsTarget = classes.includes('settings')
    ? requireTarget('settings', options.targets.settings, backupId)
    : undefined;
  const mediaTarget = classes.includes('media') ? requireTarget('media', options.targets.media, backupId) : undefined;

  // Once a write starts, a failure partway through must still leave a trace of what already happened —
  // Mongo replaced but settings not, say — even when the failure is an ordinary I/O error rather than one
  // of this module's own kinds, which `applyRestore`'s own catch only recognizes before anything is
  // written.
  const applied: RestoreClass[] = [];
  let sessionsEnded: number | undefined;
  let capabilitiesRevoked: number | undefined;
  try {
    if (mongoTarget !== undefined) {
      // Reproved against the manifest's digest, exactly as a rehearsal proves it, before a document moves.
      const verified = await verifyMongoArchive(mongoTarget.restoredRoot, production);
      for (const entry of verified) await replaceCollection(mongoTarget.target, entry.collection, entry.documents);
      applied.push('mongo');
    }
    if (settingsTarget !== undefined) {
      await settingsTarget.replace();
      applied.push('settings');
    }
    if (mediaTarget !== undefined) {
      await mediaTarget.replace();
      applied.push('media');
    }
    // The archive carries no session, so putting Mongo back leaves every open one holding authority over a
    // world that has just been replaced underneath it — the same reasoning `rehearseRestore` acts on.
    sessionsEnded = mongoTarget === undefined ? undefined : await options.sessions.revokeEvery(checked);
    // A capability outlives no restore either, for the same reason a session does not.
    capabilitiesRevoked = mongoTarget === undefined ? undefined : await options.capabilities.revokeEvery(checked);
  } catch (error) {
    if (applied.length > 0) {
      await auditOn(db, { now: options.now }).record(checked, {
        action: 'restore.run',
        subject: backupId,
        outcome: 'refused',
        detail: `restore ${backupId}: replaced ${applied.join(', ')} before failing: ${(error as Error).message}`,
      });
    }
    throw error;
  }

  await auditOn(db, { now: options.now }).record(checked, {
    action: 'restore.run',
    subject: backupId,
    outcome: 'allowed',
    detail:
      `restored ${classes.join(', ')}` +
      (sessionsEnded === undefined ? '' : `, ${sessionsEnded} sessions ended, ${capabilitiesRevoked} capabilities revoked`),
  });

  return { classes, sessionsEnded, capabilitiesRevoked };
}
