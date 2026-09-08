import { mkdir, open, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { HolyDeckError } from './messages.js';
import { appendRevision, createEmptyStoreFile, validateStoreFile } from './storage.js';
import type { TranslationStoreFile, VerseMap } from './storage.js';

const ABBR_PATTERN = /^[A-Z0-9]{1,16}$/;

export interface FileStoreOptions {
  now?: () => string;
  lockTimeoutMs?: number;
  lockPollMs?: number;
  staleLockMs?: number;
  /** Liveness probe for the process named in a lock file; injected in tests. */
  isProcessAlive?: (pid: number) => boolean;
  /** Identifies this machine in lock files, so a shared data dir never claims a foreign PID. */
  host?: string;
  /** Called once when a lock forces a wait, so a caller can say so instead of appearing hung. */
  onLockWait?: (info: { abbr: string; owner: string }) => void;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class FileStore {
  readonly dataDir: string;
  readonly now: () => string;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;
  private readonly staleLockMs: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly host: string;
  private readonly onLockWait: FileStoreOptions['onLockWait'];
  private saveCounter = 0;

  constructor(dataDir: string, options: FileStoreOptions = {}) {
    this.dataDir = dataDir;
    this.now = options.now ?? (() => new Date().toISOString());
    this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
    this.lockPollMs = options.lockPollMs ?? 250;
    this.staleLockMs = options.staleLockMs ?? 60_000;
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
    this.host = options.host ?? hostname();
    this.onLockWait = options.onLockWait;
  }

  private normalizeAbbr(abbr: string): string {
    const upper = abbr.toUpperCase();
    if (!ABBR_PATTERN.test(upper)) {
      throw new HolyDeckError('invalid_translation', { abbr });
    }
    return upper;
  }

  translationPath(abbr: string): string {
    return join(this.dataDir, 'bibles', `${this.normalizeAbbr(abbr)}.json`);
  }

  private lockPath(abbr: string): string {
    return join(this.dataDir, 'bibles', `.${this.normalizeAbbr(abbr)}.lock`);
  }

  async load(abbr: string): Promise<TranslationStoreFile | undefined> {
    const path = this.translationPath(abbr);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new HolyDeckError('store_corrupt', { path, reason: (error as Error).message });
    }
    return validateStoreFile(raw, path);
  }

  async save(abbr: string, file: TranslationStoreFile): Promise<void> {
    const path = this.translationPath(abbr);
    await mkdir(dirname(path), { recursive: true });
    this.saveCounter += 1;
    const tmpPath = `${path}.${process.pid}.${this.saveCounter}.tmp`;
    file.updatedAt = this.now();
    await writeFile(tmpPath, JSON.stringify(file), 'utf8');
    await rename(tmpPath, path);
  }

  /**
   * True when the lock names a process on this machine that no longer exists — a run killed
   * before its release could run. Such a lock is reclaimed at once instead of after staleLockMs.
   * Anything unreadable, foreign or unparsable falls back to the mtime staleness check.
   */
  private async ownerIsGone(lockPath: string): Promise<boolean> {
    const owner = await readFile(lockPath, 'utf8').catch(() => undefined);
    const [host, pid] = owner?.trim().split(':') ?? [];
    if (host !== this.host || pid === undefined || !/^\d+$/.test(pid)) return false;
    return !this.isProcessAlive(Number(pid));
  }

  /** Describes the lock holder for the wait notice and the timeout error. */
  private async lockOwner(lockPath: string): Promise<string> {
    const owner = (await readFile(lockPath, 'utf8').catch(() => undefined))?.trim();
    if (owner === undefined || owner.length === 0) return 'another holydeck process';
    const [host, pid] = owner.split(':');
    if (pid === undefined) return `another holydeck process (${owner})`;
    return host === this.host ? `process ${pid}` : `process ${pid} on ${host}`;
  }

  async withLock<T>(abbr: string, fn: () => Promise<T>): Promise<T> {
    const lockPath = this.lockPath(abbr);
    await mkdir(dirname(lockPath), { recursive: true });
    const started = Date.now();
    const deadline = started + this.lockTimeoutMs;
    let announced = false;
    for (;;) {
      try {
        const handle = await open(lockPath, 'wx');
        await handle.writeFile(`${this.host}:${process.pid}`);
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await this.ownerIsGone(lockPath)) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        const lockStat = await stat(lockPath).catch(() => undefined);
        if (lockStat !== undefined && Date.now() - lockStat.mtimeMs > this.staleLockMs) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new HolyDeckError('store_locked', {
            abbr: abbr.toUpperCase(),
            path: lockPath,
            owner: await this.lockOwner(lockPath),
            waitedMs: Date.now() - started,
          });
        }
        if (!announced) {
          announced = true;
          this.onLockWait?.({ abbr: abbr.toUpperCase(), owner: await this.lockOwner(lockPath) });
        }
        await new Promise((resolve) => setTimeout(resolve, this.lockPollMs));
      }
    }
    const refresh = setInterval(() => {
      const now = new Date();
      utimes(lockPath, now, now).catch(() => undefined);
    }, this.staleLockMs / 3);
    refresh.unref();
    try {
      return await fn();
    } finally {
      clearInterval(refresh);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  putChapterInFile(
    file: TranslationStoreFile,
    book: string,
    chapter: string,
    verses: VerseMap,
    canonVerseCount: number,
  ): { changed: boolean; rev: number } {
    const bookRecord = (file.books[book] ??= { chapters: {} });
    const { record, changed, rev } = appendRevision(bookRecord.chapters[chapter], verses, canonVerseCount, this.now());
    bookRecord.chapters[chapter] = record;
    return { changed, rev };
  }

  async putChapter(
    abbr: string,
    book: string,
    chapter: string,
    verses: VerseMap,
    canonVerseCount: number,
  ): Promise<{ changed: boolean; rev: number }> {
    return this.withLock(abbr, async () => {
      const file = (await this.load(abbr)) ?? createEmptyStoreFile(abbr, this.now());
      const result = this.putChapterInFile(file, book, chapter, verses, canonVerseCount);
      await this.save(abbr, file);
      return result;
    });
  }

  async importFile(
    abbr: string,
    incoming: TranslationStoreFile,
  ): Promise<{ newChapters: number; addedRevisions: number }> {
    return this.withLock(abbr, async () => {
      const file = (await this.load(abbr)) ?? createEmptyStoreFile(abbr, this.now());
      let newChapters = 0;
      let addedRevisions = 0;
      for (const [bookUsfm, book] of Object.entries(incoming.books)) {
        const target = (file.books[bookUsfm] ??= { chapters: {} });
        for (const [chapterId, chapterRecord] of Object.entries(book.chapters)) {
          const existing = target.chapters[chapterId];
          if (existing === undefined) {
            target.chapters[chapterId] = chapterRecord;
            newChapters += 1;
            addedRevisions += chapterRecord.revisions.length;
            continue;
          }
          const knownHashes = new Set(existing.revisions.map((revision) => revision.contentHash));
          let record = existing;
          for (const revision of chapterRecord.revisions) {
            if (knownHashes.has(revision.contentHash)) continue;
            record = appendRevision(record, revision.verses, chapterRecord.canonVerseCount, revision.fetchedAt).record;
            knownHashes.add(revision.contentHash);
            addedRevisions += 1;
          }
          target.chapters[chapterId] = record;
        }
      }
      if (
        incoming.meta !== undefined &&
        incoming.meta.metadataBuild >= (file.meta?.metadataBuild ?? 0)
      ) {
        file.meta = incoming.meta;
        if (incoming.canon !== undefined) file.canon = incoming.canon;
      }
      await this.save(abbr, file);
      return { newChapters, addedRevisions };
    });
  }
}
