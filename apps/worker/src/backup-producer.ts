// The job that carries out invariant 10: read the Mongo archive at one snapshot, fold in what Restic
// backs up of settings and media, and hand the result to `finalizeBackup` — which grades it against the
// contract and only then writes it. Nothing here decides what "consistent" or "complete" means; both are
// `apps/app`'s and Restic's to answer, and this module is only their meeting point.

import { finalizeBackup, readMongoArchive } from '@holydeck/app/backups';

import { backupPath, initRepository } from './restic.js';

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
  readonly settingsDir: string;
  readonly mediaRoot: string;
  readonly schemaVersion: number;
  readonly now: () => string;
  readonly newId?: () => string;
}

const stopped = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error('backup production stopped after its lease was lost');
};

/** Produces one backup: the Mongo archive, Restic's settings and media, and the manifest joining them. */
export function backupProducerOn(options: BackupProducerOptions): Handler {
  return async (_job, signal) => {
    const archive = await readMongoArchive(options.archive, options.context);
    stopped(signal);

    // Deferred to here rather than done once at worker start-up: a build that never claims a `backup-run`
    // job never needs the repository, or the binary, to exist at all.
    await initRepository(options.restic, signal);
    stopped(signal);

    const settings = await backupPath(options.restic, 'settings', 'settings', options.settingsDir, signal);
    stopped(signal);
    const media = await backupPath(options.restic, 'media', 'media', options.mediaRoot, signal);
    stopped(signal);

    await finalizeBackup(
      options.db,
      options.context,
      { mongoContents: archive.contents, otherContents: [settings, media], consistency: archive.consistency },
      { now: options.now, newId: options.newId, schemaVersion: options.schemaVersion },
    );
  };
}
