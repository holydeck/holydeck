import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chapterUrl } from '@holydeck/core/scraper';
import type { SermonFile } from '@holydeck/core/sermon';
import { chapterHtml, makeContext, seedStore } from '../test/harness.js';
import { loadEntryData, renderAndDeliver } from './passages.js';
import { createRuntime } from './runtime.js';

function sermonWith(overrides: Partial<SermonFile> = {}): SermonFile {
  return {
    translations: ['KJV'],
    entries: [{ book: 'PSA', chapter: 117, verses: [1, 2], offsets: {} }],
    notices: [],
    ...overrides,
  };
}

const psalm117 = { '1': 'O praise the LORD, all ye nations.', '2': 'For his merciful kindness is great.' };

describe('loadEntryData (local mode)', () => {
  it('assembles from the store and emits one cache footer per chapter', async () => {
    const { ctx, dataDir } = makeContext();
    await seedStore(dataDir, 'KJV', [{ book: 'PSA', chapter: '117', verses: psalm117 }]);
    const runtime = await createRuntime(ctx);
    const sermon = sermonWith({
      entries: [
        { book: 'PSA', chapter: 117, verses: [1], offsets: {} },
        { book: 'PSA', chapter: 117, verses: [2], offsets: {} },
      ],
    });
    const { entries, footers } = await loadEntryData(runtime, ctx, sermon);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.passages[0]?.text).toBe('O praise the LORD, all ye nations.');
    expect(entries[0]?.passages[0]?.citation).toBe('Psalms 117:1');
    expect(footers).toEqual(['source: cache · revision 1 · fetched 2026-09-01 — KJV PSA 117']);
  });

  it('fetches chapters the store lacks, reporting each one and marking its footer live', async () => {
    const { ctx, stderr } = makeContext({
      responses: {
        [chapterUrl(1, 'KJV', 'PSA', '117')]: { status: 200, body: chapterHtml('PSA', '117', psalm117) },
        [chapterUrl(1, 'KJV', 'PSA', '118')]: { status: 200, body: chapterHtml('PSA', '118', { '1': 'Give thanks.' }) },
      },
    });
    const runtime = await createRuntime(ctx);
    const sermon = sermonWith({
      entries: [
        { book: 'PSA', chapter: 117, verses: [1, 2], offsets: {} },
        { book: 'PSA', chapter: 118, verses: [1], offsets: {} },
      ],
    });
    const { entries, footers } = await loadEntryData(runtime, ctx, sermon);
    expect(entries[0]?.passages[0]?.text).toContain('O praise the LORD');
    expect(entries[1]?.passages[0]?.text).toBe('Give thanks.');
    expect(footers).toEqual([
      'source: live · revision 1 · fetched just now — KJV PSA 117',
      'source: live · revision 1 · fetched just now — KJV PSA 118',
    ]);
    expect(stderr()).toContain('KJV PSA 117: fetching (1/2)');
  });

  it('propagates chapter_not_in_store when told not to fetch what is missing', async () => {
    const { ctx, requests } = makeContext();
    const runtime = await createRuntime(ctx);
    await expect(loadEntryData(runtime, ctx, sermonWith(), { fetchMissing: false })).rejects.toMatchObject({
      code: 'chapter_not_in_store',
    });
    expect(requests).toEqual([]);
  });

  it('distinguishes a stored chapter from one it just fetched, footer by footer', async () => {
    const { ctx, dataDir } = makeContext({
      responses: {
        [chapterUrl(1, 'KJV', 'PSA', '118')]: { status: 200, body: chapterHtml('PSA', '118', { '1': 'Give thanks.' }) },
      },
    });
    await seedStore(dataDir, 'KJV', [{ book: 'PSA', chapter: '117', verses: psalm117 }]);
    const runtime = await createRuntime(ctx);
    const sermon = sermonWith({
      entries: [
        { book: 'PSA', chapter: 117, verses: [1], offsets: {} },
        { book: 'PSA', chapter: 118, verses: [1], offsets: {} },
      ],
    });
    const { footers } = await loadEntryData(runtime, ctx, sermon);
    expect(footers).toEqual([
      'source: cache · revision 1 · fetched 2026-09-01 — KJV PSA 117',
      'source: live · revision 1 · fetched just now — KJV PSA 118',
    ]);
  });

  it('refetches with --refresh, notices unchanged content, and reports the fetch as live', async () => {
    const { ctx, dataDir, stderr } = makeContext({
      responses: {
        [chapterUrl(1, 'KJV', 'PSA', '117')]: { status: 200, body: chapterHtml('PSA', '117', psalm117) },
      },
    });
    await seedStore(dataDir, 'KJV', [{ book: 'PSA', chapter: '117', verses: psalm117 }]);
    const runtime = await createRuntime(ctx);
    const { footers } = await loadEntryData(runtime, ctx, sermonWith(), { refresh: true });
    expect(footers).toEqual(['source: live · revision 1 · fetched just now — KJV PSA 117']);
    expect(stderr()).toContain('KJV PSA 117: content unchanged, no new revision.');
  });

  it('creates a new revision with --refresh when content changed', async () => {
    const changed = { ...psalm117, '2': 'For his merciful kindness is GREAT.' };
    const { ctx, dataDir, stderr } = makeContext({
      responses: {
        [chapterUrl(1, 'KJV', 'PSA', '117')]: { status: 200, body: chapterHtml('PSA', '117', changed) },
      },
    });
    await seedStore(dataDir, 'KJV', [{ book: 'PSA', chapter: '117', verses: psalm117 }]);
    const runtime = await createRuntime(ctx);
    const { entries } = await loadEntryData(runtime, ctx, sermonWith(), { refresh: true });
    expect(entries[0]?.passages[0]?.revision).toBe(2);
    expect(stderr()).not.toContain('content unchanged');
  });
});

describe('loadEntryData (server mode)', () => {
  const base = 'https://holydeck.example.com';
  const canon = {
    books: [{ usfm: 'PSA', canon: 'ot', name: 'Psalms', chapters: [{ id: 'PSA.117', label: '117' }] }],
  };

  it('fabricates store files from server responses, pre-shifting offsets', async () => {
    const { ctx, requests } = makeContext({
      responses: {
        [`${base}/api/v1/translations/KJV/canon`]: { status: 200, body: JSON.stringify(canon) },
        [`${base}/api/v1/translations/KJV/verses?book=PSA&chapter=117&verses=2-3`]: {
          status: 200,
          body: JSON.stringify({
            verses: { '2': 'shifted one', '3': 'shifted two' },
            citation: 'Psalms 117:1-2',
            revision: 7,
            fetchedAt: '2026-09-05T08:00:00.000Z',
            source: 'cache',
          }),
        },
      },
    });
    const runtime = await createRuntime(ctx, { serverUrl: base });
    const sermon = sermonWith({
      entries: [{ book: 'PSA', chapter: 117, verses: [1, 2], offsets: { KJV: 1 } }],
    });
    const { entries, footers } = await loadEntryData(runtime, ctx, sermon);
    expect(entries[0]?.passages[0]?.text).toBe('shifted one shifted two');
    expect(entries[0]?.passages[0]?.citation).toBe('Psalms 117:1-2'); // unshifted, from the fabricated store's canon
    expect(entries[0]?.passages[0]?.revision).toBe(7);
    expect(footers).toEqual(['source: cache · revision 7 · fetched 2026-09-05 — KJV PSA 117']);
    expect(requests.some((url) => url.includes('verses=2-3'))).toBe(true);
  });

  it('marks a live-fetched passage in its footer and forwards refresh', async () => {
    const { ctx, requests } = makeContext({
      responses: {
        [`${base}/api/v1/translations/KJV/canon`]: { status: 200, body: JSON.stringify(canon) },
        [`${base}/api/v1/translations/KJV/verses?book=PSA&chapter=117&verses=1-2&refresh=true`]: {
          status: 200,
          body: JSON.stringify({
            verses: { '1': 'fresh one', '2': 'fresh two' },
            citation: 'Psalms 117:1-2',
            revision: 8,
            fetchedAt: '2026-09-08T00:00:00.000Z',
            source: 'live',
          }),
        },
      },
    });
    const runtime = await createRuntime(ctx, { serverUrl: base });
    const { footers } = await loadEntryData(runtime, ctx, sermonWith(), { refresh: true });
    expect(footers).toEqual(['source: live · revision 8 · fetched just now — KJV PSA 117']);
    expect(requests.some((url) => url.includes('refresh=true'))).toBe(true);
  });

  it('forwards the fetch-missing opt-out so the server refuses instead of fetching', async () => {
    const { ctx, requests } = makeContext({
      responses: {
        [`${base}/api/v1/translations/KJV/canon`]: { status: 200, body: JSON.stringify(canon) },
        [`${base}/api/v1/translations/KJV/verses?book=PSA&chapter=117&verses=1-2&fetchMissing=false`]: {
          status: 404,
          body: JSON.stringify({ error: { code: 'chapter_not_in_store', message: 'KJV PSA 117 is not stored.' } }),
        },
      },
    });
    const runtime = await createRuntime(ctx, { serverUrl: base });
    await expect(loadEntryData(runtime, ctx, sermonWith(), { fetchMissing: false })).rejects.toMatchObject({
      code: 'server_error',
    });
    expect(requests.some((url) => url.includes('fetchMissing=false'))).toBe(true);
  });

  it('scopes requested verses to the matching chapter when the sermon spans multiple chapters', async () => {
    const twoChapterCanon = {
      books: [
        {
          usfm: 'PSA',
          canon: 'ot',
          name: 'Psalms',
          chapters: [
            { id: 'PSA.117', label: '117' },
            { id: 'PSA.118', label: '118' },
          ],
        },
      ],
    };
    const { ctx } = makeContext({
      responses: {
        [`${base}/api/v1/translations/KJV/canon`]: { status: 200, body: JSON.stringify(twoChapterCanon) },
        [`${base}/api/v1/translations/KJV/verses?book=PSA&chapter=117&verses=1`]: {
          status: 200,
          body: JSON.stringify({
            verses: { '1': 'one seventeen' },
            citation: 'Psalms 117:1',
            revision: 1,
            fetchedAt: '2026-09-05T08:00:00.000Z',
            source: 'live',
          }),
        },
        [`${base}/api/v1/translations/KJV/verses?book=PSA&chapter=118&verses=1`]: {
          status: 200,
          body: JSON.stringify({
            verses: { '1': 'one eighteen' },
            citation: 'Psalms 118:1',
            revision: 1,
            fetchedAt: '2026-09-05T08:00:00.000Z',
            source: 'live',
          }),
        },
      },
    });
    const runtime = await createRuntime(ctx, { serverUrl: base });
    const sermon = sermonWith({
      entries: [
        { book: 'PSA', chapter: 117, verses: [1], offsets: {} },
        { book: 'PSA', chapter: 118, verses: [1], offsets: {} },
      ],
    });
    const { entries } = await loadEntryData(runtime, ctx, sermon);
    expect(entries[0]?.passages[0]?.text).toBe('one seventeen');
    expect(entries[1]?.passages[0]?.text).toBe('one eighteen');
  });
});

describe('renderAndDeliver', () => {
  async function loaded(ctx: Parameters<typeof loadEntryData>[1], dataDir: string) {
    await seedStore(dataDir, 'KJV', [{ book: 'PSA', chapter: '117', verses: psalm117 }]);
    const runtime = await createRuntime(ctx);
    const sermon = sermonWith();
    return { runtime, sermon, data: await loadEntryData(runtime, ctx, sermon) };
  }

  it('renders the default template to stdout and footers to stderr', async () => {
    const { ctx, dataDir, stdout, stderr } = makeContext();
    const { runtime, sermon, data } = await loaded(ctx, dataDir);
    await renderAndDeliver(ctx, runtime, sermon, data);
    expect(stdout()).toContain('O praise the LORD, all ye nations.');
    expect(stdout()).toContain('Psalms 117:1-2 (KJV)');
    expect(stdout().endsWith('\n')).toBe(true);
    expect(stderr()).toContain('source: cache · revision 1 · fetched 2026-09-01 — KJV PSA 117');
    expect(stdout()).not.toContain('source: cache');
  });

  it('lets an explicit template beat the sermon template and pushes legacy notices to stderr', async () => {
    const { ctx, dataDir, stdout, stderr } = makeContext();
    const { runtime, sermon, data } = await loaded(ctx, dataDir);
    sermon.template = 'SERMON {{ entries | size }}';
    await renderAndDeliver(ctx, runtime, sermon, data, { template: '{0.passage}' });
    expect(stdout().trim()).toBe('O praise the LORD, all ye nations. For his merciful kindness is great.');
    expect(stderr()).toContain('legacy');
  });

  it('falls back to the sermon template, then the config template', async () => {
    const { ctx, dataDir, stdout } = makeContext({ env: { HOLYDECK_TEMPLATE: 'CONFIG' } });
    const { runtime, sermon, data } = await loaded(ctx, dataDir);
    await renderAndDeliver(ctx, runtime, sermon, data);
    expect(stdout().trim()).toBe('CONFIG');
    sermon.template = 'SERMON';
    await renderAndDeliver(ctx, runtime, sermon, data);
    expect(stdout()).toContain('SERMON');
  });

  it('writes --output to a file and keeps stdout empty', async () => {
    const { ctx, dataDir, stdout } = makeContext();
    const { runtime, sermon, data } = await loaded(ctx, dataDir);
    await renderAndDeliver(ctx, runtime, sermon, data, { output: 'out.txt' });
    expect(stdout()).toBe('');
    expect(readFileSync(join(ctx.cwd, 'out.txt'), 'utf8')).toContain('Psalms 117:1-2 (KJV)');
  });

  it('copies with --copy and confirms on stderr', async () => {
    const { ctx, dataDir, copies, stderr } = makeContext();
    const { runtime, sermon, data } = await loaded(ctx, dataDir);
    await renderAndDeliver(ctx, runtime, sermon, data, { copy: true });
    expect(copies).toHaveLength(1);
    expect(copies[0]).toContain('O praise the LORD');
    expect(stderr()).toContain('Copied to clipboard.');
  });
});
