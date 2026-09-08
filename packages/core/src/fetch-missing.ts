import { getChapter } from './storage.js';
import { translationId } from './translations.js';
import type { Fetcher } from './fetcher.js';
import type { SermonFile } from './sermon.js';
import type { TranslationStoreFile, VerseMap } from './storage.js';

/** The slice of a datastore this needs: read a translation, write one chapter back. */
export interface ChapterStore {
  load(abbr: string): Promise<TranslationStoreFile | undefined>;
  putChapter(
    abbr: string,
    book: string,
    chapter: string,
    verses: VerseMap,
    canonVerseCount: number,
  ): Promise<{ changed: boolean; rev: number }>;
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
  const file = await store.load(upper);
  const refresh = options.refresh === true;
  const fetchMissing = options.fetchMissing !== false;
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
