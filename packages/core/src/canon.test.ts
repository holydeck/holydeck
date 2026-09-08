import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HolyDeckError } from './messages.js';
import { bundledCanon, findBook, parseVersionMeta, resolveBook } from './canon.js';
import { BOOK_ALIASES } from './internal/book-aliases.js';

const kjvPayload: unknown = JSON.parse(
  readFileSync(new URL('../test/fixtures/version-1-kjv.json', import.meta.url), 'utf8'),
);

describe('parseVersionMeta', () => {
  const { meta, canon } = parseVersionMeta(kjvPayload);

  it('extracts identity and language', () => {
    expect(meta.id).toBe(1);
    expect(meta.abbreviation).toBe('KJV');
    expect(meta.localAbbreviation).toBe('KJV');
    expect(meta.title).toBe('King James Version');
    expect(meta.language).toEqual({
      iso6391: 'en',
      iso6393: 'eng',
      name: 'English',
      localName: 'English',
      textDirection: 'ltr',
      languageTag: 'eng',
    });
  });

  it('extracts copyright, publisher, metadata build and versification', () => {
    expect(meta.copyrightShort?.text).toContain('Crown');
    expect(meta.copyrightLong?.html).toContain('<p>');
    expect(meta.publisher).toEqual({ id: 826, name: 'Cambridge Univ. Press & BFBS', url: 'http://www.biblesociety.org.uk/' });
    expect(meta.metadataBuild).toBe(51);
    expect(meta.versification).toBe('eng');
  });

  it('extracts the full 66-book canon with localized names and chapter labels', () => {
    expect(canon.books).toHaveLength(66);
    const psalms = findBook(canon, 'PSA');
    expect(psalms?.name).toBe('Psalm');
    expect(psalms?.longName).toBe('The Book of Psalms');
    expect(psalms?.abbreviation).toBe('Ps');
    expect(psalms?.canon).toBe('ot');
    expect(psalms?.chapters).toHaveLength(150);
    expect(psalms?.chapters[116]).toEqual({ id: '117', label: '117' });
    const total = canon.books.reduce((sum, book) => sum + book.chapters.length, 0);
    expect(total).toBe(1189);
  });

  it.each([null, 42, {}, { id: 1, abbreviation: 'X' }])('rejects payload %j', (payload) => {
    try {
      parseVersionMeta(payload);
      expect.unreachable();
    } catch (error) {
      expect((error as HolyDeckError).code).toBe('version_meta_invalid');
    }
  });

  it('rejects a payload whose books all have text=false', () => {
    try {
      parseVersionMeta({ id: 9, abbreviation: 'X', books: [{ usfm: 'GEN', text: false, chapters: [] }] });
      expect.unreachable();
    } catch (error) {
      expect((error as HolyDeckError).code).toBe('version_meta_invalid');
    }
  });

  it('skips non-canonical chapters and malformed entries instead of failing', () => {
    const { canon: parsed } = parseVersionMeta({
      id: 9,
      abbreviation: 'X',
      books: [
        {
          usfm: 'GEN',
          human: 'Genesis',
          chapters: [
            { usfm: 'GEN.INTRO', human: 'Intro', canonical: false },
            { usfm: 'GEN.1', human: '1', canonical: true },
            'garbage',
            { human: 'no usfm', canonical: true },
          ],
        },
        'garbage-book',
        { human: 'no usfm book', chapters: [] },
      ],
    });
    expect(parsed.books).toHaveLength(1);
    expect(parsed.books[0]?.chapters).toEqual([{ id: '1', label: '1' }]);
  });

  it('defaults a missing chapters array to empty, drops empty chapter ids, and falls back the label to the id', () => {
    const { canon: parsed } = parseVersionMeta({
      id: 9,
      abbreviation: 'X',
      books: [
        { usfm: 'EXO' },
        {
          usfm: 'LEV',
          chapters: [
            { usfm: 'LEV.', canonical: true },
            { usfm: 'LEV.2', canonical: true },
          ],
        },
      ],
    });
    expect(findBook(parsed, 'EXO')?.chapters).toEqual([]);
    expect(findBook(parsed, 'LEV')?.chapters).toEqual([{ id: '2', label: '2' }]);
  });
});

describe('bundledCanon', () => {
  it('matches the KJV fixture book-for-book in usfm order and chapter counts', () => {
    const bundled = bundledCanon();
    const { canon } = parseVersionMeta(kjvPayload);
    expect(bundled.books.map((book) => book.usfm)).toEqual(canon.books.map((book) => book.usfm));
    for (const book of bundled.books) {
      expect(book.chapters.length, book.usfm).toBe(findBook(canon, book.usfm)?.chapters.length);
    }
  });

  it('findBook returns undefined for unknown books', () => {
    expect(findBook(bundledCanon(), 'ZZZ')).toBeUndefined();
  });
});

describe('resolveBook', () => {
  it('passes USFM codes through, known or not', () => {
    expect(resolveBook('gen')).toBe('GEN');
    expect(resolveBook(' 1sa ')).toBe('1SA');
    expect(resolveBook('ZZZ')).toBe('ZZZ');
  });

  it('resolves the canon name of every bundled book', () => {
    for (const book of bundledCanon().books) {
      expect(resolveBook(book.name), book.name).toBe(book.usfm);
    }
  });

  it('resolves every name in the alias table, with no book stealing another book name', () => {
    for (const [usfm, ...names] of BOOK_ALIASES) {
      for (const name of names) expect(resolveBook(name), name).toBe(usfm);
    }
  });

  it('reads a leading ordinal in any form', () => {
    for (const input of ['2 Samuel', '2nd Samuel', '2. Samuel', 'II Samuel', 'Second Samuel', 'ii samuel']) {
      expect(resolveBook(input), input).toBe('2SA');
    }
  });

  it('accepts German names with or without their accents', () => {
    expect(resolveBook('Römer')).toBe('ROM');
    expect(resolveBook('romer')).toBe('ROM');
    expect(resolveBook('Sprüche')).toBe('PRO');
  });

  it('keeps Tamil vowel signs, so numbered books stay distinct', () => {
    expect(resolveBook('யோவான்')).toBe('JHN');
    expect(resolveBook('1 யோவான்')).toBe('1JN');
    expect(resolveBook('சகரியா')).toBe('ZEC');
  });

  it('returns undefined for a name it does not know', () => {
    expect(resolveBook('Hezekiah')).toBeUndefined();
    expect(resolveBook('...')).toBeUndefined();
  });
});
