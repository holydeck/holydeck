import { HolyDeckError } from './messages.js';
import { createEmptyStoreFile } from './storage.js';
import { translationId } from './translations.js';
import type { Canon } from './canon.js';
import type { Fetcher } from './fetcher.js';
import type { TranslationStoreFile, VerseMap } from './storage.js';

export interface SyncStore {
  now: () => string;
  load(abbr: string): Promise<TranslationStoreFile | undefined>;
  save(abbr: string, file: TranslationStoreFile): Promise<void>;
  withLock<T>(abbr: string, fn: () => Promise<T>): Promise<T>;
  putChapterInFile(
    file: TranslationStoreFile,
    book: string,
    chapter: string,
    verses: VerseMap,
    canonVerseCount: number,
  ): { changed: boolean; rev: number };
}

export interface SyncPlanItem {
  book: string;
  chapter: string;
  reason: 'missing' | 'refresh';
}

export interface SyncReport {
  translation: string;
  planned: number;
  fetched: number;
  unchanged: number;
  newRevisions: Array<{ book: string; chapter: string; rev: number }>;
  failed: Array<{ book: string; chapter: string; code: string }>;
  metadataBuildChanged?: { from: number; to: number };
  dryRun: boolean;
  plan?: SyncPlanItem[];
  /** Set when the run stopped early on the caller's signal; what was fetched is still saved. */
  aborted?: boolean;
}

export interface SyncOptions {
  refresh?: boolean;
  dryRun?: boolean;
  concurrency?: number;
  delayMs?: number;
  onProgress?: (done: number, total: number, item: SyncPlanItem) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Stops the run at the next chapter boundary, so the store is saved and the lock released. */
  signal?: AbortSignal;
}

export function planSync(canon: Canon, file: TranslationStoreFile | undefined, refresh: boolean): SyncPlanItem[] {
  const plan: SyncPlanItem[] = [];
  for (const book of canon.books) {
    for (const chapter of book.chapters) {
      const exists = file?.books[book.usfm]?.chapters[chapter.id] !== undefined;
      if (!exists) plan.push({ book: book.usfm, chapter: chapter.id, reason: 'missing' });
      else if (refresh) plan.push({ book: book.usfm, chapter: chapter.id, reason: 'refresh' });
    }
  }
  return plan;
}

export async function syncTranslation(
  store: SyncStore,
  fetcher: Fetcher,
  abbr: string,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const upper = abbr.toUpperCase();
  const id = translationId(upper);
  const refresh = options.refresh ?? false;
  const dryRun = options.dryRun ?? false;
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const delayMs = options.delayMs ?? 1000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  return store.withLock(upper, async () => {
    const file = (await store.load(upper)) ?? createEmptyStoreFile(upper, store.now());
    const report: SyncReport = {
      translation: upper,
      planned: 0,
      fetched: 0,
      unchanged: 0,
      newRevisions: [],
      failed: [],
      dryRun,
    };

    let canon: Canon;
    if (!dryRun || file.canon == null) {
      const { meta, canon: fetchedCanon } = await fetcher.fetchVersionMeta(id);
      const previousBuild = file.meta?.metadataBuild;
      if (previousBuild !== undefined && previousBuild !== meta.metadataBuild) {
        report.metadataBuildChanged = { from: previousBuild, to: meta.metadataBuild };
      }
      file.meta = meta;
      file.canon = fetchedCanon;
      canon = fetchedCanon;
    } else {
      canon = file.canon;
    }
    const plan = planSync(canon, file, refresh);
    report.planned = plan.length;

    if (dryRun) {
      report.plan = plan;
      return report;
    }

    await store.save(upper, file); // persist refreshed metadata before the long fetch phase

    let nextIndex = 0;
    let processed = 0;
    let sinceSave = 0;
    let blocked = false;
    let firstFetchDone = false;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (blocked || options.signal?.aborted === true || nextIndex >= plan.length) return;
        const item = plan[nextIndex]!;
        nextIndex += 1;
        if (firstFetchDone && delayMs > 0) await sleep(delayMs);
        firstFetchDone = true;
        try {
          const { verses, canonVerseCount } = await fetcher.fetchChapter(id, upper, item.book, item.chapter);
          const { changed, rev } = store.putChapterInFile(file, item.book, item.chapter, verses, canonVerseCount);
          report.fetched += 1;
          if (changed) report.newRevisions.push({ book: item.book, chapter: item.chapter, rev });
          else report.unchanged += 1;
        } catch (error) {
          if (!(error instanceof HolyDeckError)) throw error;
          report.failed.push({ book: item.book, chapter: item.chapter, code: error.code });
          if (error.code === 'scrape_blocked') blocked = true;
        }
        processed += 1;
        sinceSave += 1;
        options.onProgress?.(processed, plan.length, item);
        if (sinceSave >= 10) {
          sinceSave = 0;
          await store.save(upper, file);
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    await store.save(upper, file);
    if (options.signal?.aborted === true) report.aborted = true;
    return report;
  });
}
