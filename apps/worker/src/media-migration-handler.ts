// The worker's own half of OPS-16: moves this deployment's media storage to a new root, verifying every
// file survives the copy byte-for-byte before the setting itself ever changes. Behind the same maintenance
// lease `restore-apply-handler.ts` uses, so no upload lands mid-migration.
//
// Enumerates by a plain recursive walk over `mediaRoot` rather than through `MediaLibrary.list()`, because
// `MediaRecord.storageKey` only names the primary asset file — a video's poster derivative is never itself
// a recorded storage key, so a Mongo-driven approach would silently skip it, and every other orphaned file
// besides.
//
// Every file is hashed twice: once reading the source bytes, once reading the destination bytes back after
// the copy — copy-integrity, not content-provenance. A mismatch is this job's own failure (`MediaMigrationError`):
// it stops the whole migration rather than skipping the bad file, and never touches the setting — the
// partial copy already at the destination is left in place for an operator to inspect, not cleared
// automatically.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { auditOn } from '@holydeck/app/audit';
import { writeSettings } from '@holydeck/app/settings-admin';

import type { MaintenanceStore } from '@holydeck/app/maintenance';
import type { MediaMigrationStateStore } from '@holydeck/app/media-migration-state';
import type { RepositoryDb } from '@holydeck/app/repositories';
import type { LoadedSettings } from '@holydeck/app/settings';
import type { SettingsWriteIO } from '@holydeck/app/settings-admin';
import type { Handler } from './runner.js';

export class MediaMigrationError extends Error {}

export interface MediaMigrationHandlerOptions {
  readonly context: unknown;
  readonly db: RepositoryDb;
  /** Acquired before the first byte moves and released once this job is fully done, success or failure. */
  readonly maintenance: MaintenanceStore;
  readonly migrationState: MediaMigrationStateStore;
  readonly loaded: LoadedSettings;
  readonly settingsIo: SettingsWriteIO & { readonly env: Record<string, string | undefined> };
  readonly now: () => string;
  readonly report?: (line: string) => void;
}

const stopped = (signal: AbortSignal): void => {
  if (signal.aborted) throw new MediaMigrationError('media migration stopped after its lease was lost');
};

const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

const hashFile = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
};

/** Every file under `root`, named relative to it. A root nothing has ever written into yet has none. */
const filesUnder = async (root: string): Promise<readonly string[]> => {
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) files.push(relative(root, join(entry.parentPath, entry.name)));
  }
  return files;
};

/**
 * Copies every file under the current `mediaRoot` into the job's `targetRoot`, verifies each one, and only
 * then switches `mediaRoot` itself — through the same `writeSettings` every other settings write goes
 * through, so this carries no second idea of what changing a setting means. See this module's header for
 * what a hash mismatch does instead.
 */
export function mediaMigrationOn(options: MediaMigrationHandlerOptions): Handler {
  return async (job, signal) => {
    const targetRoot = String(job.payload['targetRoot'] ?? '');
    if (targetRoot === '') throw new MediaMigrationError('a media-root-migrate job must name payload.targetRoot');
    const fromRoot = options.loaded.values.mediaRoot;
    if (targetRoot === fromRoot) {
      throw new MediaMigrationError('the target root is the same as the current media root');
    }

    const trail = auditOn(options.db, { now: options.now });
    await options.maintenance.acquire(`migrating media storage to ${targetRoot}`, options.now());
    try {
      const files = await filesUnder(fromRoot);
      for (const file of files) {
        stopped(signal);
        const sourcePath = join(fromRoot, file);
        const destPath = join(targetRoot, file);
        const sourceHash = await hashFile(sourcePath);
        await mkdir(dirname(destPath), { recursive: true });
        await pipeline(createReadStream(sourcePath), createWriteStream(destPath));
        const destHash = await hashFile(destPath);
        if (sourceHash !== destHash) {
          throw new MediaMigrationError(
            `${file} did not verify after copy: source ${sourceHash} != destination ${destHash}`,
          );
        }
        options.report?.(`media migration: verified ${file}`);
      }

      const updated = await writeSettings(options.loaded, options.settingsIo, { mediaRoot: targetRoot });
      await options.migrationState.recordCompletion({ fromRoot, toRoot: targetRoot, completedAt: options.now() });
      await trail.record(options.context, {
        action: 'media.storageMigration.complete',
        subject: targetRoot,
        outcome: 'allowed',
        detail: `moved ${files.length} file(s) from ${fromRoot}`,
      });
      options.report?.(`media migration: switched mediaRoot to ${updated.values.mediaRoot}`);
    } catch (error) {
      try {
        await trail.record(options.context, {
          action: 'media.storageMigration.fail',
          subject: targetRoot,
          outcome: 'refused',
          detail: (error as Error).message,
        });
      } catch (auditError) {
        options.report?.(`media migration: the trail refused an entry: ${(auditError as Error).message}`);
      }
      throw error;
    } finally {
      await options.maintenance.release();
    }
  };
}
