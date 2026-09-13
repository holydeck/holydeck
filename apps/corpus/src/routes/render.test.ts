import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../../test/helpers/app.js';
import { chapterHtml } from '../../test/helpers/scrape.js';
import type { TestApp } from '../../test/helpers/app.js';

interface RenderBody {
  output: string;
  notices: string[];
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
  await ctx.store.putChapter(
    'KJV',
    'PSA',
    '117',
    { '1': 'O praise the LORD, all ye nations.', '2': 'Praise him, all ye people.' },
    2,
  );
});

const url = '/api/v1/render';

const modernSermon = ['translations:', '  - KJV', 'verses:', '  - book: PSA', '    chapter: 117', '    verses: 1-2', ''].join('\n');

describe('POST /api/v1/render', () => {
  it('renders a YAML sermon body (text/plain, as the CLI posts it) with the default template', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      payload: modernSermon,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<RenderBody>();
    expect(body.output).toBe('O praise the LORD, all ye nations. Praise him, all ye people.\nPsalms 117:1-2 (KJV)\n\n');
    expect(body.notices).toEqual([]);
  });

  it('accepts application/yaml with the same result', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/yaml' },
      payload: modernSermon,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<RenderBody>().output).toContain('Psalms 117:1-2 (KJV)');
  });

  it('accepts a JSON object body as the sermon document', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url,
      payload: { translations: ['KJV'], verses: [{ book: 'PSA', chapter: 117, verses: '1-2' }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<RenderBody>().output).toContain('O praise the LORD');
  });

  it('carries the legacy-format notice through', async () => {
    const legacySermon = ['version:', '  - KJV', 'verses:', '  - book: PSA', '    chapter: 117', '    verses: 1-2', ''].join('\n');
    const response = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'text/yaml' },
      payload: legacySermon,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<RenderBody>();
    expect(body.output).toContain('Psalms 117:1-2 (KJV)');
    expect(body.notices.length).toBeGreaterThan(0);
  });

  it('renders a legacy {0.passage} template and adds the legacy_template notice', async () => {
    const withTemplate = [
      'translations:',
      '  - KJV',
      'template: "{0.passage}\\n{0.book} {0.chapter}:{0.verses}\\n\\n"',
      'verses:',
      '  - book: PSA',
      '    chapter: 117',
      '    verses: 1-2',
      '',
    ].join('\n');
    const response = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'text/yaml' },
      payload: withTemplate,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<RenderBody>();
    expect(body.output).toContain('O praise the LORD');
    expect(body.notices.some((notice) => notice.toLowerCase().includes('template'))).toBe(true);
  });

  it('fetches an unsynced translation, or 404s with chapter_not_in_store when told not to', async () => {
    const sermon = ['translations:', '  - NIV', 'verses:', '  - book: PSA', '    chapter: 117', '    verses: 1', ''].join('\n');
    const headers = { 'content-type': 'text/yaml' };
    ctx.urls.length = 0;

    const refused = await ctx.app.inject({ method: 'POST', url: `${url}?fetchMissing=false`, headers, payload: sermon });
    expect(refused.statusCode).toBe(404);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('chapter_not_in_store');
    expect(ctx.urls).toEqual([]);

    const fetched = await ctx.app.inject({ method: 'POST', url, headers, payload: sermon });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json<RenderBody>().output).toContain('Psalms 117:1 (NIV)');
    expect(ctx.urls.some((u) => u.includes('PSA.117'))).toBe(true);
  });

  it('renders with English book names and says so when the real ones cannot be fetched', async () => {
    const offline = await buildTestApp({
      scrape: (requestUrl) => {
        if (requestUrl.includes('/api/bible/version/')) throw new Error('version API down');
        return chapterHtml('PSA', '117', { '1': 'O praise the LORD, all ye nations.', '2': 'Praise him, all ye people.' });
      },
    });
    const response = await offline.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'text/yaml' },
      payload: modernSermon,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<RenderBody>();
    expect(body.output).toContain('Psalms 117:1-2 (KJV)');
    expect(body.notices.some((notice) => notice.includes('book names of KJV'))).toBe(true);
    await offline.stop();
  });

  it('400s with sermon_invalid on unparseable YAML and on a JSON null body', async () => {
    const badYaml = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'text/yaml' },
      payload: '{{{{not yaml',
    });
    expect(badYaml.statusCode).toBe(400);
    expect(badYaml.json<{ error: { code: string } }>().error.code).toBe('sermon_invalid');

    const nullBody = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: 'null',
    });
    expect(nullBody.statusCode).toBe(400);
    expect(nullBody.json<{ error: { code: string } }>().error.code).toBe('sermon_invalid');
  });
});
