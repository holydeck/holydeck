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

/** Every setting `update()` probes for real filesystem write access before adopting a change to it. */
const WRITABILITY_CHECKED: ReadonlySet<keyof Settings> = new Set<keyof Settings>(['mediaRoot', 'resticRepository']);

/** The filesystem operations this module needs, injected so no test here ever touches a real disk. */
export interface SettingsAdminIO {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  watch(dir: string, listener: (eventType: string, filename: string | Buffer | null) => void): { close(): void };
  /** Whether this process can write into the given path. Probed for a changed media root or Restic
   * repository before the change is adopted, so a deployment-mounted path that turns out to be
   * read-only is refused before anything is written, rather than discovered at the first upload. */
  writable(path: string): Promise<boolean>;
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

// Refuses the same way `settings.ts`'s own `readFileLayer` does: a file an external hand corrupted since
// the last load is not "nothing here yet", and merging a partial change into `{}` would silently discard
// every field it holds, reverting them to defaults on the very next unrelated change. `update()` must
// leave a corrupted file exactly as corrupted as it found it, the same as a bad submitted field does.
function mappingIn(text: string, path: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch {
    throw new SettingsError([`${path}: is not valid YAML`]);
  }
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SettingsError([`${path}: expected a mapping of settings`]);
  }
  return { ...(raw as Record<string, unknown>) };
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
      const mapping = mappingIn(await readTextOrEmpty(io, path), path);
      Object.assign(mapping, partial);
      const merged = stringify(mapping);
      // Validated as a whole before anything is written: a partial change that fails alongside a valid one
      // must leave both unwritten, and the loader is the one place that already knows what "valid" means.
      const loaded = loadSettings({ fileText: merged, env: io.env, path });

      // Probed only for the paths this change actually touches, and only after the schema itself
      // accepts them: a syntactically valid path is still worth nothing if this process cannot write
      // into it, and that must be caught before the file is touched, exactly like a schema rejection.
      // Every unwritable path is collected rather than just the first, for the same reason the loader
      // itself reports every problem at once: a deployment fixes them all in one pass.
      const unwritable: string[] = [];
      for (const key of Object.keys(partial) as Array<keyof Settings>) {
        if (!WRITABILITY_CHECKED.has(key)) continue;
        const target = loaded.values[key] as string;
        if (!(await io.writable(target))) {
          unwritable.push(`${key}: expected a writable path, but this process cannot write to ${JSON.stringify(target)}`);
        }
      }
      if (unwritable.length > 0) throw new SettingsError(unwritable, 'unwritable');

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
