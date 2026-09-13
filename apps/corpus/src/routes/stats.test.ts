import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../../test/helpers/app.js';
import type { TestApp } from '../../test/helpers/app.js';

interface StatsBody {
  translations: Array<{
    abbr: string;
    chapters: { stored: number; total: number };
    revisions: number;
    updatedAt: string;
  }>;
  totals: { translations: number; chapters: number; revisions: number };
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

describe('GET /api/v1/stats', () => {
  it('returns zero totals on an empty store', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/stats' });
    expect(response.statusCode).toBe(200);
    expect(response.json<StatsBody>()).toEqual({
      translations: [],
      totals: { translations: 0, chapters: 0, revisions: 0 },
    });
  });

  it('aggregates chapters and revisions across translations', async () => {
    await ctx.store.putChapter('KJV', 'PSA', '117', { '1': 'One.', '2': 'Two.' }, 2);
    await ctx.store.putChapter('KJV', 'PSA', '117', { '1': 'One changed.', '2': 'Two.' }, 2);
    await ctx.store.putChapter('KJV', 'GEN', '1', { '1': 'Beginning.' }, 31);
    await ctx.store.putChapter('NIV', 'PSA', '117', { '1': 'Eins.' }, 2);
    const body = (await ctx.app.inject({ method: 'GET', url: '/api/v1/stats' })).json<StatsBody>();
    expect(body.translations).toHaveLength(2);
    const kjv = body.translations.find((row) => row.abbr === 'KJV');
    expect(kjv).toMatchObject({ chapters: { stored: 2, total: 1189 }, revisions: 3 });
    expect(kjv?.updatedAt).toMatch(/^2026-09-08T12:00:/);
    const niv = body.translations.find((row) => row.abbr === 'NIV');
    expect(niv).toMatchObject({ chapters: { stored: 1, total: 1189 }, revisions: 1 });
    expect(body.totals).toEqual({ translations: 2, chapters: 3, revisions: 4 });
  });
});
