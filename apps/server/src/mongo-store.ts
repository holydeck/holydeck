import { HolyDeckError } from '@holydeck/core/messages';
import { appendRevision, createEmptyStoreFile, validateStoreFile } from '@holydeck/core/storage';
import type { TranslationStoreFile, VerseMap } from '@holydeck/core/storage';
import type { Collection, Db } from 'mongodb';

export interface MongoStoreOptions {
  now?: () => string;
  lockTimeoutMs?: number;
}

interface TranslationDoc extends TranslationStoreFile {
  _id: string;
}

function toStoreFile(doc: TranslationDoc): TranslationStoreFile {
  const raw: Record<string, unknown> = { ...doc };
  delete raw._id;
  return validateStoreFile(raw, `mongo:translations/${doc._id}`);
}

export class MongoStore {
  readonly now: () => string;
  private readonly db: Db;
  private readonly collection: Collection<TranslationDoc>;
  private readonly lockTimeoutMs: number;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(db: Db, options: MongoStoreOptions = {}) {
    this.db = db;
    this.collection = db.collection<TranslationDoc>('translations');
    this.now = options.now ?? (() => new Date().toISOString());
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
  }

  async ping(): Promise<boolean> {
    try {
      await this.db.command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async load(abbr: string): Promise<TranslationStoreFile | undefined> {
    const doc = await this.collection.findOne({ _id: abbr.toUpperCase() });
    if (doc === null) return undefined;
    return toStoreFile(doc);
  }

  async loadAll(): Promise<TranslationStoreFile[]> {
    const docs = await this.collection.find().sort({ _id: 1 }).toArray();
    return docs.map((doc) => toStoreFile(doc));
  }

  async save(abbr: string, file: TranslationStoreFile): Promise<void> {
    file.updatedAt = this.now();
    await this.collection.replaceOne({ _id: abbr.toUpperCase() }, file, { upsert: true });
  }

  async withLock<T>(abbr: string, fn: () => Promise<T>): Promise<T> {
    const upper = abbr.toUpperCase();
    const previous = this.locks.get(upper) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(upper, tail);
    void tail.then(() => {
      if (this.locks.get(upper) === tail) this.locks.delete(upper);
    });
    let timer!: NodeJS.Timeout;
    const acquired = await Promise.race([
      previous.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.lockTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (!acquired) {
      release();
      throw new HolyDeckError('store_locked', { abbr: upper, path: `memory:${upper}` });
    }
    try {
      return await fn();
    } finally {
      release();
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
    const upper = abbr.toUpperCase();
    return this.withLock(upper, async () => {
      const file = (await this.load(upper)) ?? createEmptyStoreFile(upper, this.now());
      const result = this.putChapterInFile(file, book, chapter, verses, canonVerseCount);
      await this.save(upper, file);
      return result;
    });
  }
}
