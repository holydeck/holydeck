import { describe, expect, it } from 'vitest';
import { assembleEntries } from './assemble.js';
import { appendRevision, createEmptyStoreFile } from './storage.js';
import type { TranslationStoreFile } from './storage.js';
import type { SermonFile } from './sermon.js';

function storeWith(
  translation: string,
  chapters: Array<{ book: string; chapter: string; verses: Record<string, string>; revisions?: Array<Record<string, string>> }>,
): TranslationStoreFile {
  const file = createEmptyStoreFile(translation, 't0');
  for (const entry of chapters) {
    const all = [entry.verses, ...(entry.revisions ?? [])];
    let record;
    for (const [index, verses] of all.entries()) {
      record = appendRevision(record, verses, Object.keys(verses).length, `t${index + 1}`).record;
    }
    const book = (file.books[entry.book] ??= { chapters: {} });
    book.chapters[entry.chapter] = record!;
  }
  return file;
}

function sermonWith(overrides: Partial<SermonFile> = {}): SermonFile {
  return {
    translations: ['KJV'],
    entries: [{ book: 'PSA', chapter: 117, verses: [1, 2], offsets: {} }],
    notices: [],
    ...overrides,
  };
}

const kjv = storeWith('KJV', [{ book: 'PSA', chapter: '117', verses: { '1': 'O praise.', '2': 'For his kindness.' } }]);

describe('assembleEntries', () => {
  it('assembles a passage from the latest revision with citation and reference', () => {
    const entries = assembleEntries(sermonWith(), { KJV: kjv });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reference).toBe('PSA 117:1-2');
    const passage = entries[0]?.passages[0];
    expect(passage?.translation).toBe('KJV');
    expect(passage?.text).toBe('O praise. For his kindness.');
    expect(passage?.citation).toBe('Psalms 117:1-2'); // bundled-canon fallback name (store has no canon)
    expect(passage?.revision).toBe(1);
    expect(passage?.fetchedAt).toBe('t1');
  });

  it('uses the localized book name from the stored canon when present', () => {
    const withCanon = structuredClone(kjv);
    withCanon.canon = {
      books: [{ usfm: 'PSA', canon: 'ot', name: 'Die Psalmen', chapters: [{ id: '117', label: '117' }] }],
    };
    const entries = assembleEntries(sermonWith(), { KJV: withCanon });
    expect(entries[0]?.passages[0]?.citation).toBe('Die Psalmen 117:1-2');
  });

  it('applies numeric verse offsets to lookup but not to the citation', () => {
    const offsetStore = storeWith('NR06', [
      { book: 'PSA', chapter: '117', verses: { '2': 'versetto uno', '3': 'versetto due' } },
    ]);
    const sermon = sermonWith({
      translations: ['NR06'],
      entries: [{ book: 'PSA', chapter: 117, verses: [1, 2], offsets: { NR06: 1 } }],
    });
    const entries = assembleEntries(sermon, { NR06: offsetStore });
    expect(entries[0]?.passages[0]?.text).toBe('versetto uno versetto due');
    expect(entries[0]?.passages[0]?.citation).toBe('Psalms 117:1-2');
  });

  it('pins a specific revision when requested', () => {
    const twoRevs = storeWith('KJV', [
      { book: 'PSA', chapter: '117', verses: { '1': 'old text', '2': 'old two' }, revisions: [{ '1': 'new text', '2': 'new two' }] },
    ]);
    const latest = assembleEntries(sermonWith(), { KJV: twoRevs });
    expect(latest[0]?.passages[0]?.text).toBe('new text new two');
    const pinned = assembleEntries(sermonWith(), { KJV: twoRevs }, { revision: { KJV: 1 } });
    expect(pinned[0]?.passages[0]?.text).toBe('old text old two');
    expect(pinned[0]?.passages[0]?.revision).toBe(1);
  });

  it('throws revision_not_found for a bad pin', () => {
    expect(() => assembleEntries(sermonWith(), { KJV: kjv }, { revision: { KJV: 9 } })).toThrowError(
      expect.objectContaining({ code: 'revision_not_found' }),
    );
  });

  it('throws chapter_not_in_store when the store file or chapter is missing', () => {
    expect(() => assembleEntries(sermonWith(), {})).toThrowError(
      expect.objectContaining({ code: 'chapter_not_in_store', params: expect.objectContaining({ abbr: 'KJV', book: 'PSA' }) }),
    );
    const wrongChapter = sermonWith({ entries: [{ book: 'PSA', chapter: 118, verses: [1], offsets: {} }] });
    expect(() => assembleEntries(wrongChapter, { KJV: kjv })).toThrowError(
      expect.objectContaining({ code: 'chapter_not_in_store' }),
    );
  });

  it('throws chapter_not_in_store when the stored record has zero revisions', () => {
    const empty = createEmptyStoreFile('KJV', 't0');
    empty.books['PSA'] = { chapters: { '117': { canonVerseCount: 2, revisions: [] } } };
    expect(() => assembleEntries(sermonWith(), { KJV: empty })).toThrowError(
      expect.objectContaining({ code: 'chapter_not_in_store' }),
    );
  });

  it('throws verse_not_in_store naming the shifted verse', () => {
    const sermon = sermonWith({ entries: [{ book: 'PSA', chapter: 117, verses: [3], offsets: {} }] });
    expect(() => assembleEntries(sermon, { KJV: kjv })).toThrowError(
      expect.objectContaining({ code: 'verse_not_in_store', params: expect.objectContaining({ verse: 3, count: 2 }) }),
    );
  });

  it('emits one passage per translation in sermon order', () => {
    const second = storeWith('NIV', [{ book: 'PSA', chapter: '117', verses: { '1': 'Praise!', '2': 'Great love.' } }]);
    const sermon = sermonWith({ translations: ['KJV', 'NIV'] });
    const entries = assembleEntries(sermon, { KJV: kjv, NIV: second });
    expect(entries[0]?.passages.map((passage) => passage.translation)).toEqual(['KJV', 'NIV']);
  });

  it('falls back to the bundled canon name when the stored canon lacks the book', () => {
    const store = storeWith('KJV', [{ book: 'GEN', chapter: '1', verses: { '1': 'In the beginning.' } }]);
    store.canon = {
      books: [{ usfm: 'PSA', canon: 'ot', name: 'Die Psalmen', chapters: [{ id: '117', label: '117' }] }],
    };
    const sermon = sermonWith({ entries: [{ book: 'GEN', chapter: 1, verses: [1], offsets: {} }] });
    const entries = assembleEntries(sermon, { KJV: store });
    expect(entries[0]?.passages[0]?.bookName).toBe('Genesis');
  });

  it('falls back to the raw USFM code when the book is in neither canon', () => {
    const store = storeWith('KJV', [{ book: 'TOB', chapter: '1', verses: { '1': 'Text.' } }]);
    const sermon = sermonWith({ entries: [{ book: 'TOB', chapter: 1, verses: [1], offsets: {} }] });
    const entries = assembleEntries(sermon, { KJV: store });
    expect(entries[0]?.passages[0]?.bookName).toBe('TOB');
  });
});
