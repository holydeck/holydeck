import { describe, expect, it } from 'vitest';
import { HolyDeckError } from './messages.js';
import {
  STORE_SCHEMA_VERSION,
  appendRevision,
  contentHash,
  createEmptyStoreFile,
  findRevision,
  getChapter,
  latestRevision,
  validateStoreFile,
} from './storage.js';

const verses = { '1': 'Alpha.', '2': 'Beta.' };

describe('contentHash', () => {
  it('is stable across key order and sorts numerically (2 before 10)', () => {
    expect(contentHash({ '2': 'b', '10': 'j', '1': 'a' })).toBe(contentHash({ '1': 'a', '10': 'j', '2': 'b' }));
    expect(contentHash({ '1': 'a' })).not.toBe(contentHash({ '1': 'b' }));
    expect(contentHash(verses)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('appendRevision', () => {
  it('creates revision 1 on an empty record', () => {
    const { record, changed, rev } = appendRevision(undefined, verses, 2, '2026-09-07T10:00:00.000Z');
    expect(changed).toBe(true);
    expect(rev).toBe(1);
    expect(record.canonVerseCount).toBe(2);
    expect(record.revisions).toEqual([
      { rev: 1, fetchedAt: '2026-09-07T10:00:00.000Z', contentHash: contentHash(verses), verses },
    ]);
  });

  it('does NOT append when content is unchanged ("content unchanged" semantics)', () => {
    const first = appendRevision(undefined, verses, 2, 't1').record;
    const { record, changed, rev } = appendRevision(first, { ...verses }, 2, 't2');
    expect(changed).toBe(false);
    expect(rev).toBe(1);
    expect(record.revisions).toHaveLength(1);
  });

  it('appends revision 2 when content differs', () => {
    const first = appendRevision(undefined, verses, 2, 't1').record;
    const { record, changed, rev } = appendRevision(first, { '1': 'Alpha!', '2': 'Beta.' }, 2, 't2');
    expect(changed).toBe(true);
    expect(rev).toBe(2);
    expect(record.revisions).toHaveLength(2);
    expect(latestRevision(record)?.rev).toBe(2);
  });
});

describe('findRevision / latestRevision / getChapter', () => {
  const record = appendRevision(appendRevision(undefined, verses, 2, 't1').record, { '1': 'x' }, 2, 't2').record;

  it('finds a pinned revision', () => {
    expect(findRevision(record, 1, { abbr: 'KJV', book: 'PSA', chapter: '117' }).fetchedAt).toBe('t1');
  });

  it('throws revision_not_found listing available revisions', () => {
    try {
      findRevision(record, 9, { abbr: 'KJV', book: 'PSA', chapter: '117' });
      expect.unreachable();
    } catch (error) {
      expect((error as HolyDeckError).code).toBe('revision_not_found');
      expect((error as HolyDeckError).message).toContain('1, 2');
    }
  });

  it('latestRevision of an empty record is undefined', () => {
    expect(latestRevision({ canonVerseCount: 0, revisions: [] })).toBeUndefined();
  });

  it('getChapter navigates the books tree and tolerates undefined', () => {
    const file = createEmptyStoreFile('KJV', 'now');
    file.books.PSA = { chapters: { '117': record } };
    expect(getChapter(file, 'PSA', '117')).toBe(record);
    expect(getChapter(file, 'PSA', '118')).toBeUndefined();
    expect(getChapter(file, 'GEN', '1')).toBeUndefined();
    expect(getChapter(undefined, 'PSA', '117')).toBeUndefined();
  });
});

describe('createEmptyStoreFile / validateStoreFile', () => {
  it('creates a valid empty file', () => {
    const file = createEmptyStoreFile('kjv', '2026-09-07T10:00:00.000Z');
    expect(file).toEqual({
      schemaVersion: STORE_SCHEMA_VERSION,
      translation: 'KJV',
      updatedAt: '2026-09-07T10:00:00.000Z',
      books: {},
    });
    expect(validateStoreFile(file, 'p.json')).toBe(file);
  });

  it.each([null, [], { schemaVersion: 1 }, { schemaVersion: 1, translation: 'KJV' }, { translation: 'KJV', books: {} }])(
    'rejects corrupt shape %j',
    (raw) => {
      try {
        validateStoreFile(raw, 'p.json');
        expect.unreachable();
      } catch (error) {
        expect((error as HolyDeckError).code).toBe('store_corrupt');
      }
    },
  );

  it('rejects files from a newer schema with store_newer_schema', () => {
    try {
      validateStoreFile({ schemaVersion: 99, translation: 'KJV', updatedAt: 'x', books: {} }, 'p.json');
      expect.unreachable();
    } catch (error) {
      expect((error as HolyDeckError).code).toBe('store_newer_schema');
    }
  });
});
