import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyStoreFile } from '@holydeck/core/storage';
import { parseVersionMeta } from '@holydeck/core/canon';
import { buildTestApp } from '../../test/helpers/app.js';
import { versionPayload } from '../../test/helpers/scrape.js';
import type { TestApp } from '../../test/helpers/app.js';

interface TranslationRow {
  abbreviation: string;
  id: number;
  title: string;
  language: string;
  syncedChapters: number;
  canonChapters: number;
  cached: boolean;
}

interface TranslationsBody {
  translations: TranslationRow[];
}

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
});

afterAll(async () => {
  await ctx.stop();
});

beforeEach(async () => {
  await ctx.db.dropDatabase();
});

describe('GET /api/v1/translations', () => {
  it('lists every known translation as uncached on an empty store', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/translations' });
    expect(response.statusCode).toBe(200);
    const { translations } = response.json<TranslationsBody>();
    expect(translations.length).toBeGreaterThanOrEqual(9);
    const kjv = translations.find((row) => row.abbreviation === 'KJV');
    expect(kjv).toEqual({
      abbreviation: 'KJV',
      id: 1,
      title: 'KJV',
      language: '',
      syncedChapters: 0,
      canonChapters: 1189,
      cached: false,
    });
    const abbrs = translations.map((row) => row.abbreviation);
    expect(abbrs).toEqual([...abbrs].sort());
  });

  it('marks cached translations with their title, language and chapter counts', async () => {
    const parsed = parseVersionMeta(
      JSON.parse(versionPayload({ language: { iso_639_1: 'en', name: 'English' } })),
    );
    const file = createEmptyStoreFile('KJV', 't0');
    file.meta = parsed.meta;
    file.canon = parsed.canon;
    await ctx.store.save('KJV', file);
    await ctx.store.putChapter('KJV', 'PSA', '117', { '1': 'One.', '2': 'Two.' }, 2);
    const { translations } = (await ctx.app.inject({ method: 'GET', url: '/api/v1/translations' })).json<TranslationsBody>();
    const kjv = translations.find((row) => row.abbreviation === 'KJV');
    expect(kjv).toEqual({
      abbreviation: 'KJV',
      id: 1,
      title: 'King James Version',
      language: 'English',
      syncedChapters: 1,
      canonChapters: 1,
      cached: true,
    });
  });

  it('reports an empty language when the version payload carried none', async () => {
    const parsed = parseVersionMeta(JSON.parse(versionPayload()));
    const file = createEmptyStoreFile('KJV', 't0');
    file.meta = parsed.meta;
    await ctx.store.save('KJV', file);
    const { translations } = (await ctx.app.inject({ method: 'GET', url: '/api/v1/translations' })).json<TranslationsBody>();
    expect(translations.find((row) => row.abbreviation === 'KJV')?.language).toBe('');
  });

  it('includes stored translations that are not in the known list, with sentinel id 0', async () => {
    await ctx.store.save('ZZZ', createEmptyStoreFile('ZZZ', 't0'));
    const { translations } = (await ctx.app.inject({ method: 'GET', url: '/api/v1/translations' })).json<TranslationsBody>();
    const zzz = translations.find((row) => row.abbreviation === 'ZZZ');
    expect(zzz).toEqual({
      abbreviation: 'ZZZ',
      id: 0,
      title: 'ZZZ',
      language: '',
      syncedChapters: 0,
      canonChapters: 1189,
      cached: true,
    });
  });
});

describe('GET /api/v1/translations/:abbr/canon', () => {
  it('serves the full bundled canon for a known but unsynced translation', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/translations/kjv/canon' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      translation: string;
      source: string;
      books: Array<{ usfm: string; name: string; chapters: Array<{ id: string; label: string }> }>;
    }>();
    expect(body.translation).toBe('KJV');
    expect(body.source).toBe('bundled');
    expect(body.books).toHaveLength(66);
    const psa = body.books.find((book) => book.usfm === 'PSA');
    expect(psa?.name).toBe('Psalms');
    expect(psa?.chapters).toHaveLength(150);
    expect(psa?.chapters[0]).toEqual({ id: '1', label: '1' });
  });

  it('serves the synced canon when the store has one', async () => {
    const parsed = parseVersionMeta(JSON.parse(versionPayload()));
    const file = createEmptyStoreFile('KJV', 't0');
    file.canon = parsed.canon;
    await ctx.store.save('KJV', file);
    const body = (await ctx.app.inject({ method: 'GET', url: '/api/v1/translations/KJV/canon' })).json<{
      source: string;
      books: Array<{ usfm: string; chapters: Array<{ id: string; label: string }> }>;
    }>();
    expect(body.source).toBe('synced');
    expect(body.books).toHaveLength(1);
    expect(body.books[0]?.chapters).toEqual([{ id: '117', label: '117' }]);
  });

  it('falls back to bundled for a cached file without a canon', async () => {
    await ctx.store.save('KJV', createEmptyStoreFile('KJV', 't0'));
    const body = (await ctx.app.inject({ method: 'GET', url: '/api/v1/translations/KJV/canon' })).json<{ source: string }>();
    expect(body.source).toBe('bundled');
  });

  it('rejects an unknown, uncached translation with the envelope', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/translations/ZZZ/canon' });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('unknown_translation');
  });
});
