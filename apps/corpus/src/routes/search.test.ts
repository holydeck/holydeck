import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../../test/helpers/app.js';
import type { TestApp } from '../../test/helpers/app.js';

interface SearchBody {
  translation: string;
  query: string;
  hits: Array<{
    book: string;
    bookOrder: number;
    chapter: number;
    verse: number;
    text: string;
    revision: number;
    phrase: boolean;
    occurrences: number;
  }>;
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

const url = '/api/v1/translations/KJV/search';

async function seed(): Promise<void> {
  await ctx.store.putChapter('KJV', 'PSA', '117', { '1': 'Praise the LORD, all ye nations.', '2': 'Praise him.' }, 2);
  await ctx.store.putChapter('KJV', 'GEN', '1', { '1': 'In the beginning God created heaven and earth.' }, 1);
}

describe('GET /api/v1/translations/:abbr/search', () => {
  it('searches the text this service already holds, and fetches nothing to do it', async () => {
    await seed();
    const response = await ctx.app.inject({ method: 'GET', url: `${url}?q=praise` });
    expect(response.statusCode).toBe(200);
    const body = response.json<SearchBody>();
    expect(Object.keys(body).sort()).toEqual(['hits', 'query', 'translation']);
    expect(body).toMatchObject({ translation: 'KJV', query: 'praise' });
    expect(body.hits).toEqual([
      {
        book: 'PSA',
        bookOrder: 18,
        chapter: 117,
        verse: 1,
        text: 'Praise the LORD, all ye nations.',
        revision: 1,
        phrase: true,
        occurrences: 1,
      },
      {
        book: 'PSA',
        bookOrder: 18,
        chapter: 117,
        verse: 2,
        text: 'Praise him.',
        revision: 1,
        phrase: true,
        occurrences: 1,
      },
    ]);
    expect(ctx.urls).toEqual([]);
  });

  it('answers across every book it holds, in the order the canon reads them', async () => {
    await seed();
    const body = (await ctx.app.inject({ method: 'GET', url: `${url}?q=the` })).json<SearchBody>();
    expect(body.hits.map((hit) => `${hit.book} ${hit.chapter}:${hit.verse}`)).toEqual(['GEN 1:1', 'PSA 117:1']);
    expect(ctx.urls).toEqual([]);
  });

  it('reads the translation in whichever case it was asked for', async () => {
    await seed();
    const body = (await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/translations/kjv/search?q=beginning',
    })).json<SearchBody>();
    expect(body.translation).toBe('KJV');
    expect(body.hits.map((hit) => hit.book)).toEqual(['GEN']);
  });

  it('answers nothing at all for a known translation nothing has been synced into, rather than fetching it', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: `${url}?q=praise` });
    expect(response.statusCode).toBe(200);
    expect(response.json<SearchBody>().hits).toEqual([]);
    expect(ctx.urls).toEqual([]);
  });

  it('404s for a translation this build has never heard of', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/translations/ZZZ/search?q=praise' });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('unknown_translation');
    expect(ctx.urls).toEqual([]);
  });

  it('400s when nothing was asked for', async () => {
    await seed();
    for (const bad of [url, `${url}?q=`]) {
      const response = await ctx.app.inject({ method: 'GET', url: bad });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('request_invalid');
    }
  });
});
