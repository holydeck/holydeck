import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assembleEntries } from '@holydeck/core/assemble';
import { chapterRefs, ensureChapters } from '@holydeck/core/fetch-missing';
import type { ChapterRef } from '@holydeck/core/fetch-missing';
import { formatMessage } from '@holydeck/core/messages';
import type { SermonFile } from '@holydeck/core/sermon';
import { contentHash, createEmptyStoreFile, getChapter, latestRevision } from '@holydeck/core/storage';
import type { ChapterRecord, TranslationStoreFile } from '@holydeck/core/storage';
import type { EntryData } from '@holydeck/core/template';
import { renderOutput } from '@holydeck/core/template';
import { errLine } from './context.js';
import type { CliContext } from './context.js';
import type { Runtime } from './runtime.js';
import { startSpinner } from './spinner.js';
import type { Spinner } from './spinner.js';

export interface LoadedPassages {
  entries: EntryData[];
  footers: string[];
}

export interface DeliverOptions {
  template?: string;
  copy?: boolean;
  output?: string;
}

interface LoadOptions {
  refresh: boolean;
  fetchMissing: boolean;
}

function shiftedVerses(sermon: SermonFile, abbr: string, ref: ChapterRef): number[] {
  const verses = new Set<number>();
  for (const entry of sermon.entries) {
    if (entry.book !== ref.book || String(entry.chapter) !== ref.chapter) continue;
    const offset = entry.offsets[abbr] ?? 0;
    for (const verse of entry.verses) verses.add(verse + offset);
  }
  return [...verses].sort((a, b) => a - b);
}

function footerFor(abbr: string, ref: ChapterRef, rev: number, fetchedAt: string, live: boolean): string {
  return formatMessage(live ? 'live_footer' : 'cache_footer', {
    rev,
    date: fetchedAt.slice(0, 10),
    abbr,
    book: ref.book,
    chapter: ref.chapter,
  });
}

async function loadLocal(
  runtime: Runtime,
  ctx: CliContext,
  sermon: SermonFile,
  options: LoadOptions,
): Promise<LoadedPassages> {
  const storeFiles: Record<string, TranslationStoreFile | undefined> = {};
  const footers: string[] = [];
  const chapters = chapterRefs(sermon);
  for (const abbr of sermon.translations) {
    // Fetching a chapter can mean starting a browser, so say which one is holding things up.
    let spinner: Spinner | undefined;
    const { file, fetched } = await ensureChapters(runtime.store, runtime.fetcher, abbr, chapters, {
      refresh: options.refresh,
      fetchMissing: options.fetchMissing,
      onFetching: (ref, done, total) => {
        const text = `${abbr} ${ref.book} ${ref.chapter}: fetching (${done}/${total})`;
        if (spinner === undefined) spinner = startSpinner(ctx, text);
        else spinner.label(text);
      },
      onCanonUnavailable: (reason) => {
        errLine(ctx, formatMessage('canon_unavailable', { abbr, reason }));
      },
    }).finally(() => {
      spinner?.stop();
    });
    for (const item of fetched) {
      if (!item.changed) {
        errLine(ctx, formatMessage('refresh_unchanged', { abbr, book: item.book, chapter: item.chapter }));
      }
    }
    storeFiles[abbr] = file;
    // Every chapter reports where its text came from; a spinner clears itself, a footer stays.
    const live = new Set(fetched.map((item) => `${item.book}.${item.chapter}`));
    for (const ref of chapters) {
      const record = getChapter(file, ref.book, ref.chapter);
      const revision = record ? latestRevision(record) : undefined;
      if (revision) {
        footers.push(footerFor(abbr, ref, revision.rev, revision.fetchedAt, live.has(`${ref.book}.${ref.chapter}`)));
      }
    }
  }
  return { entries: assembleEntries(sermon, storeFiles), footers };
}

async function loadServer(
  runtime: Runtime,
  ctx: CliContext,
  sermon: SermonFile,
  options: LoadOptions,
): Promise<LoadedPassages> {
  const server = runtime.server;
  /* v8 ignore next -- loadEntryData only routes here in server mode */
  if (!server) throw new Error('loadServer requires server mode');
  const storeFiles: Record<string, TranslationStoreFile | undefined> = {};
  const footers: string[] = [];
  const chapters = chapterRefs(sermon);
  for (const abbr of sermon.translations) {
    const file = createEmptyStoreFile(abbr, ctx.now().toISOString());
    for (const ref of chapters) {
      const verses = shiftedVerses(sermon, abbr, ref);
      const response = await server.getVerses(abbr, ref.book, Number(ref.chapter), verses, {
        refresh: options.refresh,
        fetchMissing: options.fetchMissing,
      });
      const record: ChapterRecord = {
        canonVerseCount: Math.max(...verses),
        revisions: [
          {
            rev: response.revision,
            fetchedAt: response.fetchedAt,
            contentHash: contentHash(response.verses),
            verses: response.verses,
          },
        ],
      };
      const book = (file.books[ref.book] ??= { chapters: {} });
      book.chapters[ref.chapter] = record;
      footers.push(footerFor(abbr, ref, response.revision, response.fetchedAt, response.source === 'live'));
    }
    // Asked after the verses: a chapter fetched just now teaches the server the translation's
    // own canon, and that is what names the books of this very render.
    file.canon = await server.getCanon(abbr);
    storeFiles[abbr] = file;
  }
  return { entries: assembleEntries(sermon, storeFiles), footers };
}

export async function loadEntryData(
  runtime: Runtime,
  ctx: CliContext,
  sermon: SermonFile,
  options: { refresh?: boolean; fetchMissing?: boolean } = {},
): Promise<LoadedPassages> {
  const resolved: LoadOptions = {
    refresh: options.refresh === true,
    fetchMissing: options.fetchMissing !== false,
  };
  return runtime.mode === 'server'
    ? loadServer(runtime, ctx, sermon, resolved)
    : loadLocal(runtime, ctx, sermon, resolved);
}

export async function renderAndDeliver(
  ctx: CliContext,
  runtime: Runtime,
  sermon: SermonFile,
  loaded: LoadedPassages,
  options: DeliverOptions = {},
): Promise<string> {
  const template = options.template ?? sermon.template ?? runtime.config.values.template;
  const notices: string[] = [];
  const output = await renderOutput(template, loaded.entries, notices);
  for (const notice of notices) errLine(ctx, notice);
  if (options.output !== undefined) {
    await writeFile(resolve(ctx.cwd, options.output), output, 'utf8');
  } else {
    ctx.out(output.endsWith('\n') ? output : `${output}\n`);
  }
  if (options.copy === true) {
    await ctx.clipboard(output);
    errLine(ctx, formatMessage('copied_to_clipboard'));
  }
  for (const footer of loaded.footers) errLine(ctx, footer);
  return output;
}
