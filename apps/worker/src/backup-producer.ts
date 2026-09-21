// The job that carries out invariant 10: read the Mongo archive at one snapshot, fold in what Restic
// backs up of settings, media, and the archive's own dump, and hand the result to `finalizeBackup` — which
// grades it against the contract and only then writes it. Nothing here decides what "consistent" or
// "complete" means; both are `apps/app`'s and Restic's to answer, and this module is only their meeting
// point.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { retentionFor } from '@holydeck/app/backup-retention';
import { finalizeBackup, readMongoArchive, recordedBackups } from '@holydeck/app/backups';
import { redactSettingsText } from '@holydeck/app/settings';

import { backupPath, forgetSnapshots, initRepository } from './restic.js';

import type { BackupDb } from '@holydeck/app/backups';
import type { RepositoryDb } from '@holydeck/app/repositories';
import type { ResticOptions } from './restic.js';
import type { Handler } from './runner.js';

export interface BackupProducerOptions {
  readonly context: unknown;
  /** The database `readMongoArchive` reads the Mongo half of the archive from, inside its own snapshot. */
  readonly archive: BackupDb;
  /** The database `finalizeBackup` writes the finished manifest and its audit entry through. */
  readonly db: RepositoryDb;
  readonly restic: ResticOptions;
  /** The settings file itself, not its directory: only this file is staged into the "settings" class, and
   * redacted first — see `stageRedactedSettings`. */
  readonly settingsPath: string;
  readonly mediaRoot: string;
  readonly schemaVersion: number;
  readonly now: () => string;
  readonly newId?: () => string;
  /** Where a condition worth knowing about but not worth failing the job over is written. */
  readonly report?: (line: string) => void;
}

const stopped = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error('backup production stopped after its lease was lost');
};

const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/**
 * Stages a redacted copy of the settings file into an otherwise-empty directory, so the "settings" class
 * Restic backs up never carries `corpusToken` or `mongoUrl` verbatim. A deployment with no settings file
 * yet — everything at defaults or in the environment — stages nothing at all, and Restic backs up an
 * empty directory rather than this step failing the run.
 */
async function stageRedactedSettings(settingsPath: string, stagingDir: string): Promise<void> {
  let fileText: string;
  try {
    fileText = await readFile(settingsPath, 'utf8');
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  await writeFile(join(stagingDir, basename(settingsPath)), redactSettingsText(fileText));
}

/** The content class the Mongo archive's own dump is backed up as — what a restore has to put back first. */
export const MONGO_DUMP_CLASS = 'mongo';

/**
 * Produces one backup: the Mongo archive (read, dumped to a temp directory, then backed up through Restic
 * so it is actually restorable rather than a fingerprint of data nothing durable ever holds), Restic's
 * settings and media, and the manifest joining all three.
 */
export function backupProducerOn(options: BackupProducerOptions): Handler {
  return async (_job, signal) => {
    const dumpDir = await mkdtemp(join(tmpdir(), 'holydeck-backup-mongo-'));
    const settingsStagingDir = await mkdtemp(join(tmpdir(), 'holydeck-backup-settings-'));
    try {
      const archive = await readMongoArchive(options.archive, options.context, { dumpDir });
      stopped(signal);

      await stageRedactedSettings(options.settingsPath, settingsStagingDir);
      stopped(signal);

      // Deferred to here rather than done once at worker start-up: a build that never claims a `backup-run`
      // job never needs the repository, or the binary, to exist at all.
      await initRepository(options.restic, signal);
      stopped(signal);

      const mongo = await backupPath(options.restic, MONGO_DUMP_CLASS, MONGO_DUMP_CLASS, dumpDir, signal);
      stopped(signal);
      const settings = await backupPath(options.restic, 'settings', 'settings', settingsStagingDir, signal);
      stopped(signal);
      const media = await backupPath(options.restic, 'media', 'media', options.mediaRoot, signal);
      stopped(signal);

      const produced = await finalizeBackup(
        options.db,
        options.context,
        { mongoContents: archive.contents, otherContents: [mongo, settings, media], consistency: archive.consistency },
        { now: options.now, newId: options.newId, schemaVersion: options.schemaVersion },
      );
      stopped(signal);

      // Last, and only once the new backup is recorded: retention decides what to keep out of everything
      // that now exists, so a run that failed before finalizing can never be the reason an older one goes.
      //
      // And reported rather than thrown, because by here the backup this job was for is already recorded:
      // letting retention fail the job would retry the whole of it — a second Mongo dump, three more
      // snapshots and a second recorded run — to repeat work that succeeded. The snapshots retention did
      // not get to forget are still there for the next run to decide about, which is the cheaper wrong.
      try {
        const decided = retentionFor(await recordedBackups(options.db, options.context));
        await forgetSnapshots(options.restic, decided.snapshotsToForget, signal);
      } catch (error) {
        options.report?.(
          `backup ${produced.manifest.id}: recorded, but retention kept every snapshot: ${(error as Error).message}`,
        );
      }
    } finally {
      await rm(dumpDir, { recursive: true, force: true });
      await rm(settingsStagingDir, { recursive: true, force: true });
    }
  };
}
