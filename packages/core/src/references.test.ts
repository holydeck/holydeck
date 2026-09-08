import { describe, expect, it } from 'vitest';
import { HolyDeckError } from './messages.js';
import { formatVerseList, parseReference, parseVerseList } from './references.js';

describe('parseVerseList', () => {
  it('parses singles, ranges and preserves order and duplicates', () => {
    expect(parseVerseList('5, 1-4,3')).toEqual([5, 1, 2, 3, 4, 3]);
  });

  it('accepts a bare number (YAML often delivers verses: 7 as a number)', () => {
    expect(parseVerseList(7)).toEqual([7]);
  });

  it.each(['', '  ', '1-', 'a', '3-1', '0', '1000', '1;3'])('rejects %j', (input) => {
    expect(() => parseVerseList(input)).toThrowError(HolyDeckError);
    try {
      parseVerseList(input);
    } catch (error) {
      expect((error as HolyDeckError).code).toBe('invalid_verse_list');
    }
  });
});

describe('formatVerseList', () => {
  it('collapses ascending runs and keeps explicit order', () => {
    expect(formatVerseList([5, 1, 2, 3, 4, 3])).toBe('5,1-4,3');
    expect(formatVerseList([1, 2])).toBe('1-2');
    expect(formatVerseList([24])).toBe('24');
    expect(formatVerseList([])).toBe('');
  });
});

describe('parseReference', () => {
  it('parses "PSA 118:24"', () => {
    expect(parseReference('PSA 118:24')).toEqual({ book: 'PSA', chapter: 118, verses: [24] });
  });

  it('parses numbered books and lowercases input', () => {
    expect(parseReference('1sa 3:1-4,9')).toEqual({ book: '1SA', chapter: 3, verses: [1, 2, 3, 4, 9] });
  });

  it.each([
    ['Genesis 1:5-7,9', { book: 'GEN', chapter: 1, verses: [5, 6, 7, 9] }],
    ['1. Mose 30:5', { book: 'GEN', chapter: 30, verses: [5] }],
    ['1st Corinthians 15:14', { book: '1CO', chapter: 15, verses: [14] }],
    ['psalm 118:24', { book: 'PSA', chapter: 118, verses: [24] }],
    ['சங்கீதம் 118:24', { book: 'PSA', chapter: 118, verses: [24] }],
  ])('parses the book name in %j', (input, expected) => {
    expect(parseReference(input)).toEqual(expected);
  });

  it('rejects a long run of spaces instead of backtracking over it', () => {
    // A book name is free text, so the split must stay linear; a backtracking parser would spend
    // seconds here and time the test out rather than throwing.
    expect(() => parseReference(`a${' '.repeat(50_000)}`)).toThrow(HolyDeckError);
  });

  it.each(['PSA118:24', 'PSA 118', 'Hallelujah 1:1', 'PSA 0:1', 'PSA 1:x'])('rejects %j', (input) => {
    try {
      parseReference(input);
      expect.unreachable();
    } catch (error) {
      expect((error as HolyDeckError).code).toBe('invalid_reference');
    }
  });
});
