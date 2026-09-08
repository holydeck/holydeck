import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { BrowserLauncher, BrowserSession } from '@holydeck/core/browser-fetch';
import type { HttpGet } from '@holydeck/core/fetcher';
import { FileStore } from '@holydeck/core/file-store';
import { createEmptyStoreFile } from '@holydeck/core/storage';
import type { VerseMap } from '@holydeck/core/storage';
import type { Canon, TranslationMeta } from '@holydeck/core/canon';
import type { CliContext } from '../src/context.js';
import type { HttpPost } from '../src/server-client.js';

export const FIXED_NOW = '2026-09-08T12:00:00.000Z';
export const SEED_TIME = '2026-09-01T00:00:00.000Z';

export interface CannedResponse {
  status: number;
  body: string;
}

export interface MakeContextOptions {
  /** Extra env on top of HOLYDECK_DATA_DIR (set undefined to unset that default). */
  env?: Record<string, string | undefined>;
  /** Canned HTTP responses keyed by URL (GET) or `POST <url>`. */
  responses?: Record<string, CannedResponse>;
  overrides?: Partial<CliContext>;
}

export interface TestSetup {
  ctx: CliContext;
  home: string;
  dataDir: string;
  stdout: () => string;
  stderr: () => string;
  copies: string[];
  edits: string[];
  requests: string[];
}

export function makeContext(options: MakeContextOptions = {}): TestSetup {
  const home = mkdtempSync(join(tmpdir(), 'holydeck-cli-'));
  const dataDir = join(home, 'data');
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const copies: string[] = [];
  const edits: string[] = [];
  const requests: string[] = [];
  const env: Record<string, string | undefined> = { HOLYDECK_DATA_DIR: dataDir, ...options.env };
  const responses = options.responses ?? {};
  const httpGet: HttpGet = async (url) => {
    requests.push(url);
    const response = responses[url];
    if (!response) throw new Error(`no canned response for GET ${url}`);
    return response;
  };
  const httpPost: HttpPost = async (url, body) => {
    requests.push(`POST ${url} ${body}`);
    const response = responses[`POST ${url}`];
    if (!response) throw new Error(`no canned response for POST ${url}`);
    return response;
  };
  const ctx: CliContext = {
    platform: { platform: 'linux', env, homeDir: home },
    cwd: home,
    isTTY: false,
    out: (text) => {
      outChunks.push(text);
    },
    err: (text) => {
      errChunks.push(text);
    },
    clipboard: async (text) => {
      copies.push(text);
    },
    editor: async (path) => {
      edits.push(path);
      return 'opened';
    },
    httpGet,
    httpPost,
    now: () => new Date(FIXED_NOW),
    sleep: async () => {},
    ...options.overrides,
  };
  return {
    ctx,
    home,
    dataDir,
    stdout: () => outChunks.join(''),
    stderr: () => errChunks.join(''),
    copies,
    edits,
    requests,
  };
}

/** A browser launcher whose page answers every in-page fetch with the same canned body. */
export function fakeLauncher(body: string): BrowserLauncher & { closed: () => number } {
  const close = vi.fn().mockResolvedValue(undefined);
  const page = {
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({ status: 200, body }),
  };
  const session = { newPage: vi.fn().mockResolvedValue(page), close } as unknown as BrowserSession;
  const launcher = async (): Promise<BrowserSession> => session;
  return Object.assign(launcher, { closed: () => close.mock.calls.length });
}

/** Seed the local datastore with synthetic chapters (fetchedAt = SEED_TIME). */
export async function seedStore(
  dataDir: string,
  abbr: string,
  chapters: Array<{ book: string; chapter: string; verses: VerseMap; canonVerseCount?: number }>,
  extras: { canon?: Canon; meta?: TranslationMeta } = {},
): Promise<void> {
  const store = new FileStore(dataDir, { now: () => SEED_TIME });
  const file = (await store.load(abbr)) ?? createEmptyStoreFile(abbr, SEED_TIME);
  if (extras.canon) file.canon = extras.canon;
  if (extras.meta) file.meta = extras.meta;
  for (const chapter of chapters) {
    store.putChapterInFile(file, chapter.book, chapter.chapter, chapter.verses, chapter.canonVerseCount ?? Object.keys(chapter.verses).length);
  }
  await store.save(abbr, file);
}

/** Synthetic bible.com chapter HTML the core scraper parses (class SUFFIX matching). */
export function chapterHtml(book: string, chapter: string, verses: VerseMap): string {
  const spans = Object.entries(verses)
    .map(
      ([verse, text]) =>
        `<span class="ChapterContent-module__zz1__verse" data-usfm="${book}.${chapter}.${verse}">` +
        `<span class="ChapterContent-module__zz2__content">${text}</span></span>`,
    )
    .join('');
  return `<html><body><div class="ChapterContent_chapter__zz0">${spans}</div></body></html>`;
}

/** Synthetic bible.com version-API JSON (snake_case, shape from the Phase 1 spike facts). */
export function versionMetaJson(
  options: {
    id?: number;
    abbreviation?: string;
    metadataBuild?: number;
    books?: Array<{ usfm: string; name: string; chapters: string[] }>;
  } = {},
): string {
  const id = options.id ?? 1;
  const abbreviation = options.abbreviation ?? 'KJV';
  const books = options.books ?? [{ usfm: 'GEN', name: 'Genesis', chapters: ['1', '2'] }];
  return JSON.stringify({
    id,
    abbreviation,
    local_abbreviation: abbreviation,
    title: `${abbreviation} Test Bible`,
    local_title: `${abbreviation} Test Bible`,
    language: {
      iso_639_1: 'en',
      iso_639_3: 'eng',
      name: 'English',
      local_name: 'English',
      text_direction: 'ltr',
      language_tag: 'en',
    },
    metadata_build: options.metadataBuild ?? 51,
    books: books.map((book) => ({
      usfm: book.usfm,
      canon: 'ot',
      human: book.name,
      human_long: book.name,
      abbreviation: book.usfm,
      text: true,
      audio: false,
      chapters: book.chapters.map((label) => ({
        usfm: `${book.usfm}.${label}`,
        human: label,
        canonical: true,
        toc: true,
      })),
    })),
  });
}
