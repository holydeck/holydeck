import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HolyDeckError } from '@holydeck/core/messages';
import type { CliContext } from './context.js';

/** Where macOS mounts iCloud, Google Drive and the like — a denial there has its own remedy. */
const CLOUD_DRIVE = '/Library/CloudStorage/';

/**
 * Reads a sermon file, reserving "does not exist" for the case that really is that. A file the
 * operating system guards — anything under a macOS cloud-drive folder, say — is its own case with
 * its own remedy, and every other failure reports its reason, so a file the shell can list never
 * comes back as missing.
 */
export async function readSermonFile(ctx: CliContext, sermonPath: string): Promise<{ path: string; text: string }> {
  const path = resolve(ctx.cwd, sermonPath);
  try {
    return { path, text: await readFile(path, 'utf8') };
  } catch (error) {
    const cause = error as NodeJS.ErrnoException;
    if (cause.code === 'ENOENT') throw new HolyDeckError('sermon_file_missing', { path });
    if (cause.code === 'EPERM' || cause.code === 'EACCES') {
      const code = path.includes(CLOUD_DRIVE) ? 'sermon_file_forbidden_cloud' : 'sermon_file_forbidden';
      throw new HolyDeckError(code, { path, reason: cause.message });
    }
    throw new HolyDeckError('sermon_file_unreadable', { path, reason: cause.message });
  }
}
