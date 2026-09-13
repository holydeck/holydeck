import { bundledCanon, findBook } from '@holydeck/core/canon';
import { ensureChapters } from '@holydeck/core/fetch-missing';
import { HolyDeckError } from '@holydeck/core/messages';
import { findRevision, getChapter, latestRevision } from '@holydeck/core/storage';
import { formatVerseList } from '@holydeck/core/references';
import type { Fetcher } from '@holydeck/core/fetcher';
import type { MongoStore } from './mongo-store.js';

export interface VersesRequest {
  abbr: string;
  book: string;
  chapter: number;
  verses: number[];
  refresh: boolean;
  revision?: number;
  /** Fetch the chapter when the datastore lacks it. On by default; off answers with an error. */
  fetchMissing?: boolean;
}

export interface VersesResult {
  verses: Array<{ verse: number; text: string }>;
  citation: string;
  revision: number;
  fetchedAt: string;
  source: 'cache' | 'live';
  bookName: string;
}

export async function readVerses(
  store: MongoStore,
  fetcher: Fetcher,
  request: VersesRequest,
  onCanonUnavailable?: (reason: string) => void,
): Promise<VersesResult> {
  const abbr = request.abbr.toUpperCase();
  const book = request.book.toUpperCase();
  const chapter = String(request.chapter);
  const { file, fetched } = await ensureChapters(store, fetcher, abbr, [{ book, chapter }], {
    refresh: request.refresh,
    fetchMissing: request.fetchMissing,
    onCanonUnavailable,
  });
  const canon = file?.canon ?? bundledCanon();
  const record = getChapter(file, book, chapter);
  const source: 'cache' | 'live' = fetched.length > 0 ? 'live' : 'cache';
  if (record === undefined) {
    throw new HolyDeckError('chapter_not_in_store', { abbr, book, chapter });
  }
  const chapterRecord = record;
  const chosen =
    request.revision === undefined
      ? latestRevision(chapterRecord)
      : findRevision(chapterRecord, request.revision, { abbr, book, chapter });
  if (chosen === undefined) {
    throw new HolyDeckError('chapter_not_in_store', { abbr, book, chapter });
  }
  const verses = request.verses.map((verse) => {
    const text = chosen.verses[String(verse)];
    if (text === undefined) {
      throw new HolyDeckError('verse_not_in_store', {
        abbr,
        book,
        chapter,
        verse,
        count: chapterRecord.canonVerseCount,
      });
    }
    return { verse, text };
  });
  const bookName = findBook(canon, book)?.name ?? findBook(bundledCanon(), book)?.name ?? book;
  return {
    verses,
    citation: `${bookName} ${request.chapter}:${formatVerseList(request.verses)}`,
    revision: chosen.rev,
    fetchedAt: chosen.fetchedAt,
    source,
    bookName,
  };
}
