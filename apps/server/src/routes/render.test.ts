import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../../test/helpers/app.js';
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

  it('404s with chapter_not_in_store for an unsynced translation', async () => {
    const sermon = ['translations:', '  - NIV', 'verses:', '  - book: PSA', '    chapter: 117', '    verses: 1', ''].join('\n');
    const response = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'text/yaml' },
      payload: sermon,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('chapter_not_in_store');
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
