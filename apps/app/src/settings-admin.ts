// Where the settings file is written, hot-reloaded, and held as the one snapshot an administrator's own
// routes read from. `settings.ts` is a read-only loader; this module holds the mutable state around it,
// the way `accounts.ts` holds accounts and `accounts-routes.ts` merely calls it.
//
// A write is never built from the loader's resolved values: `port: 4200` resolved from the environment
// would go straight back into the file if it were, and a value only the environment ever chose would
// quietly become one the file chose too. `update()` therefore rereads the raw file text fresh from disk,
// merges the partial change into it, and validates the whole merged file through the loader itself, so
// this module carries no second copy of what a setting means or is allowed to be.
//
// Written atomically — a temp file in the same directory, then a rename onto the canonical path — so a
// reader never sees a half-written file. Reloaded from a watch on the directory rather than the file
// itself: the rename changes the file's inode, and a watch on the file stops seeing anything the moment
// that happens, which is exactly what an atomic replace does every time.

import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { parse, stringify } from 'yaml';

import { SettingsError, loadSettings } from './settings.js';

import type { LoadedSettings, Settings } from './settings.js';

/** The filesystem operations this module needs, injected so no test here ever touches a real disk. */
export interface SettingsAdminIO {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  watch(dir: string, listener: (eventType: string, filename: string | Buffer | null) => void): { close(): void };
}

export interface SettingsAdminOptions extends SettingsAdminIO {
  readonly env: Record<string, string | undefined>;
}

export interface SettingsAdmin {
  /** The settings this process currently serves from. Never stale by more than one reload cycle. */
  current(): LoadedSettings;
  /** What the last hot reload rejected, if the file changed underneath this process into something invalid. */
  lastReloadError(): string | undefined;
  /** Merges a partial change into the file on disk, validates the whole result, and adopts it. */
  update(partial: Partial<Settings>): Promise<LoadedSettings>;
  /** Starts watching the settings file's directory for an external edit. Stop it with the handle's `close()`. */
  watch(): { close(): void };
}

const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** A fresh install, and a file an external edit just deleted, both read as "nothing here yet". */
async function readTextOrEmpty(io: SettingsAdminIO, path: string): Promise<string> {
  try {
    return await io.readFile(path);
  } catch (error) {
    if (isEnoent(error)) return '';
    throw error;
  }
}

function mappingIn(text: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch {
    return {};
  }
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}

export function settingsAdminOn(seed: LoadedSettings, io: SettingsAdminOptions): SettingsAdmin {
  let snapshot = seed;
  let reloadError: string | undefined;

  async function reload(path: string): Promise<void> {
    // The read and the validation share one catch: a permission hiccup during a hot reload is recorded
    // the same way a rejected file is, rather than becoming an unhandled rejection off the watcher.
    try {
      const text = await readTextOrEmpty(io, path);
      snapshot = loadSettings({ fileText: text, env: io.env, path });
      reloadError = undefined;
    } catch (error) {
      reloadError = error instanceof SettingsError ? error.message : String(error);
    }
  }

  return {
    current: () => snapshot,
    lastReloadError: () => reloadError,

    async update(partial) {
      const path = snapshot.path;
      const mapping = mappingIn(await readTextOrEmpty(io, path));
      Object.assign(mapping, partial);
      const merged = stringify(mapping);
      // Validated as a whole before anything is written: a partial change that fails alongside a valid one
      // must leave both unwritten, and the loader is the one place that already knows what "valid" means.
      const loaded = loadSettings({ fileText: merged, env: io.env, path });

      const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
      await io.writeFile(tmp, merged);
      await io.rename(tmp, path);

      snapshot = loaded;
      reloadError = undefined;
      return loaded;
    },

    watch() {
      const path = snapshot.path;
      const base = basename(path);
      return io.watch(dirname(path), async (eventType, filename) => {
        if (filename !== null && String(filename) !== base) return;
        await reload(path);
      });
    },
  };
}
