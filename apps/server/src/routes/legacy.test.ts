import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEmptyStoreFile } from '@holydeck/core/storage';
import { parseVersionMeta } from '@holydeck/core/canon';
import { buildTestApp } from '../../test/helpers/app.js';
import { chapterHtml, versionPayload } from '../../test/helpers/scrape.js';
import type { TestApp } from '../../test/helpers/app.js';

interface LegacySuccess {
  citation: string;
  passage: string;
  book: string;
  chapter: number;
  verses: string;
}

interface LegacyError {
  statusCode: number;
  message: string;
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
  ctx.urls.length = 0;
});

const url = '/api/v1/verse';

async function seedGermanCanon(): Promise<void> {
  const parsed = parseVersionMeta(
    JSON.parse(
      versionPayload({
        books: [
          {
            usfm: 'PSA',
            name: 'Die Psalmen',
            longName: 'Das Buch der Psalmen',
            abbreviation: 'Ps',
            chapters: Array.from({ length: 117 }, (_, index) => String(index + 1)),
          },
        ],
      }),
    ),
  );
  const file = createEmptyStoreFile('KJV', 't0');
  file.canon = parsed.canon;
  await ctx.store.save('KJV', file);
}

describe('GET /api/v1/verse (deprecated shim)', () => {
  it('always sets the deprecation header', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: `${url}?book=PSA&chapter=117&verses=1` });
    expect(response.headers.deprecation).toBe('true');
  });

  it("400s with the frozen literal when book is missing or empty", async () => {
    for (const bad of [url, `${url}?book=`]) {
      const response = await ctx.app.inject({ method: 'GET', url: bad });
      expect(response.statusCode).toBe(400);
      expect(response.json<LegacyError>()).toEqual({ statusCode: 400, message: "Missing field 'book'" });
    }
  });

  it('resolves a USFM book case-insensitively and fetches live on cache miss', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: `${url}?book=psa&chapter=117&verses=1` });
    expect(response.statusCode).toBe(200);
    const body = response.json<LegacySuccess>();
    expect(body).toEqual({
      citation: 'Psalms 117:1',
      passage: 'Praise verse one.',
      book: 'Psalms',
      chapter: 117,
      verses: '1',
    });
    expect(ctx.urls.some((u) => u.includes('PSA.117'))).toBe(true);
  });

  it('resolves bundled English names and joins multi-verse passages with spaces', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: `${url}?book=Psalms&chapter=117&verses=1-2` });
    expect(response.statusCode).toBe(200);
    const body = response.json<LegacySuccess>();
    expect(body.passage).toBe('Praise verse one. Praise verse two.');
    expect(body.verses).toBe('1-2');
  });

  it('resolves localized stored-canon names, long names and abbreviations', async () => {
    await seedGermanCanon();
    for (const name of ['Die Psalmen', 'das buch der psalmen', 'ps']) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `${url}?book=${encodeURIComponent(name)}&chapter=117&verses=1`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<LegacySuccess>().book).toBe('Die Psalmen');
    }
  });

  it("400s with the frozen not-found literal for an unknown book", async () => {
    const response = await ctx.app.inject({ method: 'GET', url: `${url}?book=Nope&chapter=1&verses=1` });
    expect(response.statusCode).toBe(400);
    expect(response.json<LegacyError>()).toEqual({
      statusCode: 400,
      message: "Could not find book 'Nope' by name or alias.",
    });
  });

  it("400s with 'Chapter not found.' for out-of-range and non-numeric chapters", async () => {
    for (const bad of [`${url}?book=GEN&chapter=999&verses=1`, `${url}?book=GEN&chapter=abc&verses=1`, `${url}?book=GEN&chapter=0&verses=1`]) {
      const response = await ctx.app.inject({ method: 'GET', url: bad });
      expect(response.statusCode).toBe(400);
      expect(response.json<LegacyError>()).toEqual({ statusCode: 400, message: 'Chapter not found.' });
    }
  });

  it('defaults chapter and verses to 1 and falls back to KJV for unknown versions', async () => {
    // Dedicated app: the shared ctx fetcher mock always serves PSA 117, but this
    // case needs the default (omitted) chapter, which resolves to chapter 1.
    const dedicated = await buildTestApp({
      scrape: (requestUrl) =>
        requestUrl.includes('/api/bible/version/') ? versionPayload() : chapterHtml('PSA', '1', { '1': 'Praise verse one.' }),
    });
    const response = await dedicated.app.inject({ method: 'GET', url: `${url}?book=PSA&version=ZZZ` });
    expect(response.statusCode).toBe(200);
    const body = response.json<LegacySuccess>();
    expect(body.chapter).toBe(1);
    expect(body.verses).toBe('1');
    expect(dedicated.urls.some((u) => u.includes('/bible/1/'))).toBe(true);   // KJV id = 1
    await dedicated.stop();
  });

  it('re-fetches when force is set', async () => {
    await ctx.store.putChapter('KJV', 'PSA', '117', { '1': 'Stale.', '2': 'Two.' }, 2);
    const cached = await ctx.app.inject({ method: 'GET', url: `${url}?book=PSA&chapter=117&verses=1` });
    expect(cached.json<LegacySuccess>().passage).toBe('Stale.');
    expect(ctx.urls).toEqual([]);
    const forced = await ctx.app.inject({ method: 'GET', url: `${url}?book=PSA&chapter=117&verses=1&force=true` });
    expect(forced.json<LegacySuccess>().passage).toBe('Praise verse one.');
    expect(ctx.urls.length).toBeGreaterThan(0);
  });

  it('maps service errors to the old {statusCode, message} shape', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: `${url}?book=PSA&chapter=117&verses=9` });
    expect(response.statusCode).toBe(404);
    const body = response.json<LegacyError>();
    expect(body.statusCode).toBe(404);
    expect(body.message).toContain('9');
  });

  it('answers 500 with the old shape when the store is down', async () => {
    const dedicated = await buildTestApp();
    await dedicated.stopMongo();
    const response = await dedicated.app.inject({ method: 'GET', url: `${url}?book=PSA&chapter=117&verses=1` });
    expect(response.statusCode).toBe(500);
    expect(response.json<LegacyError>()).toEqual({ statusCode: 500, message: 'Unexpected server error.' });
    await dedicated.app.close();
  });
});
