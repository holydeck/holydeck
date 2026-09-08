import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, seedCanon } from '../test/helpers/app.js';
import { readVerses } from './verses-service.js';
import type { TestApp } from '../test/helpers/app.js';

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
});

afterAll(async () => {
  await ctx.stop();
});

beforeEach(async () => {
  await ctx.db.dropDatabase();
  ctx.urls.length = 0;
});

const base = { abbr: 'KJV', book: 'PSA', chapter: 117, verses: [1], refresh: false };

describe('readVerses fetchMissing', () => {
  it('fetches a missing chapter live by default', async () => {
    const result = await readVerses(ctx.store, ctx.fetcher, { ...base });
    expect(result.source).toBe('live');
    expect(result.verses).toEqual([{ verse: 1, text: 'Praise verse one.' }]);
    expect(ctx.urls.some((url) => url.includes('PSA.117'))).toBe(true);
  });

  it('does not fetch when the chapter is already cached', async () => {
    await seedCanon(ctx.store);
    await ctx.store.putChapter('KJV', 'PSA', '117', { '1': 'Cached one.', '2': 'Cached two.' }, 2);
    const result = await readVerses(ctx.store, ctx.fetcher, { ...base, fetchMissing: true });
    expect(result.source).toBe('cache');
    expect(result.verses[0]?.text).toBe('Cached one.');
    expect(ctx.urls).toEqual([]);
  });

  it('learns the book names of a translation cached before they were kept', async () => {
    await ctx.store.putChapter('KJV', 'PSA', '117', { '1': 'Cached one.' }, 2);
    const result = await readVerses(ctx.store, ctx.fetcher, { ...base });

    expect(result.source).toBe('cache');
    expect(ctx.urls).toEqual([expect.stringContaining('/api/bible/version/')]);
    await expect(ctx.store.load('KJV')).resolves.toMatchObject({ meta: { abbreviation: 'KJV' } });

    ctx.urls.length = 0;
    await readVerses(ctx.store, ctx.fetcher, { ...base });
    expect(ctx.urls).toEqual([]);
  });

  it('reports 404 chapter_not_in_store with fetchMissing off and no refresh', async () => {
    await expect(readVerses(ctx.store, ctx.fetcher, { ...base, fetchMissing: false })).rejects.toMatchObject({
      code: 'chapter_not_in_store',
      params: { abbr: 'KJV', book: 'PSA', chapter: '117' },
    });
    expect(ctx.urls).toEqual([]);
  });

  it('treats a chapter record with zero revisions as not in store', async () => {
    const { createEmptyStoreFile } = await import('@holydeck/core/storage');
    const file = createEmptyStoreFile('KJV', 't0');
    file.books.PSA = { chapters: { '117': { canonVerseCount: 2, revisions: [] } } };
    await ctx.store.save('KJV', file);
    await expect(readVerses(ctx.store, ctx.fetcher, { ...base })).rejects.toMatchObject({
      code: 'chapter_not_in_store',
    });
  });

  it('resolves book names: stored canon first, bundled second, USFM last', async () => {
    const { createEmptyStoreFile } = await import('@holydeck/core/storage');
    const { parseVersionMeta } = await import('@holydeck/core/canon');
    const { versionPayload } = await import('../test/helpers/scrape.js');
    const parsed = parseVersionMeta(
      JSON.parse(versionPayload({ books: [{ usfm: 'PSA', name: 'Die Psalmen', chapters: ['117'] }] })),
    );
    const file = createEmptyStoreFile('KJV', 't0');
    file.canon = parsed.canon;
    await ctx.store.save('KJV', file);
    await ctx.store.putChapter('KJV', 'PSA', '117', { '1': 'Eins.' }, 2);
    const stored = await readVerses(ctx.store, ctx.fetcher, { ...base });
    expect(stored.bookName).toBe('Die Psalmen');
    expect(stored.citation).toBe('Die Psalmen 117:1');

    await ctx.store.putChapter('KJV', 'GEN', '1', { '1': 'Beginning.' }, 31);
    const bundledHit = await readVerses(ctx.store, ctx.fetcher, { ...base, book: 'GEN', chapter: 1 });
    expect(bundledHit.bookName).toBe('Genesis');

    await ctx.store.putChapter('KJV', 'ZZZ', '1', { '1': 'Mystery.' }, 1);
    const unknownBook = await readVerses(ctx.store, ctx.fetcher, { ...base, book: 'ZZZ', chapter: 1 });
    expect(unknownBook.bookName).toBe('ZZZ');
  });
});
