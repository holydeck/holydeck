import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chapterRefs, ensureChapters } from './fetch-missing.js';
import { Fetcher } from './fetcher.js';
import type { HttpGet } from './fetcher.js';
import { FileStore } from './file-store.js';
import type { SermonFile } from './sermon.js';
import { getChapter } from './storage.js';

const versionJson = readFileSync(new URL('../test/fixtures/version-1-kjv.json', import.meta.url), 'utf8');

function chapterHtml(book: string, chapter: string, text: string): string {
  return `<div><span class="X__verse" data-usfm="${book}.${chapter}.1"><span class="X__content">${text}</span></span></div>`;
}

let dir: string;
let store: FileStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'holydeck-ensure-'));
  let tick = 0;
  store = new FileStore(dir, {
    now: () => `2026-09-08T12:00:${String((tick += 1) % 60).padStart(2, '0')}.000Z`,
    lockTimeoutMs: 300,
    lockPollMs: 20,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stubFetcher(text = 'fetched text'): { fetcher: Fetcher; chapterUrls: string[] } {
  const chapterUrls: string[] = [];
  const httpGet: HttpGet = async (url) => {
    if (url.includes('/api/bible/version/')) return { status: 200, body: versionJson };
    chapterUrls.push(url);
    const [, book, chapter] = /\/bible\/\d+\/([A-Z0-9]+)\.(\d+)/.exec(url) ?? [];
    return { status: 200, body: chapterHtml(book ?? 'GEN', chapter ?? '1', text) };
  };
  return { fetcher: new Fetcher({ httpGet, sleep: async () => {}, backoffMs: 1, retries: 0 }), chapterUrls };
}

const sermonWith = (entries: Array<{ book: string; chapter: number }>): SermonFile => ({
  translations: ['KJV'],
  entries: entries.map((entry) => ({ ...entry, verses: [1], offsets: {} })),
  notices: [],
});

describe('chapterRefs', () => {
  it('lists each chapter once, in the order it is first referenced', () => {
    const sermon = sermonWith([
      { book: 'GEN', chapter: 30 },
      { book: 'PSA', chapter: 118 },
      { book: 'GEN', chapter: 30 },
    ]);
    expect(chapterRefs(sermon)).toEqual([
      { book: 'GEN', chapter: '30' },
      { book: 'PSA', chapter: '118' },
    ]);
  });
});

describe('ensureChapters', () => {
  it('fetches a chapter the datastore does not have and returns the stored result', async () => {
    const { fetcher, chapterUrls } = stubFetcher();
    const result = await ensureChapters(store, fetcher, 'KJV', [{ book: 'GEN', chapter: '30' }]);

    expect(result.fetched).toEqual([{ book: 'GEN', chapter: '30', changed: true, rev: 1 }]);
    expect(chapterUrls).toHaveLength(1);
    expect(getChapter(result.file, 'GEN', '30')?.revisions.at(-1)?.verses['1']).toBe('fetched text');
    await expect(store.load('KJV')).resolves.toBeDefined();
  });

  it('fetches nothing when every chapter is already stored', async () => {
    await store.putChapter('KJV', 'GEN', '30', { '1': 'already here' }, 1);
    const { fetcher, chapterUrls } = stubFetcher();
    const result = await ensureChapters(store, fetcher, 'KJV', [{ book: 'GEN', chapter: '30' }]);

    expect(result.fetched).toEqual([]);
    expect(chapterUrls).toEqual([]);
    expect(getChapter(result.file, 'GEN', '30')?.revisions.at(-1)?.verses['1']).toBe('already here');
  });

  it('leaves a missing chapter alone when fetchMissing is off', async () => {
    const { fetcher, chapterUrls } = stubFetcher();
    const result = await ensureChapters(store, fetcher, 'KJV', [{ book: 'GEN', chapter: '30' }], {
      fetchMissing: false,
    });

    expect(result).toEqual({ file: undefined, fetched: [] });
    expect(chapterUrls).toEqual([]);
  });

  it('refetches a stored chapter when refreshing, reporting identical content as unchanged', async () => {
    const { fetcher } = stubFetcher('same text');
    await ensureChapters(store, fetcher, 'KJV', [{ book: 'GEN', chapter: '30' }]);
    const again = await ensureChapters(store, fetcher, 'KJV', [{ book: 'GEN', chapter: '30' }], { refresh: true });

    expect(again.fetched).toEqual([{ book: 'GEN', chapter: '30', changed: false, rev: 1 }]);
  });

  it('reports each fetch as it starts, and accepts a lowercase abbreviation', async () => {
    const { fetcher } = stubFetcher();
    const seen: string[] = [];
    const result = await ensureChapters(
      store,
      fetcher,
      'kjv',
      [
        { book: 'GEN', chapter: '30' },
        { book: 'PSA', chapter: '118' },
      ],
      { onFetching: (ref, done, total) => seen.push(`${ref.book} ${ref.chapter} ${done}/${total}`) },
    );

    expect(seen).toEqual(['GEN 30 1/2', 'PSA 118 2/2']);
    expect(result.file?.translation).toBe('KJV');
  });
});
