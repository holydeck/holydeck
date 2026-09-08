import { bundledCanon, findBook } from '@holydeck/core/canon';
import { HolyDeckError } from '@holydeck/core/messages';
import { findRevision, getChapter, latestRevision } from '@holydeck/core/storage';
import { translationId } from '@holydeck/core/translations';
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
  fetchOnMiss?: boolean;
}

export interface VersesResult {
  verses: Array<{ verse: number; text: string }>;
  citation: string;
  revision: number;
  fetchedAt: string;
  source: 'cache' | 'live';
  bookName: string;
}

export async function readVerses(store: MongoStore, fetcher: Fetcher, request: VersesRequest): Promise<VersesResult> {
  const abbr = request.abbr.toUpperCase();
  const book = request.book.toUpperCase();
  const chapter = String(request.chapter);
  const id = translationId(abbr);
  const file = await store.load(abbr);
  const canon = file?.canon ?? bundledCanon();
  let record = getChapter(file, book, chapter);
  let source: 'cache' | 'live' = 'cache';
  if (request.refresh || (request.fetchOnMiss === true && record === undefined)) {
    const fetched = await fetcher.fetchChapter(id, abbr, book, chapter);
    await store.putChapter(abbr, book, chapter, fetched.verses, fetched.canonVerseCount);
    record = getChapter(await store.load(abbr), book, chapter);
    source = 'live';
  }
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
