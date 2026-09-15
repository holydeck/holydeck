import type { SettingsAdminIO } from '../../src/settings-admin.js';

type Listener = (eventType: string, filename: string | Buffer | null) => void | Promise<void>;

export interface FakeSettingsIO extends SettingsAdminIO {
  /** The filesystem this fake serves, keyed by absolute path. */
  readonly files: Map<string, string>;
  readonly writes: Array<{ path: string; text: string }>;
  readonly renames: Array<{ from: string; to: string }>;
  readonly watchedDirs: string[];
  closed: boolean;
  /** Makes the next `rename()` call reject, as if a crash landed between the write and the replace. */
  failNextRename(reason?: string): void;
  /** Calls the listener the module registered through `watch()`, as if the directory just changed. */
  emit(eventType: string, filename: string | null): Promise<void>;
}

/** Enough of a filesystem to prove an atomic write and a directory watch, without touching a real disk. */
export function fakeSettingsIO(initial: Record<string, string> = {}): FakeSettingsIO {
  const files = new Map(Object.entries(initial));
  const writes: Array<{ path: string; text: string }> = [];
  const renames: Array<{ from: string; to: string }> = [];
  const watchedDirs: string[] = [];
  let listener: Listener | undefined;
  let renameFailure: string | undefined;

  const io: FakeSettingsIO = {
    files,
    writes,
    renames,
    watchedDirs,
    closed: false,

    async readFile(path) {
      const text = files.get(path);
      if (text === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
      }
      return text;
    },

    async writeFile(path, text) {
      writes.push({ path, text });
      files.set(path, text);
    },

    async rename(from, to) {
      renames.push({ from, to });
      if (renameFailure !== undefined) {
        const reason = renameFailure;
        renameFailure = undefined;
        throw new Error(reason);
      }
      const text = files.get(from);
      files.delete(from);
      if (text !== undefined) files.set(to, text);
    },

    watch(dir, given) {
      watchedDirs.push(dir);
      listener = given;
      return { close: () => { io.closed = true; } };
    },

    failNextRename(reason = 'the filesystem refused the rename') {
      renameFailure = reason;
    },

    async emit(eventType, filename) {
      if (listener === undefined) throw new Error('nothing is watching yet');
      await listener(eventType, filename);
    },
  };
  return io;
}
