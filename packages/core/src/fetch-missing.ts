import { getChapter } from './storage.js';
import { findTranslationId, translationId } from './translations.js';
import type { Canon, TranslationMeta } from './canon.js';
import type { Fetcher } from './fetcher.js';
import type { SermonFile } from './sermon.js';
import type { TranslationStoreFile, VerseMap } from './storage.js';

/** The slice of a datastore this needs: read a translation, write a chapter or its canon back. */
export interface ChapterStore {
  load(abbr: string): Promise<TranslationStoreFile | undefined>;
  putChapter(
    abbr: string,
    book: string,
    chapter: string,
    verses: VerseMap,
    canonVerseCount: number,
  ): Promise<{ changed: boolean; rev: number }>;
  putVersionMeta(abbr: string, meta: TranslationMeta, canon: Canon): Promise<void>;
}

export interface ChapterRef {
  book: string;
  chapter: string;
}

export interface EnsureChaptersOptions {
  /** Fetch every listed chapter, stored or not. */
  refresh?: boolean;
  /** Fetch chapters the datastore does not have yet. On by default; off leaves them missing. */
  fetchMissing?: boolean;
  /** Called before each fetch, so a caller can say which chapter it is waiting on. */
  onFetching?: (ref: ChapterRef, done: number, total: number) => void;
  /** Called when the translation's own book names stayed out of reach, so English ones are used. */
  onCanonUnavailable?: (reason: string) => void;
}

export interface EnsureChaptersResult {
  /** The translation as stored once any fetches are done; undefined if it has nothing at all. */
  file: TranslationStoreFile | undefined;
  fetched: Array<ChapterRef & { changed: boolean; rev: number }>;
}

/** The distinct chapters a sermon needs, in the order they are first referenced. */
export function chapterRefs(sermon: SermonFile): ChapterRef[] {
  const seen = new Set<string>();
  const refs: ChapterRef[] = [];
  for (const entry of sermon.entries) {
    const ref = { book: entry.book, chapter: String(entry.chapter) };
    const key = `${ref.book}.${ref.chapter}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/**
 * Puts the chapters a render needs into the datastore before it is read, so a passage nobody has
 * synced yet still resolves. Shared by both shells: what the CLI renders locally and what the
 * server answers come from the same rule.
 */
export async function ensureChapters(
  store: ChapterStore,
  fetcher: Fetcher,
  abbr: string,
  refs: ChapterRef[],
  options: EnsureChaptersOptions = {},
): Promise<EnsureChaptersResult> {
  const upper = abbr.toUpperCase();
  let file = await store.load(upper);
  const refresh = options.refresh === true;
  const fetchMissing = options.fetchMissing !== false;
  // A chapter carries no book names, so a translation whose canon was never stored renders its
  // citations in the bundled canon's English. One version request buys the names it uses itself —
  // asked before the chapters, and asked of any store that still lacks them, so one synced before
  // this existed, or imported without a canon, repairs itself on the first run allowed to fetch.
  // A translation bible.com has no id for is skipped: only its own store can name its books.
  const versionId = findTranslationId(upper);
  if (file?.canon === undefined && versionId !== undefined && (refresh || fetchMissing)) {
    try {
      const { meta, canon } = await fetcher.fetchVersionMeta(versionId);
      await store.putVersionMeta(upper, meta, canon);
      file = await store.load(upper);
    } catch (error) {
      // Book names are cosmetic; no render that has its verses may fail over the word "Genesis".
      options.onCanonUnavailable?.((error as Error).message);
    }
  }
  const wanted = refs.filter(
    (ref) => refresh || (fetchMissing && getChapter(file, ref.book, ref.chapter) === undefined),
  );
  if (wanted.length === 0) return { file, fetched: [] };
  const id = translationId(upper);
  const fetched: EnsureChaptersResult['fetched'] = [];
  for (const [index, ref] of wanted.entries()) {
    options.onFetching?.(ref, index + 1, wanted.length);
    const parsed = await fetcher.fetchChapter(id, upper, ref.book, ref.chapter);
    const result = await store.putChapter(upper, ref.book, ref.chapter, parsed.verses, parsed.canonVerseCount);
    fetched.push({ ...ref, ...result });
  }
  return { file: await store.load(upper), fetched };
}
