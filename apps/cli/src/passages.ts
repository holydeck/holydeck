import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assembleEntries } from '@holydeck/core/assemble';
import { formatMessage } from '@holydeck/core/messages';
import type { SermonFile } from '@holydeck/core/sermon';
import { contentHash, createEmptyStoreFile, getChapter, latestRevision } from '@holydeck/core/storage';
import type { ChapterRecord, TranslationStoreFile } from '@holydeck/core/storage';
import type { EntryData } from '@holydeck/core/template';
import { renderOutput } from '@holydeck/core/template';
import { translationId } from '@holydeck/core/translations';
import { errLine } from './context.js';
import type { CliContext } from './context.js';
import type { Runtime } from './runtime.js';

export interface LoadedPassages {
  entries: EntryData[];
  footers: string[];
}

export interface DeliverOptions {
  template?: string;
  copy?: boolean;
  output?: string;
}

interface ChapterRef {
  book: string;
  chapter: number;
}

function uniqueChapters(sermon: SermonFile): ChapterRef[] {
  const seen = new Set<string>();
  const chapters: ChapterRef[] = [];
  for (const entry of sermon.entries) {
    const key = `${entry.book}.${entry.chapter}`;
    if (!seen.has(key)) {
      seen.add(key);
      chapters.push({ book: entry.book, chapter: entry.chapter });
    }
  }
  return chapters;
}

function shiftedVerses(sermon: SermonFile, abbr: string, ref: ChapterRef): number[] {
  const verses = new Set<number>();
  for (const entry of sermon.entries) {
    if (entry.book !== ref.book || entry.chapter !== ref.chapter) continue;
    const offset = entry.offsets[abbr] ?? 0;
    for (const verse of entry.verses) verses.add(verse + offset);
  }
  return [...verses].sort((a, b) => a - b);
}

function footerFor(abbr: string, ref: ChapterRef, rev: number, fetchedAt: string): string {
  return formatMessage('cache_footer', {
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
  refresh: boolean,
): Promise<LoadedPassages> {
  const storeFiles: Record<string, TranslationStoreFile | undefined> = {};
  const footers: string[] = [];
  const chapters = uniqueChapters(sermon);
  for (const abbr of sermon.translations) {
    if (refresh) {
      const id = translationId(abbr);
      for (const ref of chapters) {
        const parsed = await runtime.fetcher.fetchChapter(id, abbr, ref.book, String(ref.chapter));
        const result = await runtime.store.putChapter(abbr, ref.book, String(ref.chapter), parsed.verses, parsed.canonVerseCount);
        if (!result.changed) {
          errLine(ctx, formatMessage('refresh_unchanged', { abbr, book: ref.book, chapter: ref.chapter }));
        }
      }
    }
    const file = await runtime.store.load(abbr);
    storeFiles[abbr] = file;
    if (!refresh) {
      for (const ref of chapters) {
        const record = getChapter(file, ref.book, String(ref.chapter));
        const revision = record ? latestRevision(record) : undefined;
        if (revision) footers.push(footerFor(abbr, ref, revision.rev, revision.fetchedAt));
      }
    }
  }
  return { entries: assembleEntries(sermon, storeFiles), footers };
}

async function loadServer(
  runtime: Runtime,
  ctx: CliContext,
  sermon: SermonFile,
  refresh: boolean,
): Promise<LoadedPassages> {
  const server = runtime.server;
  /* v8 ignore next -- loadEntryData only routes here in server mode */
  if (!server) throw new Error('loadServer requires server mode');
  const storeFiles: Record<string, TranslationStoreFile | undefined> = {};
  const footers: string[] = [];
  const chapters = uniqueChapters(sermon);
  for (const abbr of sermon.translations) {
    const file = createEmptyStoreFile(abbr, ctx.now().toISOString());
    file.canon = await server.getCanon(abbr);
    for (const ref of chapters) {
      const verses = shiftedVerses(sermon, abbr, ref);
      const response = await server.getVerses(abbr, ref.book, ref.chapter, verses, { refresh });
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
      book.chapters[String(ref.chapter)] = record;
      if (response.source === 'cache') {
        footers.push(footerFor(abbr, ref, response.revision, response.fetchedAt));
      }
    }
    storeFiles[abbr] = file;
  }
  return { entries: assembleEntries(sermon, storeFiles), footers };
}

export async function loadEntryData(
  runtime: Runtime,
  ctx: CliContext,
  sermon: SermonFile,
  options: { refresh?: boolean } = {},
): Promise<LoadedPassages> {
  const refresh = options.refresh === true;
  return runtime.mode === 'server'
    ? loadServer(runtime, ctx, sermon, refresh)
    : loadLocal(runtime, ctx, sermon, refresh);
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
