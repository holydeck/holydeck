// The job that proves the backups are worth having: take the newest one this deployment recorded, put it
// back somewhere that is not production, and write down what that cost. The worker's part is only the two
// things `apps/app` cannot do for itself — ask Restic whether the repository is intact, and get the Mongo
// archive back out of it onto a disk — after which `rehearseRestore` owns every judgement about whether
// what came back is what was promised.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SNAPSHOT_PREFIX, recordedBackups } from '@holydeck/app/backups';
import { rehearseRestore } from '@holydeck/app/restores';

import { MONGO_DUMP_CLASS } from './backup-producer.js';
import { checkRepository, restoreSnapshot } from './restic.js';

import type { RepositoryDb } from '@holydeck/app/repositories';
import type { RecoveryTargets, RestoreCapabilities, RestoreDb, RestoreSessions } from '@holydeck/app/restores';
import type { ResticOptions } from './restic.js';
import type { Handler } from './runner.js';

export interface RestoreRehearsalOptions {
  readonly context: unknown;
  /** Where the backup to rehearse is read from, and the rehearsal it produces written back to. */
  readonly db: RepositoryDb;
  /** The isolated database the archive is applied to — see `rehearsalDatabaseName`, never production. */
  readonly target: RestoreDb;
  readonly sessions: RestoreSessions;
  readonly capabilities: RestoreCapabilities;
  readonly restic: ResticOptions;
  readonly schemaVersion: number;
  readonly now: () => string;
  readonly newId?: () => string;
  readonly objectives?: RecoveryTargets;
}

const stopped = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error('restore rehearsal stopped after its lease was lost');
};

/**
 * Rehearses restoring the newest recorded backup. The repository check comes first and on its own: the
 * classes Restic holds carry an address rather than a digest, so it is the only thing that can say those
 * are intact, and a repository that is not intact is one nothing should be restored out of.
 */
export function restoreRehearsalOn(options: RestoreRehearsalOptions): Handler {
  return async (_job, signal) => {
    const [newest] = await recordedBackups(options.db, options.context);
    if (newest === undefined) throw new Error('there is no recorded backup to rehearse a restore of');

    const dump = newest.production.manifest.contents.find(
      (content) => content.class === MONGO_DUMP_CLASS && content.hash.startsWith(SNAPSHOT_PREFIX),
    );
    if (dump === undefined) {
      throw new Error(`${newest.backupId}: no snapshot holds the mongo archive, so there is nothing to restore`);
    }

    await checkRepository(options.restic, signal);
    stopped(signal);

    const restoredRoot = await mkdtemp(join(tmpdir(), 'holydeck-restore-'));
    try {
      await restoreSnapshot(options.restic, dump.hash.slice(SNAPSHOT_PREFIX.length), restoredRoot, signal);
      stopped(signal);

      await rehearseRestore(options.db, options.context, newest.production, {
        restoredRoot,
        target: options.target,
        sessions: options.sessions,
        capabilities: options.capabilities,
        now: options.now,
        newId: options.newId,
        schemaVersion: options.schemaVersion,
        objectives: options.objectives,
      });
    } finally {
      await rm(restoredRoot, { recursive: true, force: true });
    }
  };
}
