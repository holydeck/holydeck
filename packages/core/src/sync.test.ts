import { readFileSync } from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseVersionMeta } from './canon.js';
import { Fetcher } from './fetcher.js';
import type { HttpGet } from './fetcher.js';
import { FileStore } from './file-store.js';
import { appendRevision, createEmptyStoreFile } from './storage.js';
import type { TranslationStoreFile } from './storage.js';
import { syncTranslation } from './sync.js';
import type { SyncStore } from './sync.js';

const versionJson = readFileSync(new URL('../test/fixtures/version-1-kjv.json', import.meta.url), 'utf8');

function chapterHtml(book: string, chapter: string, text: string): string {
  return `<div><span class="X__verse" data-usfm="${book}.${chapter}.1"><span class="X__content">${text}</span></span></div>`;
}

let dir: string;
let store: FileStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'holydeck-sync-'));
  let tick = 0;
  store = new FileStore(dir, { now: () => `2026-09-07T12:00:${String((tick += 1) % 60).padStart(2, '0')}.000Z`, lockTimeoutMs: 300, lockPollMs: 20 });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stubFetcher(handler: (url: string) => { status: number; body: string } | Error): { fetcher: Fetcher; urls: string[] } {
  const urls: string[] = [];
  const httpGet: HttpGet = async (url) => {
    urls.push(url);
    const result = handler(url);
    if (result instanceof Error) throw result;
    return result;
  };
  return { fetcher: new Fetcher({ httpGet, sleep: async () => {}, backoffMs: 1, retries: 0 }), urls };
}

const versionOk = (url: string): { status: number; body: string } | undefined =>
  url.includes('/api/bible/version/') ? { status: 200, body: versionJson } : undefined;

describe('planSync', () => {
  it('plans every canon chapter for an empty store and only missing ones after', async () => {
    const { fetcher } = stubFetcher((url) => versionOk(url) ?? { status: 200, body: chapterHtml('GEN', '1', 'text') });
    const dry = await syncTranslation(store, fetcher, 'KJV', { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.planned).toBe(1189);
    expect(dry.plan?.[0]).toEqual({ book: 'GEN', chapter: '1', reason: 'missing' });
    expect(dry.fetched).toBe(0);
    await expect(store.load('KJV')).resolves.toBeUndefined(); // dry run writes nothing
  });

  it('marks existing chapters as refresh only when refresh=true', async () => {
    await store.putChapter('KJV', 'GEN', '1', { '1': 'existing' }, 1);
    const { fetcher } = stubFetcher((url) => versionOk(url) ?? { status: 200, body: chapterHtml('GEN', '1', 'x') });
    const withoutRefresh = await syncTranslation(store, fetcher, 'KJV', { dryRun: true });
    expect(withoutRefresh.planned).toBe(1188);
    const withRefresh = await syncTranslation(store, fetcher, 'KJV', { dryRun: true, refresh: true });
    expect(withRefresh.planned).toBe(1189);
    expect(withRefresh.plan?.find((item) => item.book === 'GEN' && item.chapter === '1')?.reason).toBe('refresh');
  });
});

describe('syncTranslation', () => {
  it('fetches planned chapters, stores revisions, persists metadata, reports progress', async () => {
    const { fetcher, urls } = stubFetcher((url) => {
      const fromVersion = versionOk(url);
      if (fromVersion) return fromVersion;
      const match = /bible\/1\/([A-Z1-3]+)\.(\d+)\.KJV$/.exec(url);
      return { status: 200, body: chapterHtml(match![1]!, match![2]!, `words of ${match![1]} ${match![2]}`) };
    });
    const progress = vi.fn();
    const report = await syncTranslation(store, fetcher, 'kjv', { delayMs: 0, onProgress: progress });
    expect(report.translation).toBe('KJV');
    expect(report.planned).toBe(1189);
    expect(report.fetched).toBe(1189);
    expect(report.newRevisions).toHaveLength(1189);
    expect(report.failed).toHaveLength(0);
    expect(progress).toHaveBeenCalledTimes(1189);
    expect(urls[0]).toBe('https://www.bible.com/api/bible/version/1');
    const file = await store.load('KJV');
    expect(file?.meta?.metadataBuild).toBe(51);
    expect(file?.canon?.books).toHaveLength(66);
    expect(file?.books.PSA?.chapters['117']?.revisions[0]?.verses['1']).toBe('words of PSA 117');
  });

  it('counts unchanged chapters on a refresh pass and reports metadataBuildChanged', { timeout: 20_000 }, async () => {
    const { fetcher } = stubFetcher((url) => {
      const fromVersion = versionOk(url);
      if (fromVersion) return fromVersion;
      const match = /bible\/1\/([A-Z1-3]+)\.(\d+)\.KJV$/.exec(url);
      return { status: 200, body: chapterHtml(match![1]!, match![2]!, `stable ${match![1]} ${match![2]}`) };
    });
    await syncTranslation(store, fetcher, 'KJV', { delayMs: 0 });
    const file = await store.load('KJV');
    file!.meta!.metadataBuild = 50; // simulate an older stored build
    await store.save('KJV', file!);
    const second = await syncTranslation(store, fetcher, 'KJV', { delayMs: 0, refresh: true });
    expect(second.fetched).toBe(1189);
    expect(second.unchanged).toBe(1189);
    expect(second.newRevisions).toHaveLength(0);
    expect(second.metadataBuildChanged).toEqual({ from: 50, to: 51 });
  });

  it('records per-chapter failures and continues', { timeout: 20_000 }, async () => {
    const { fetcher } = stubFetcher((url) => {
      const fromVersion = versionOk(url);
      if (fromVersion) return fromVersion;
      const match = /bible\/1\/([A-Z1-3]+)\.(\d+)\.KJV$/.exec(url);
      if (match![1] === 'GEN') return { status: 404, body: 'nope' };
      return { status: 200, body: chapterHtml(match![1]!, match![2]!, 'ok') };
    });
    const report = await syncTranslation(store, fetcher, 'KJV', { delayMs: 0 });
    expect(report.failed).toHaveLength(50); // all of Genesis
    expect(report.failed[0]).toEqual({ book: 'GEN', chapter: '1', code: 'scrape_http_error' });
    expect(report.fetched).toBe(1189 - 50);
  });

  it('stops scheduling new fetches after scrape_blocked', async () => {
    let chapterCalls = 0;
    const { fetcher } = stubFetcher((url) => {
      const fromVersion = versionOk(url);
      if (fromVersion) return fromVersion;
      chapterCalls += 1;
      return { status: 200, body: '<title>Client Challenge</title>' };
    });
    const report = await syncTranslation(store, fetcher, 'KJV', { delayMs: 0, concurrency: 1 });
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.code).toBe('scrape_blocked');
    expect(chapterCalls).toBe(1); // no further chapters attempted
  });

  it('propagates version metadata failures without touching the store', async () => {
    const { fetcher } = stubFetcher(() => ({ status: 500, body: 'down' }));
    await expect(syncTranslation(store, fetcher, 'KJV', { delayMs: 0 })).rejects.toMatchObject({ code: 'scrape_http_error' });
    await expect(store.load('KJV')).resolves.toBeUndefined();
  });

  it('sleeps delayMs between fetches (politeness throttle)', async () => {
    const sleeps: number[] = [];
    const { fetcher } = stubFetcher((url) => versionOk(url) ?? { status: 200, body: chapterHtml('GEN', '1', 'x') });
    await syncTranslation(store, fetcher, 'KJV', {
      delayMs: 250,
      concurrency: 1,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(sleeps.filter((ms) => ms === 250)).toHaveLength(1188); // every chapter after the first
  });

  it('rejects unknown translations', async () => {
    const { fetcher } = stubFetcher(() => ({ status: 200, body: '' }));
    await expect(syncTranslation(store, fetcher, 'NOPE')).rejects.toMatchObject({ code: 'unknown_translation' });
  });

  it('skips the metadata refetch on a dry run when the store already has a canon', async () => {
    const { meta, canon } = parseVersionMeta(JSON.parse(versionJson));
    const file = createEmptyStoreFile('KJV', store.now());
    file.meta = meta;
    file.canon = canon;
    await store.save('KJV', file);
    const { fetcher, urls } = stubFetcher((url) => versionOk(url) ?? { status: 200, body: chapterHtml('GEN', '1', 'x') });
    const dry = await syncTranslation(store, fetcher, 'KJV', { dryRun: true });
    expect(urls).toHaveLength(0); // no version fetch needed — canon already on disk
    expect(dry.planned).toBe(1189);
  });

  it('treats a null canon on disk as missing and refetches metadata on a dry run', async () => {
    const path = store.translationPath('KJV');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 1, translation: 'KJV', updatedAt: store.now(), canon: null, books: {} }),
      'utf8',
    );
    const { fetcher, urls } = stubFetcher((url) => versionOk(url) ?? { status: 200, body: chapterHtml('GEN', '1', 'x') });
    const dry = await syncTranslation(store, fetcher, 'KJV', { dryRun: true });
    expect(urls).toContain('https://www.bible.com/api/bible/version/1'); // null canon is treated as missing — refetch happens
    expect(dry.planned).toBe(1189);
    expect(dry.plan?.[0]).toEqual({ book: 'GEN', chapter: '1', reason: 'missing' });
  });

  it('uses the default real-time sleep between fetches when no custom sleep is supplied', async () => {
    const { meta, canon } = parseVersionMeta(JSON.parse(versionJson));
    const file = createEmptyStoreFile('KJV', store.now());
    file.meta = meta;
    file.canon = canon;
    for (const book of canon.books) {
      file.books[book.usfm] = { chapters: {} };
      for (const chapter of book.chapters) {
        if (book.usfm === 'GEN' && (chapter.id === '1' || chapter.id === '2')) continue;
        file.books[book.usfm]!.chapters[chapter.id] = {
          canonVerseCount: 1,
          revisions: [{ rev: 1, fetchedAt: store.now(), contentHash: 'seed', verses: { '1': 'seed' } }],
        };
      }
    }
    await store.save('KJV', file);
    const { fetcher } = stubFetcher((url) => {
      const fromVersion = versionOk(url);
      if (fromVersion) return fromVersion;
      const match = /bible\/1\/([A-Z1-3]+)\.(\d+)\.KJV$/.exec(url);
      return { status: 200, body: chapterHtml(match![1]!, match![2]!, 'x') };
    });
    const report = await syncTranslation(store, fetcher, 'KJV', { concurrency: 1, delayMs: 5 });
    expect(report.planned).toBe(2);
    expect(report.fetched).toBe(2);
  });

  it('rethrows a non-HolyDeckError raised while fetching a chapter', async () => {
    const { fetcher } = stubFetcher((url) => versionOk(url) ?? { status: 200, body: chapterHtml('GEN', '1', 'x') });
    vi.spyOn(fetcher, 'fetchChapter').mockRejectedValue(new Error('boom'));
    await expect(syncTranslation(store, fetcher, 'KJV', { delayMs: 0, concurrency: 1 })).rejects.toThrow('boom');
  });
});

function memoryStore(): { store: SyncStore; files: Map<string, TranslationStoreFile>; lockLog: string[] } {
  const files = new Map<string, TranslationStoreFile>();
  const lockLog: string[] = [];
  let tick = 0;
  const store: SyncStore = {
    now: () => `2026-09-08T13:00:${String((tick += 1) % 60).padStart(2, '0')}.000Z`,
    load: async (abbr) => structuredClone(files.get(abbr.toUpperCase())),
    save: async (abbr, file) => {
      files.set(abbr.toUpperCase(), structuredClone(file));
    },
    withLock: async (abbr, fn) => {
      lockLog.push(`lock:${abbr}`);
      try {
        return await fn();
      } finally {
        lockLog.push(`unlock:${abbr}`);
      }
    },
    putChapterInFile: (file, book, chapter, verses, canonVerseCount) => {
      const bookRecord = (file.books[book] ??= { chapters: {} });
      const { record, changed, rev } = appendRevision(bookRecord.chapters[chapter], verses, canonVerseCount, store.now());
      bookRecord.chapters[chapter] = record;
      return { changed, rev };
    },
  };
  return { store, files, lockLog };
}

describe('SyncStore contract', () => {
  it('runs the whole engine against a non-file store implementation', async () => {
    const { store: memory, files, lockLog } = memoryStore();
    const { fetcher } = stubFetcher((url) => {
      const fromVersion = versionOk(url);
      if (fromVersion) return fromVersion;
      const match = /bible\/1\/([A-Z1-3]+)\.(\d+)\.KJV$/.exec(url);
      return { status: 200, body: chapterHtml(match![1]!, match![2]!, `memory ${match![1]} ${match![2]}`) };
    });
    const report = await syncTranslation(memory, fetcher, 'kjv', { delayMs: 0 });
    expect(report.translation).toBe('KJV');
    expect(report.fetched).toBe(1189);
    expect(lockLog).toEqual(['lock:KJV', 'unlock:KJV']);
    expect(files.get('KJV')?.books.PSA?.chapters['117']?.revisions[0]?.verses['1']).toBe('memory PSA 117');
  });

  it('FileStore satisfies SyncStore structurally (compile-time check)', () => {
    const asSyncStore: SyncStore = store;
    expect(asSyncStore.now()).toMatch(/^2026-/);
  });
});
