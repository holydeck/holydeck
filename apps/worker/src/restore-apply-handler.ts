// The worker's own half of OPS-06: applies one recorded backup to production, for real, behind the
// maintenance lease `guardMaintenance` reads on the app side, so no mutation lands mid-restore. Mirrors
// `restore-rehearsal.ts`'s shape — find the backup, restic-restore what its manifest names, hand the
// result to `apps/app`'s own business logic — but restores the specific backup a request named rather
// than the newest one, restores every class the job asked for rather than only the mongo dump, and puts
// each class back onto a live path instead of an isolated rehearsal database. `applyRestore` itself
// already writes `restore.run`; the `restore.apply.complete`/`restore.apply.fail` entries here are this
// handler's own, naming what the worker actually carried out around that call — see `audit.ts`.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { RESTORE_CLASSES } from '@holydeck/contracts/backups';

import { auditOn } from '@holydeck/app/audit';
import { SNAPSHOT_PREFIX, recordedBackups } from '@holydeck/app/backups';
import { applyRestore, fileRestoreTarget } from '@holydeck/app/restore-apply';

import { MONGO_DUMP_CLASS, SETTINGS_STAGING_DIR } from './backup-producer.js';
import { checkRepository, restoreSnapshot } from './restic.js';

import type { MaintenanceStore } from '@holydeck/app/maintenance';
import type { RepositoryDb } from '@holydeck/app/repositories';
import type { RestoreApplyTargets } from '@holydeck/app/restore-apply';
import type { RestoreCapabilities, RestoreDb, RestoreSessions } from '@holydeck/app/restores';
import type { BackupProduction, RestoreClass } from '@holydeck/contracts/backups';
import type { ResticOptions } from './restic.js';
import type { Handler } from './runner.js';

export interface RestoreApplyHandlerOptions {
  readonly context: unknown;
  readonly db: RepositoryDb;
  /** The live production database a `mongo` class is replaced into — never a rehearsal database. */
  readonly target: RestoreDb;
  readonly sessions: RestoreSessions;
  readonly capabilities: RestoreCapabilities;
  /** Acquired before the first byte moves and released once this job is fully done, success or failure. */
  readonly maintenance: MaintenanceStore;
  readonly restic: ResticOptions;
  /** The live settings file a `settings` class is replaced onto. */
  readonly settingsPath: string;
  /** The live media directory a `media` class is replaced onto. */
  readonly mediaRoot: string;
  readonly now: () => string;
  readonly report?: (line: string) => void;
}

const stopped = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error('restore apply stopped after its lease was lost');
};

const isRestoreClass = (value: unknown): value is RestoreClass =>
  typeof value === 'string' && (RESTORE_CLASSES as readonly string[]).includes(value);

/** What the job asked for, or — a payload naming none — every class the backup could possibly carry. */
const classesOf = (payload: Readonly<Record<string, unknown>>): readonly RestoreClass[] => {
  const requested = payload['components'];
  return Array.isArray(requested) && requested.length > 0 && requested.every(isRestoreClass)
    ? requested
    : RESTORE_CLASSES;
};

function snapshotIdOf(production: BackupProduction, backupId: string, className: string): string {
  const content = production.manifest.contents.find(
    (entry) => entry.class === className && entry.hash.startsWith(SNAPSHOT_PREFIX),
  );
  if (content === undefined) {
    throw new Error(`restore ${backupId}: no snapshot holds the ${className} archive`);
  }
  return content.hash.slice(SNAPSHOT_PREFIX.length);
}

/**
 * Restores one recorded backup onto production: the mongo dump into `target`, settings onto
 * `settingsPath`, media onto `mediaRoot` — whichever of the three the job's payload named — behind the
 * maintenance lease every mutating route refuses while it is held.
 */
export function restoreApplyOn(options: RestoreApplyHandlerOptions): Handler {
  return async (job, signal) => {
    const backupId = String(job.payload['backupId'] ?? '');
    if (backupId === '') throw new Error('a restore-apply job must name the backupId to restore');
    const classes = classesOf(job.payload);

    const recorded = await recordedBackups(options.db, options.context);
    const backup = recorded.find((entry) => entry.backupId === backupId);
    if (backup === undefined) throw new Error(`restore-apply: ${backupId} is not a recorded backup`);

    const trail = auditOn(options.db, { now: options.now });
    await options.maintenance.acquire(`applying restore ${backupId}`, options.now());
    let scratchRoot: string | undefined;
    try {
      await checkRepository(options.restic, signal);
      stopped(signal);

      scratchRoot = await mkdtemp(join(tmpdir(), 'holydeck-restore-apply-'));
      const targets: {
        mongo?: RestoreApplyTargets['mongo'];
        settings?: RestoreApplyTargets['settings'];
        media?: RestoreApplyTargets['media'];
      } = {};

      if (classes.includes('mongo')) {
        const restoredRoot = join(scratchRoot, MONGO_DUMP_CLASS);
        await restoreSnapshot(options.restic, snapshotIdOf(backup.production, backupId, MONGO_DUMP_CLASS), restoredRoot, signal);
        stopped(signal);
        targets.mongo = { restoredRoot, target: options.target };
      }
      if (classes.includes('settings')) {
        const restoredRoot = join(scratchRoot, 'settings');
        await restoreSnapshot(options.restic, snapshotIdOf(backup.production, backupId, 'settings'), restoredRoot, signal);
        stopped(signal);
        targets.settings = fileRestoreTarget({
          restoredPath: join(restoredRoot, SETTINGS_STAGING_DIR, basename(options.settingsPath)),
          livePath: options.settingsPath,
        });
      }
      if (classes.includes('media')) {
        const restoredRoot = join(scratchRoot, 'media');
        await restoreSnapshot(options.restic, snapshotIdOf(backup.production, backupId, 'media'), restoredRoot, signal);
        stopped(signal);
        targets.media = fileRestoreTarget({ restoredPath: join(restoredRoot, options.mediaRoot), livePath: options.mediaRoot });
      }

      await applyRestore(options.db, options.context, backup.production, {
        selection: { mode: 'replace', classes },
        targets,
        sessions: options.sessions,
        capabilities: options.capabilities,
        now: options.now,
      });

      await trail.record(options.context, {
        action: 'restore.apply.complete',
        subject: backupId,
        outcome: 'allowed',
        detail: `restored ${classes.join(', ')}`,
      });
    } catch (error) {
      try {
        await trail.record(options.context, {
          action: 'restore.apply.fail',
          subject: backupId,
          outcome: 'refused',
          detail: (error as Error).message,
        });
      } catch (auditError) {
        options.report?.(`restore-apply ${backupId}: the restore trail refused an entry: ${(auditError as Error).message}`);
      }
      throw error;
    } finally {
      if (scratchRoot !== undefined) await rm(scratchRoot, { recursive: true, force: true });
      await options.maintenance.release();
    }
  };
}
