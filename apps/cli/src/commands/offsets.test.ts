import { describe, expect, it } from 'vitest';
import type { TranslationStoreFile } from '@holydeck/core/storage';
import { makeContext, seedStore } from '../../test/harness.js';
import { runCli } from '../program.js';
import { compareCounts } from './offsets.js';

async function seedPair(dataDir: string): Promise<void> {
  await seedStore(dataDir, 'KJV', [
    { book: 'PSA', chapter: '3', verses: { '1': 'a' }, canonVerseCount: 8 },
    { book: 'PSA', chapter: '117', verses: { '1': 'a' }, canonVerseCount: 2 },
    { book: 'GEN', chapter: '1', verses: { '1': 'a' }, canonVerseCount: 31 },
  ]);
  await seedStore(dataDir, 'WEB', [
    { book: 'PSA', chapter: '3', verses: { '1': 'b' }, canonVerseCount: 9 },
    { book: 'PSA', chapter: '117', verses: { '1': 'b' }, canonVerseCount: 2 },
    { book: 'EXO', chapter: '1', verses: { '1': 'b' }, canonVerseCount: 22 },
  ]);
}

describe('offsets', () => {
  it('reports chapters whose verse counts differ, comparing only shared chapters', async () => {
    const setup = makeContext();
    await seedPair(setup.dataDir);
    await expect(runCli(setup.ctx, ['offsets', 'KJV', 'WEB'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('PSA 3: KJV 8 vs WEB 9 (offset +1)');
    expect(setup.stdout()).not.toContain('GEN');
    expect(setup.stdout()).not.toContain('EXO');
    expect(setup.stdout()).toContain('1 differing of 2 shared chapters.');
  });

  it('reports a clean result when all shared chapters match', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [{ book: 'PSA', chapter: '117', verses: { '1': 'a' }, canonVerseCount: 2 }]);
    await seedStore(setup.dataDir, 'WEB', [{ book: 'PSA', chapter: '117', verses: { '1': 'b' }, canonVerseCount: 2 }]);
    await expect(runCli(setup.ctx, ['offsets', 'KJV', 'WEB'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('no verse-count differences in 1 shared chapters.');
  });

  it('filters to a single book when given', async () => {
    const setup = makeContext();
    await seedPair(setup.dataDir);
    await seedStore(setup.dataDir, 'KJV', [{ book: 'JHN', chapter: '1', verses: { '1': 'a' }, canonVerseCount: 51 }]);
    await seedStore(setup.dataDir, 'WEB', [{ book: 'JHN', chapter: '1', verses: { '1': 'b' }, canonVerseCount: 52 }]);
    await expect(runCli(setup.ctx, ['offsets', 'KJV', 'WEB', 'psa'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('PSA 3');
    expect(setup.stdout()).not.toContain('JHN');
  });

  it('accepts a book name as the filter', async () => {
    const setup = makeContext();
    await seedPair(setup.dataDir);
    await expect(runCli(setup.ctx, ['offsets', 'KJV', 'WEB', 'Psalms'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('PSA 3');
  });

  it('matches nothing when the filter names no known book', async () => {
    const setup = makeContext();
    await seedPair(setup.dataDir);
    await expect(runCli(setup.ctx, ['offsets', 'KJV', 'WEB', 'Hezekiah'])).resolves.toBe(0);
    expect(setup.stdout()).not.toContain('PSA 3');
  });

  it('errors when a translation is not stored locally', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [{ book: 'PSA', chapter: '117', verses: { '1': 'a' }, canonVerseCount: 2 }]);
    await expect(runCli(setup.ctx, ['offsets', 'KJV', 'SCH2000'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('SCH2000');
  });

  it('emits JSON with --json', async () => {
    const setup = makeContext();
    await seedPair(setup.dataDir);
    await expect(runCli(setup.ctx, ['offsets', 'KJV', 'WEB', '--json'])).resolves.toBe(0);
    const parsed = JSON.parse(setup.stdout()) as {
      a: string;
      b: string;
      shared: number;
      differences: Array<{ book: string; chapter: number; a: number; b: number; offset: number }>;
    };
    expect(parsed).toEqual({
      a: 'KJV',
      b: 'WEB',
      shared: 2,
      differences: [{ book: 'PSA', chapter: 3, a: 8, b: 9, offset: 1 }],
    });
  });

  it('is local-only', async () => {
    const setup = makeContext();
    await expect(
      runCli(setup.ctx, ['offsets', 'KJV', 'WEB', '--server-url', 'https://holydeck.example.com']),
    ).resolves.toBe(1);
    expect(setup.stderr()).toContain('works on the local datastore');
  });

  it('renders negative offsets without a plus sign', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [{ book: 'PSA', chapter: '9', verses: { '1': 'a' }, canonVerseCount: 21 }]);
    await seedStore(setup.dataDir, 'WEB', [{ book: 'PSA', chapter: '9', verses: { '1': 'b' }, canonVerseCount: 20 }]);
    await expect(runCli(setup.ctx, ['offsets', 'KJV', 'WEB'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('PSA 9: KJV 21 vs WEB 20 (offset -1)');
  });

  it('skips a chapter present in a shared book on one side but absent on the other', () => {
    const fileA: TranslationStoreFile = {
      schemaVersion: 1,
      translation: 'KJV',
      updatedAt: '2026-01-01T00:00:00.000Z',
      books: {
        PSA: {
          chapters: {
            '3': { canonVerseCount: 8, revisions: [] },
            '4': { canonVerseCount: 5, revisions: [] },
          },
        },
      },
    };
    const fileB: TranslationStoreFile = {
      schemaVersion: 1,
      translation: 'WEB',
      updatedAt: '2026-01-01T00:00:00.000Z',
      books: { PSA: { chapters: { '3': { canonVerseCount: 8, revisions: [] } } } },
    };
    expect(compareCounts(fileA, fileB)).toEqual({ shared: 1, differences: [] });
  });

  it('treats a corrupted per-book entry (own key, no value) as having no chapters', () => {
    const fileA = {
      schemaVersion: 1,
      translation: 'KJV',
      updatedAt: '2026-01-01T00:00:00.000Z',
      books: { PSA: undefined },
    } as unknown as TranslationStoreFile;
    const fileB: TranslationStoreFile = {
      schemaVersion: 1,
      translation: 'WEB',
      updatedAt: '2026-01-01T00:00:00.000Z',
      books: { PSA: { chapters: { '3': { canonVerseCount: 8, revisions: [] } } } },
    };
    expect(compareCounts(fileA, fileB)).toEqual({ shared: 0, differences: [] });
  });

  it('tolerates a per-book entry that disappears between the chapter-list read and the lookup (fault injection)', () => {
    let reads = 0;
    const booksA = {};
    Object.defineProperty(booksA, 'PSA', {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? { chapters: { '3': { canonVerseCount: 8, revisions: [] } } } : undefined;
      },
    });
    const fileA = {
      schemaVersion: 1,
      translation: 'KJV',
      updatedAt: '2026-01-01T00:00:00.000Z',
      books: booksA,
    } as unknown as TranslationStoreFile;
    const fileB: TranslationStoreFile = {
      schemaVersion: 1,
      translation: 'WEB',
      updatedAt: '2026-01-01T00:00:00.000Z',
      books: { PSA: { chapters: { '3': { canonVerseCount: 8, revisions: [] } } } },
    };
    expect(compareCounts(fileA, fileB)).toEqual({ shared: 0, differences: [] });
  });
});
