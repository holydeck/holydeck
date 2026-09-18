import { describe, expect, it } from 'vitest';
import { appendRevision, createEmptyStoreFile } from './storage.js';
import { searchTranslation } from './search.js';
import type { TranslationStoreFile, VerseMap } from './storage.js';

interface Chapter {
  book: string;
  chapter: string;
  verses: VerseMap;
}

/** A store file written the way a sync writes one: a chapter at a time, each appending its revision. */
function fileOf(...chapters: Chapter[]): TranslationStoreFile {
  const file = createEmptyStoreFile('KJV', '2026-09-16T10:00:00.000Z');
  for (const entry of chapters) {
    const book = (file.books[entry.book] ??= { chapters: {} });
    const count = Object.keys(entry.verses).length;
    book.chapters[entry.chapter] = appendRevision(book.chapters[entry.chapter], entry.verses, count, 't').record;
  }
  return file;
}

const genesis = {
  book: 'GEN',
  chapter: '1',
  verses: {
    '1': 'In the beginning God created the heaven and the earth.',
    '2': 'And the earth was without form, and void; and darkness was upon the face of the deep.',
    '3': 'And God said, Let there be light: and there was light.',
  },
};

describe('searching the text a translation already holds', () => {
  it('finds a word however either side spelled its case', () => {
    const hits = searchTranslation(fileOf(genesis), 'GOD');
    expect(hits.map((hit) => hit.verse)).toEqual([1, 3]);
    expect(hits[0]).toEqual({
      book: 'GEN',
      bookOrder: 0,
      chapter: 1,
      verse: 1,
      text: genesis.verses['1'],
      revision: 1,
      phrase: true,
      occurrences: 1,
    });
  });

  it('finds a whole word only, never the middle of a longer one', () => {
    const file = fileOf({ book: 'GEN', chapter: '1', verses: { '1': 'The ungodly are not so, but godly.' } });
    expect(searchTranslation(file, 'god')).toEqual([]);
    expect(searchTranslation(file, 'godly').map((hit) => hit.verse)).toEqual([1]);
  });

  it('finds a phrase across the punctuation written between its words', () => {
    const hits = searchTranslation(fileOf(genesis), 'let there be light');
    expect(hits.map((hit) => hit.verse)).toEqual([3]);
    expect(hits[0]?.phrase).toBe(true);
  });

  it('finds a verse holding every word of the query apart, and says it was not the phrase', () => {
    const hits = searchTranslation(fileOf(genesis), 'light God');
    expect(hits.map((hit) => [hit.verse, hit.phrase, hit.occurrences])).toEqual([[3, false, 3]]);
  });

  it('finds nothing when one word of the query is missing, however common the others are', () => {
    expect(searchTranslation(fileOf(genesis), 'God kindled')).toEqual([]);
  });

  it('finds nothing for a query that names no word at all', () => {
    for (const query of ['', '   ', '-- ,;']) expect(searchTranslation(fileOf(genesis), query)).toEqual([]);
  });

  it('reads the latest revision of a chapter, and never the text it replaced', () => {
    const file = fileOf(
      { book: 'GEN', chapter: '1', verses: { '1': 'In the beginning God created the heaven.' } },
      { book: 'GEN', chapter: '1', verses: { '1': 'In the beginning God made the heavens.' } },
    );
    const hits = searchTranslation(file, 'created');
    expect(hits).toEqual([]);
    expect(searchTranslation(file, 'made').map((hit) => hit.revision)).toEqual([2]);
  });

  it('passes over a chapter nothing has been stored in yet', () => {
    const file = fileOf(genesis);
    file.books.GEN = { chapters: { ...file.books.GEN?.chapters, '2': { canonVerseCount: 25, revisions: [] } } };
    expect(searchTranslation(file, 'God').map((hit) => hit.chapter)).toEqual([1, 1]);
  });

  it('passes over a chapter or verse that names no reference anything could be opened at', () => {
    const file = fileOf({ book: 'GEN', chapter: 'intro', verses: { '1': 'God is light.' } }, genesis);
    const revision = file.books.GEN?.chapters['1']?.revisions[0];
    if (revision !== undefined) revision.verses['title'] = 'God of the beginning';
    expect(searchTranslation(file, 'God').map((hit) => [hit.chapter, hit.verse])).toEqual([[1, 1], [1, 3]]);
  });
});

describe('the order the hits come back in', () => {
  const psalm = { book: 'PSA', chapter: '117', verses: { '1': 'Praise the LORD, all ye nations: praise him.' } };
  const john = { book: 'JHN', chapter: '1', verses: { '1': 'In the beginning was the Word.' } };

  it('is the same whichever order the books, chapters and verses were stored in', () => {
    const forwards = searchTranslation(fileOf(genesis, psalm, john), 'the');
    const backwards = searchTranslation(fileOf(john, psalm, genesis), 'the');
    expect(backwards).toEqual(forwards);
    // Three "the"s in each of the two Genesis verses, two in John, one in the psalm: the count decides
    // the order, and where the count ties, the canon does — never which book was written to the store.
    expect(forwards.map((hit) => `${hit.book} ${hit.chapter}:${hit.verse}`)).toEqual([
      'GEN 1:1',
      'GEN 1:2',
      'JHN 1:1',
      'PSA 117:1',
    ]);
  });

  it('reads a book chapter by chapter, and a chapter verse by verse', () => {
    const file = fileOf(
      { book: 'GEN', chapter: '2', verses: { '3': 'God rested.', '1': 'God finished the heavens.' } },
      { book: 'GEN', chapter: '1', verses: { '1': 'God created.' } },
    );
    expect(searchTranslation(file, 'God').map((hit) => `${hit.chapter}:${hit.verse}`)).toEqual(['1:1', '2:1', '2:3']);
  });

  it('puts the phrase itself above a verse that only scatters its words', () => {
    const file = fileOf(
      { book: 'GEN', chapter: '1', verses: { '1': 'The light shone, and the word of truth was heard.' } },
      { book: 'JHN', chapter: '1', verses: { '1': 'The word of light.' } },
    );
    const hits = searchTranslation(file, 'word of light');
    expect(hits.map((hit) => [hit.book, hit.phrase])).toEqual([['JHN', true], ['GEN', false]]);
  });

  it('puts a book the canon does not name after every book it does, by name', () => {
    const file = fileOf(
      { book: 'ZZZ', chapter: '1', verses: { '1': 'God of the unknown book.' } },
      { book: 'AAA', chapter: '1', verses: { '1': 'God of the other unknown book.' } },
      { book: 'REV', chapter: '1', verses: { '1': 'God of the last named book.' } },
    );
    expect(searchTranslation(file, 'God').map((hit) => hit.book)).toEqual(['REV', 'AAA', 'ZZZ']);
  });
});
