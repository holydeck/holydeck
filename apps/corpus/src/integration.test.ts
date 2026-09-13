import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_ENDPOINTS } from './errors.js';
import { buildTestApp } from '../test/helpers/app.js';
import { chapterHtml, versionPayload } from '../test/helpers/scrape.js';
import type { TestApp } from '../test/helpers/app.js';
import type { SyncJobStatus } from './jobs.js';

function scrape(url: string): string {
  if (url.includes('/api/bible/version/')) {
    return versionPayload({
      localTitle: 'King James Version',
      language: { iso_639_1: 'en', name: 'English' },
      books: [
        {
          usfm: 'PSA',
          name: 'Die Psalmen',
          chapters: Array.from({ length: 117 }, (_, index) => String(index + 1)),
        },
      ],
    });
  }
  const match = /PSA\.(\d+)/.exec(url);
  const chapter = match?.[1] ?? '117';
  if (chapter === '117') {
    return chapterHtml('PSA', '117', {
      '1': 'O praise the LORD, all ye nations.',
      '2': 'Praise him, all ye people.',
    });
  }
  return chapterHtml('PSA', chapter, { '1': `Synthetic verse for chapter ${chapter}.` });
}

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp({ scrape });
});

afterAll(async () => {
  await ctx.stop();
});

describe('end to end', () => {
  it('reports health', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; version: string; store: string }>();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.0.0-test');
    expect(body.store).toBe('ok');
  });

  it('starts a sync job over HTTP', async () => {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/v1/translations/kjv/sync' });
    expect(response.statusCode).toBe(202);
    const status = response.json<SyncJobStatus>();
    expect(status.translation).toBe('KJV');
    expect(status.state).toBe('running');
    expect(status.refresh).toBe(false);
  });

  it('completes the sync with a full-canon report', async () => {
    await ctx.jobs.onIdle();
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/translations/KJV/sync' });
    expect(response.statusCode).toBe(200);
    const status = response.json<SyncJobStatus>();
    expect(status.state).toBe('completed');
    expect(status.report).toMatchObject({ planned: 117, fetched: 117, unchanged: 0, newRevisions: 117, failed: [] });
  });

  it('serves verses in the exact five-field shape the CLI parses', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/translations/kjv/verses?book=PSA&chapter=117&verses=2,1',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(['citation', 'fetchedAt', 'revision', 'source', 'verses']);
    expect(body.verses).toEqual({
      '1': 'O praise the LORD, all ye nations.',
      '2': 'Praise him, all ye people.',
    });
    expect(body.citation).toBe('Die Psalmen 117:2,1');
    expect(body.revision).toBe(1);
    expect(body.source).toBe('cache');
  });

  it('deduplicates content on a refresh sync', async () => {
    const start = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/translations/KJV/sync',
      payload: { refresh: true },
    });
    expect(start.statusCode).toBe(202);
    expect(start.json<SyncJobStatus>().refresh).toBe(true);
    await ctx.jobs.onIdle();
    const status = (await ctx.app.inject({ method: 'GET', url: '/api/v1/translations/KJV/sync' })).json<SyncJobStatus>();
    expect(status.state).toBe('completed');
    expect(status.report).toMatchObject({ planned: 117, fetched: 117, unchanged: 117, newRevisions: 0, failed: [] });
  });

  it('lists translations in the wrapped six-field shape', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/translations' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ translations: Array<Record<string, unknown>> }>();
    const kjv = body.translations.find((row) => row.abbreviation === 'KJV');
    expect(kjv).toMatchObject({
      abbreviation: 'KJV',
      id: 1,
      title: 'King James Version',
      language: 'English',
      syncedChapters: 117,
      canonChapters: 117,
      cached: true,
    });
    const niv = body.translations.find((row) => row.abbreviation === 'NIV');
    expect(niv).toMatchObject({ cached: false, syncedChapters: 0, canonChapters: 1189 });
  });

  it('reports datastore stats', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/stats' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ totals: Record<string, number> }>();
    expect(body.totals).toEqual({ translations: 1, chapters: 117, revisions: 117 });
  });

  it('renders a sermon posted as text, exactly as the CLI does', async () => {
    const sermon = [
      'translations:',
      '  - KJV',
      'verses:',
      '  - book: PSA',
      '    chapter: 117',
      '    verses: 1-2',
      '',
    ].join('\n');
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/render',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      payload: sermon,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ output: string; notices: string[] }>()).toEqual({
      output:
        'O praise the LORD, all ye nations. Praise him, all ye people.\nDie Psalmen 117:1-2 (KJV)\n\n',
      notices: [],
    });
  });

  it('answers the deprecated verse route in the frozen legacy shape', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/verse?book=${encodeURIComponent('Die Psalmen')}&chapter=117&verses=1`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers.deprecation).toBe('true');
    expect(response.json()).toEqual({
      citation: 'Die Psalmen 117:1',
      passage: 'O praise the LORD, all ye nations.',
      book: 'Die Psalmen',
      chapter: 117,
      verses: '1',
    });
  });

  it('maps unknown routes to the envelope plus endpoint list', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/unknown' });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string }; endpoints: unknown }>();
    expect(body.error.code).toBe('route_not_found');
    expect(body.endpoints).toEqual(API_ENDPOINTS);
  });
});
