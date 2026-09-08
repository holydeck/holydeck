import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../../test/helpers/app.js';
import { flagParam } from './verses.js';
import type { TestApp } from '../../test/helpers/app.js';

interface VersesBody {
  verses: Record<string, string>;
  citation: string;
  revision: number;
  fetchedAt: string;
  source: string;
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

const url = '/api/v1/translations/KJV/verses';

async function seed(): Promise<void> {
  await ctx.store.putChapter('KJV', 'PSA', '117', { '1': 'Cached one.', '2': 'Cached two.' }, 2);
}

describe('GET /api/v1/translations/:abbr/verses', () => {
  it('serves cached verses as a VerseMap with exactly five response fields', async () => {
    await seed();
    const response = await ctx.app.inject({ method: 'GET', url: `${url}?book=PSA&chapter=117&verses=2,1` });
    expect(response.statusCode).toBe(200);
    const body = response.json<VersesBody>();
    expect(Object.keys(body).sort()).toEqual(['citation', 'fetchedAt', 'revision', 'source', 'verses']);
    expect(body.verses).toEqual({ '1': 'Cached one.', '2': 'Cached two.' });
    expect(body.citation).toBe('Psalms 117:2,1');
    expect(body.revision).toBe(1);
    expect(body.source).toBe('cache');
    expect(ctx.urls).toEqual([]);
  });

  it('fetches live on ?refresh=true and on a bare ?refresh flag', async () => {
    await seed();
    for (const suffix of ['&refresh=true', '&refresh']) {
      ctx.urls.length = 0;
      const response = await ctx.app.inject({ method: 'GET', url: `${url}?book=PSA&chapter=117&verses=1${suffix}` });
      expect(response.statusCode).toBe(200);
      expect(response.json<VersesBody>().source).toBe('live');
      expect(ctx.urls.some((u) => u.includes('PSA.117'))).toBe(true);
    }
  });

  it('keeps the old revision and fetchedAt when a refresh finds identical content', async () => {
    const first = await ctx.app.inject({ method: 'GET', url: `${url}?book=PSA&chapter=117&verses=1&refresh` });
    const initial = first.json<VersesBody>();
    const second = await ctx.app.inject({ method: 'GET', url: `${url}?book=PSA&chapter=117&verses=1&refresh` });
    const repeat = second.json<VersesBody>();
    expect(repeat.source).toBe('live');
    expect(repeat.revision).toBe(initial.revision);
    expect(repeat.fetchedAt).toBe(initial.fetchedAt);
  });

  it('pins an older revision with ?revision=N', async () => {
    await ctx.store.putChapter('KJV', 'PSA', '117', { '1': 'Old text.', '2': 'Two.' }, 2);
    await ctx.store.putChapter('KJV', 'PSA', '117', { '1': 'New text.', '2': 'Two.' }, 2);
    const pinned = await ctx.app.inject({ method: 'GET', url: `${url}?book=PSA&chapter=117&verses=1&revision=1` });
    expect(pinned.json<VersesBody>()).toMatchObject({ revision: 1, source: 'cache' });
    expect(pinned.json<VersesBody>().verses['1']).toBe('Old text.');
    const latest = await ctx.app.inject({ method: 'GET', url: `${url}?book=PSA&chapter=117&verses=1` });
    expect(latest.json<VersesBody>()).toMatchObject({ revision: 2 });
    expect(ctx.urls).toEqual([]);
  });

  it('404s with revision_not_found for a revision that never existed', async () => {
    await seed();
    const response = await ctx.app.inject({ method: 'GET', url: `${url}?book=PSA&chapter=117&verses=1&revision=9` });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('revision_not_found');
  });

  it('combines refresh and revision: fetches first, then serves the pinned revision', async () => {
    await ctx.store.putChapter('KJV', 'PSA', '117', { '1': 'Old text.', '2': 'Two.' }, 2);
    const response = await ctx.app.inject({
      method: 'GET',
      url: `${url}?book=PSA&chapter=117&verses=1&refresh=true&revision=1`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<VersesBody>();
    expect(ctx.urls.some((u) => u.includes('PSA.117'))).toBe(true);   // refresh really fetched
    expect(body).toMatchObject({ revision: 1, source: 'live' });
    expect(body.verses['1']).toBe('Old text.');                       // pinned rev 1, not the fresh rev 2
    const latest = await ctx.app.inject({ method: 'GET', url: `${url}?book=PSA&chapter=117&verses=1` });
    expect(latest.json<VersesBody>()).toMatchObject({ revision: 2 }); // the refresh appended rev 2
  });

  it('400s on schema violations and bad verse lists', async () => {
    await seed();
    const cases = [
      `${url}?chapter=117&verses=1`,          // book missing
      `${url}?book=PSALM&chapter=117&verses=1`, // book pattern (3 alphanumerics)
      `${url}?book=PSA&verses=1`,             // chapter missing
      `${url}?book=PSA&chapter=0&verses=1`,   // chapter minimum
      `${url}?book=PSA&chapter=117&verses=`,  // verses minLength
    ];
    for (const bad of cases) {
      const response = await ctx.app.inject({ method: 'GET', url: bad });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('request_invalid');
    }
    const badList = await ctx.app.inject({ method: 'GET', url: `${url}?book=PSA&chapter=117&verses=x` });
    expect(badList.statusCode).toBe(400);
    expect(badList.json<{ error: { code: string } }>().error.code).toBe('invalid_verse_list');
  });

  it('404s for unknown translations and absent verses', async () => {
    const unknown = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/translations/ZZZ/verses?book=PSA&chapter=117&verses=1',
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe('unknown_translation');

    await seed();
    const missingVerse = await ctx.app.inject({ method: 'GET', url: `${url}?book=PSA&chapter=117&verses=3` });
    expect(missingVerse.statusCode).toBe(404);
    const body = missingVerse.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('verse_not_in_store');
    expect(body.error.message).toContain('3');
  });
});

describe('flagParam', () => {
  it('accepts true, "true" and the empty string; rejects everything else', () => {
    expect(flagParam(true)).toBe(true);
    expect(flagParam('true')).toBe(true);
    expect(flagParam('')).toBe(true);
    expect(flagParam('false')).toBe(false);
    expect(flagParam(undefined)).toBe(false);
    expect(flagParam(1)).toBe(false);
  });
});
