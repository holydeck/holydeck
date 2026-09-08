import { describe, expect, it } from 'vitest';
import { HolyDeckError } from './messages.js';
import { parseSermonFile } from './sermon.js';

describe('parseSermonFile (modern format)', () => {
  it('parses translations, template and entries with offsets', () => {
    const sermon = parseSermonFile(
      [
        'translations: [sch2000, TAOVBSI]',
        'template: "{{ x }}"',
        'verses:',
        '  - book: psa',
        '    chapter: 4',
        '    verses: 2-6',
        '    offsets:',
        '      sch2000: 1',
        '  - book: JHN',
        '    chapter: 3',
        '    verses: 16',
      ].join('\n'),
    );
    expect(sermon.translations).toEqual(['SCH2000', 'TAOVBSI']);
    expect(sermon.template).toBe('{{ x }}');
    expect(sermon.entries).toEqual([
      { book: 'PSA', chapter: 4, verses: [2, 3, 4, 5, 6], offsets: { SCH2000: 1 } },
      { book: 'JHN', chapter: 3, verses: [16], offsets: {} },
    ]);
    expect(sermon.notices).toEqual([]);
  });

  it.each([
    ['not yaml: [', 'not valid YAML'],
    ['- just\n- a list', 'top level'],
    ['translations: []\nverses: [{book: PSA, chapter: 1, verses: 1}]', 'translations'],
    ['translations: [KJV, 7]\nverses: [{book: PSA, chapter: 1, verses: 1}]', 'translations[1]'],
    ['translations: [KJV]\ntemplate: 9\nverses: [{book: PSA, chapter: 1, verses: 1}]', 'template'],
    ['translations: [KJV]\nverses: []', 'verses'],
    ['translations: [KJV]\nverses: [7]', 'verses[0]'],
    ['translations: [KJV]\nverses: [{book: PSALM, chapter: 1, verses: 1}]', 'book'],
    ['translations: [KJV]\nverses: [{book: PSA, chapter: 0, verses: 1}]', 'chapter'],
    ['translations: [KJV]\nverses: [{book: PSA, chapter: 1}]', 'verses'],
    ['translations: [KJV]\nverses: [{book: PSA, chapter: 1, verses: [1]}]', 'verses'],
    ['translations: [KJV]\nverses: [{book: PSA, chapter: 1, verses: "x"}]', 'not a valid verse list'],
    ['translations: [KJV]\nverses: [{book: PSA, chapter: 1, verses: 1, offsets: 7}]', 'offsets'],
    ['translations: [KJV]\nverses: [{book: PSA, chapter: 1, verses: 1, offsets: {KJV: x}}]', 'integer'],
    ['translations: [KJV]\nverses: [{book: PSA, chapter: 1, verses: 1, offsets: {SCH2000: 1}}]', 'not in "translations"'],
  ])('rejects %j mentioning %j', (text, fragment) => {
    try {
      parseSermonFile(text);
      expect.unreachable();
    } catch (error) {
      expect((error as HolyDeckError).code).toBe('sermon_invalid');
      expect((error as HolyDeckError).message).toContain(fragment);
    }
  });
});

describe('parseSermonFile (legacy format)', () => {
  it('accepts the old version/options.verseOffset shape with a notice', () => {
    const sermon = parseSermonFile(
      [
        'version:',
        '  - SCH2000',
        '  - TAOVBSI',
        'verses:',
        '  - book: PSA',
        '    chapter: 4',
        '    verses: 2-6',
        '    force: true',
        '    options:',
        '      SCH2000:',
        '        verseOffset: 1',
      ].join('\n'),
    );
    expect(sermon.translations).toEqual(['SCH2000', 'TAOVBSI']);
    expect(sermon.entries).toEqual([
      { book: 'PSA', chapter: 4, verses: [2, 3, 4, 5, 6], offsets: { SCH2000: 1 } },
    ]);
    expect(sermon.notices.some((notice) => notice.includes('legacy format'))).toBe(true);
    expect(sermon.notices.some((notice) => notice.includes('"force"'))).toBe(true);
  });

  it('ignores zero and malformed legacy offsets', () => {
    const sermon = parseSermonFile(
      [
        'version: [KJV]',
        'verses:',
        '  - book: PSA',
        '    chapter: 1',
        '    verses: 1',
        '    options:',
        '      KJV: {verseOffset: 0}',
        '      NIV: nonsense',
      ].join('\n'),
    );
    expect(sermon.entries[0]?.offsets).toEqual({});
  });

  it('defaults offsets to {} when a legacy entry has no options', () => {
    const sermon = parseSermonFile(
      ['version: [KJV]', 'verses:', '  - book: PSA', '    chapter: 1', '    verses: 1'].join('\n'),
    );
    expect(sermon.entries[0]?.offsets).toEqual({});
  });

  it.each([
    ['version: KJV\nverses: [{book: PSA, chapter: 1, verses: 1}]', '"version"'],
    ['version: []\nverses: [{book: PSA, chapter: 1, verses: 1}]', '"version"'],
    ['version: [KJV, 7]\nverses: [{book: PSA, chapter: 1, verses: 1}]', 'version[1]'],
    ['version: [KJV]', '"verses"'],
  ])('rejects legacy %j', (text, fragment) => {
    try {
      parseSermonFile(text);
      expect.unreachable();
    } catch (error) {
      expect((error as HolyDeckError).code).toBe('sermon_invalid');
      expect((error as HolyDeckError).message).toContain(fragment);
    }
  });
});
