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

/**
 * Everything it takes to replace the settings file without a reader ever seeing a half-written one. Named
 * on its own because the worker needs exactly this much and none of the rest: it writes the generated
 * repository password once at boot and never watches, updates, or probes anything.
 */
export interface SettingsWriteIO {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

/** The filesystem operations this module needs, injected so no test here ever touches a real disk. */
export interface SettingsAdminIO extends SettingsWriteIO {
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
async function readTextOrEmpty(io: SettingsWriteIO, path: string): Promise<string> {
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

/** A temp file in the same directory, then a rename onto the path — see this module's opening note. */
async function writeAtomically(io: SettingsWriteIO, path: string, text: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  await io.writeFile(tmp, text);
  await io.rename(tmp, path);
}

/** Bytes of randomness behind a generated repository password, written out as hex — so 64 characters. */
const RESTIC_PASSWORD_BYTES = 32;

/**
 * A repository password no human chose, and therefore one no human has to. Hex rather than base64 so the
 * value survives every YAML quoting rule, every shell, and every copy-paste out of an operator's terminal
 * unchanged: this is the one secret here that somebody has to be able to write down and type back in.
 */
export const newResticPassword = (): string => randomBytes(RESTIC_PASSWORD_BYTES).toString('hex');

/**
 * Makes sure this deployment has a password to encrypt its backup repository under, generating one into
 * the settings file the first time and leaving it alone ever after. Generated rather than demanded,
 * because the alternative is an installation that silently cannot back up until somebody reads far enough
 * into the documentation — and an unencrypted repository was the failure this replaced.
 *
 * Never written over anything: a password already in the file, or one the environment supplies because an
 * operator would rather hold it themselves, is returned exactly as found. A second password would be a
 * repository nothing can open, since every snapshot already in it is encrypted under the first.
 *
 * The write goes through the same merge-and-validate path `update()` does, for the same reason: this
 * carries no second idea of what the settings file is allowed to contain.
 */
export async function ensureResticPassword(
  loaded: LoadedSettings,
  io: SettingsWriteIO & { readonly env: Record<string, string | undefined> },
  generate: () => string = newResticPassword,
): Promise<LoadedSettings> {
  if (loaded.values.resticPassword !== '') return loaded;
  const mapping = mappingIn(await readTextOrEmpty(io, loaded.path), loaded.path);
  mapping['resticPassword'] = generate();
  const merged = stringify(mapping);
  const next = loadSettings({ fileText: merged, env: io.env, path: loaded.path });
  await writeAtomically(io, loaded.path, merged);
  return next;
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

      await writeAtomically(io, path, merged);

      snapshot = loaded;
      reloadError = undefined;
      return loaded;
    },

    watch() {
      const path = snapshot.path;
      const base = basename(path);
      try {
        return io.watch(dirname(path), async (eventType, filename) => {
          if (filename !== null && String(filename) !== base) return;
          await reload(path);
        });
      } catch (error) {
        // A deployment that mounts no settings directory at all — the development stack, by design —
        // has nowhere for an external edit to land, so there is nothing to watch. That is one door
        // further along the same hall as readTextOrEmpty's "nothing here yet", not a boot failure.
        if (!isEnoent(error)) throw error;
        return { close() {} };
      }
    },
  };
}
