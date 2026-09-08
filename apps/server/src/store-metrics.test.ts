import { describe, expect, it } from 'vitest';
import { createEmptyStoreFile } from '@holydeck/core/storage';
import { canonChapterTotal, revisionCount, storedChapterCount } from './store-metrics.js';
import type { TranslationStoreFile } from '@holydeck/core/storage';

function fileWithChapters(): TranslationStoreFile {
  const file = createEmptyStoreFile('KJV', 't0');
  file.books.PSA = {
    chapters: {
      '116': { canonVerseCount: 19, revisions: [{ rev: 1, fetchedAt: 't1', contentHash: 'h1', verses: { '1': 'a' } }] },
      '117': {
        canonVerseCount: 2,
        revisions: [
          { rev: 1, fetchedAt: 't1', contentHash: 'h2', verses: { '1': 'b' } },
          { rev: 2, fetchedAt: 't2', contentHash: 'h3', verses: { '1': 'c' } },
        ],
      },
    },
  };
  file.books.GEN = {
    chapters: { '1': { canonVerseCount: 31, revisions: [{ rev: 1, fetchedAt: 't1', contentHash: 'h4', verses: { '1': 'd' } }] } },
  };
  return file;
}

describe('store-metrics', () => {
  it('counts stored chapters across books', () => {
    expect(storedChapterCount(fileWithChapters())).toBe(3);
    expect(storedChapterCount(createEmptyStoreFile('KJV', 't0'))).toBe(0);
  });

  it('counts revisions across all chapters', () => {
    expect(revisionCount(fileWithChapters())).toBe(4);
    expect(revisionCount(createEmptyStoreFile('KJV', 't0'))).toBe(0);
  });

  it('totals canon chapters from the stored canon when present, bundled otherwise', () => {
    expect(canonChapterTotal(undefined)).toBe(1189);
    expect(canonChapterTotal(createEmptyStoreFile('KJV', 't0'))).toBe(1189);
    const synced = createEmptyStoreFile('KJV', 't0');
    synced.canon = {
      books: [
        {
          usfm: 'PSA',
          canon: 'ot',
          name: 'Psalms',
          chapters: [
            { id: '116', label: '116' },
            { id: '117', label: '117' },
          ],
        },
      ],
    };
    expect(canonChapterTotal(synced)).toBe(2);
  });
});
