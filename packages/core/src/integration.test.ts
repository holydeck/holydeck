import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assembleEntries } from './assemble.js';
import { FileStore } from './file-store.js';
import { parseChapterHtml } from './scraper.js';
import { parseSermonFile } from './sermon.js';
import { renderOutput, LEGACY_DEFAULT_TEMPLATE } from './template.js';

const psa117 = readFileSync(new URL('../test/fixtures/kjv-psa117.html', import.meta.url), 'utf8');
const gen1 = readFileSync(new URL('../test/fixtures/kjv-gen1.html', import.meta.url), 'utf8');

const dir = mkdtempSync(join(tmpdir(), 'holydeck-e2e-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('core end-to-end', () => {
  it('scrape → store → sermon → assemble → render', async () => {
    const store = new FileStore(dir, { now: () => '2026-09-07T15:00:00.000Z' });

    const psa = parseChapterHtml(psa117, 'PSA', '117');
    const gen = parseChapterHtml(gen1, 'GEN', '1');
    await store.putChapter('KJV', 'PSA', '117', psa.verses, psa.canonVerseCount);
    await store.putChapter('KJV', 'GEN', '1', gen.verses, gen.canonVerseCount);

    const sermon = parseSermonFile(
      [
        'translations:',
        '  - KJV',
        'verses:',
        '  - book: PSA',
        '    chapter: 117',
        '    verses: 1-2',
        '  - book: GEN',
        '    chapter: 1',
        '    verses: 1',
      ].join('\n'),
    );

    const kjv = await store.load('KJV');
    const entries = assembleEntries(sermon, { KJV: kjv });

    const modern = await renderOutput(undefined, entries);
    expect(modern).toBe(
      [
        'O praise the LORD, All ye nations: Praise him, all ye people. For his merciful kindness is great toward us: And the truth of the LORD endureth for ever. Praise ye the LORD.',
        'Psalms 117:1-2 (KJV)',
        '',
        'In the beginning God created the heaven and the earth.',
        'Genesis 1:1 (KJV)',
        '',
        '',
      ].join('\n'),
    );

    const legacy = await renderOutput(LEGACY_DEFAULT_TEMPLATE, entries);
    expect(legacy).toContain('O praise the LORD');
    expect(legacy).toContain('Genesis 1:1');
  });
});
