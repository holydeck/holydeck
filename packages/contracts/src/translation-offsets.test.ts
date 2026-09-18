import { describe, expect, it } from 'vitest';

import { FIELD_CODES } from './problems.js';
import { parseTranslationOffsetEntry, parseTranslationOffsetList } from './translation-offsets.js';

import type { TranslationOffsetEntry } from './translation-offsets.js';

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  abbr: 'KJV',
  offset: 0,
  ...overrides,
});

const read = (value: unknown): TranslationOffsetEntry => {
  const parsed = parseTranslationOffsetEntry(value, 'translationOffset');
  if (!parsed.ok) throw new Error(parsed.problems.map((problem) => problem.path).join(', '));
  return parsed.value;
};

const codes = (value: unknown): string[] => {
  const parsed = parseTranslationOffsetEntry(value, 'translationOffset');
  expect(parsed.ok).toBe(false);
  return parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}=${problem.code}`);
};

describe('what one configured offset says', () => {
  it('reads back the translation and its offset', () => {
    expect(read(entry())).toEqual({ abbr: 'KJV', offset: 0 });
  });

  it('accepts a negative offset, a positive one, and zero alike', () => {
    expect(read(entry({ offset: -3 })).offset).toBe(-3);
    expect(read(entry({ offset: 5 })).offset).toBe(5);
    expect(read(entry({ offset: 0 })).offset).toBe(0);
  });

  it('refuses a translation abbreviation that is missing or blank', () => {
    expect(codes({ offset: 0 })).toEqual([`translationOffset.abbr=${FIELD_CODES.required}`]);
    expect(codes(entry({ abbr: '' }))).toEqual([`translationOffset.abbr=${FIELD_CODES.empty}`]);
  });

  it('refuses an offset that is not a whole number', () => {
    expect(codes(entry({ offset: 1.5 }))).toEqual([`translationOffset.offset=${FIELD_CODES.notAWholeNumber}`]);
    expect(codes(entry({ offset: 'one' }))).toEqual([`translationOffset.offset=${FIELD_CODES.notAWholeNumber}`]);
  });

  it('refuses an offset so far negative that no translation could still be in canon', () => {
    expect(codes(entry({ offset: -1_001 }))).toEqual([`translationOffset.offset=${FIELD_CODES.tooSmall}`]);
  });

  it('refuses something that is not an object at all', () => {
    expect(codes('KJV')).toEqual([`translationOffset=${FIELD_CODES.notAnObject}`]);
  });
});

describe('a list of configured offsets', () => {
  it('reads every entry, in the order they were sent', () => {
    const parsed = parseTranslationOffsetList({ offsets: [entry({ abbr: 'KJV' }), entry({ abbr: 'WEB', offset: 2 })] });
    expect(parsed).toEqual({ ok: true, value: [{ abbr: 'KJV', offset: 0 }, { abbr: 'WEB', offset: 2 }] });
  });

  it('reads an empty list as no offsets configured, not a missing field', () => {
    expect(parseTranslationOffsetList({ offsets: [] })).toEqual({ ok: true, value: [] });
  });

  it('surfaces a problem naming the offending item, without discarding the rest of the read', () => {
    const parsed = parseTranslationOffsetList({ offsets: [entry(), { abbr: 'WEB', offset: 'bad' }] });
    expect(parsed).toEqual({
      ok: false,
      problems: [{ path: 'translationOffsets.offsets.1.offset', code: FIELD_CODES.notAWholeNumber, message: 'must be a whole number' }],
    });
  });
});
