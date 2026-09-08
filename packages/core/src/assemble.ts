import { bundledCanon, findBook } from './canon.js';
import { HolyDeckError } from './messages.js';
import { formatVerseList } from './references.js';
import { findRevision, getChapter, latestRevision } from './storage.js';
import type { TranslationStoreFile } from './storage.js';
import type { SermonFile } from './sermon.js';
import type { EntryData, PassageData } from './template.js';

export interface AssembleOptions {
  revision?: Record<string, number>;
}

export function assembleEntries(
  sermon: SermonFile,
  storeFiles: Record<string, TranslationStoreFile | undefined>,
  options: AssembleOptions = {},
): EntryData[] {
  const fallbackCanon = bundledCanon();
  return sermon.entries.map((entry) => {
    const chapterId = String(entry.chapter);
    const verseList = formatVerseList(entry.verses);
    const passages: PassageData[] = sermon.translations.map((abbr) => {
      const file = storeFiles[abbr];
      if (file === undefined) {
        throw new HolyDeckError('chapter_not_in_store', { abbr, book: entry.book, chapter: chapterId });
      }
      const record = getChapter(file, entry.book, chapterId);
      if (record === undefined) {
        throw new HolyDeckError('chapter_not_in_store', { abbr, book: entry.book, chapter: chapterId });
      }
      const pinned = options.revision?.[abbr];
      const revision =
        pinned !== undefined
          ? findRevision(record, pinned, { abbr, book: entry.book, chapter: chapterId })
          : latestRevision(record);
      if (revision === undefined) {
        throw new HolyDeckError('chapter_not_in_store', { abbr, book: entry.book, chapter: chapterId });
      }
      const offset = entry.offsets[abbr] ?? 0;
      const texts = entry.verses.map((verse) => {
        const actual = verse + offset;
        const text = revision.verses[String(actual)];
        if (text === undefined) {
          throw new HolyDeckError('verse_not_in_store', {
            abbr,
            book: entry.book,
            chapter: chapterId,
            verse: actual,
            count: record.canonVerseCount,
          });
        }
        return text;
      });
      const bookName =
        findBook(file.canon ?? fallbackCanon, entry.book)?.name ??
        findBook(fallbackCanon, entry.book)?.name ??
        entry.book;
      return {
        translation: abbr,
        book: entry.book,
        bookName,
        chapter: entry.chapter,
        verses: verseList,
        text: texts.join(' '),
        citation: `${bookName} ${entry.chapter}:${verseList}`,
        revision: revision.rev,
        fetchedAt: revision.fetchedAt,
      };
    });
    return { reference: `${entry.book} ${entry.chapter}:${verseList}`, passages };
  });
}
