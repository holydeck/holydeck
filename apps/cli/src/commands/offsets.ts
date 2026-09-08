import { Command } from 'commander';
import { resolveBook } from '@holydeck/core/canon';
import { HolyDeckError } from '@holydeck/core/messages';
import type { TranslationStoreFile } from '@holydeck/core/storage';
import { outLine } from '../context.js';
import type { CliContext } from '../context.js';
import type { GlobalOptions } from '../program.js';
import type { Runtime } from '../runtime.js';
import { createRuntime, requireLocal, runtimeFlags } from '../runtime.js';
import { storedAbbrs } from './stats.js';

export interface OffsetRow {
  book: string;
  chapter: number;
  a: number;
  b: number;
  offset: number;
}

async function loadStored(runtime: Runtime, dataDir: string, abbr: string): Promise<TranslationStoreFile> {
  const file = await runtime.store.load(abbr);
  if (file === undefined) {
    throw new HolyDeckError('unknown_translation', { abbr, known: (await storedAbbrs(dataDir)).join(', ') });
  }
  return file;
}

export function compareCounts(a: TranslationStoreFile, b: TranslationStoreFile, book?: string): {
  shared: number;
  differences: OffsetRow[];
} {
  let shared = 0;
  const differences: OffsetRow[] = [];
  const books = Object.keys(a.books)
    .filter((usfm) => book === undefined || usfm === book)
    .sort();
  for (const usfm of books) {
    const other = b.books[usfm];
    if (other === undefined) continue;
    const chapters = Object.keys(a.books[usfm]?.chapters ?? {})
      .map(Number)
      .sort((x, y) => x - y);
    for (const chapter of chapters) {
      const recordA = a.books[usfm]?.chapters[String(chapter)];
      const recordB = other.chapters[String(chapter)];
      if (recordA === undefined || recordB === undefined) continue;
      shared += 1;
      if (recordA.canonVerseCount !== recordB.canonVerseCount) {
        differences.push({
          book: usfm,
          chapter,
          a: recordA.canonVerseCount,
          b: recordB.canonVerseCount,
          offset: recordB.canonVerseCount - recordA.canonVerseCount,
        });
      }
    }
  }
  return { shared, differences };
}

export async function runOffsets(
  ctx: CliContext,
  aInput: string,
  bInput: string,
  bookInput: string | undefined,
  globals: GlobalOptions,
): Promise<void> {
  const runtime = await createRuntime(ctx, runtimeFlags(globals));
  requireLocal(runtime, 'offsets');
  const dataDir = runtime.config.values.dataDir;
  const abbrA = aInput.toUpperCase();
  const abbrB = bInput.toUpperCase();
  const fileA = await loadStored(runtime, dataDir, abbrA);
  const fileB = await loadStored(runtime, dataDir, abbrB);
  const book = bookInput === undefined ? undefined : (resolveBook(bookInput) ?? bookInput.toUpperCase());
  const { shared, differences } = compareCounts(fileA, fileB, book);
  if (globals.json === true) {
    outLine(ctx, JSON.stringify({ a: abbrA, b: abbrB, shared, differences }, undefined, 2));
    return;
  }
  for (const row of differences) {
    const sign = row.offset > 0 ? '+' : '';
    outLine(ctx, `${row.book} ${row.chapter}: ${abbrA} ${row.a} vs ${abbrB} ${row.b} (offset ${sign}${row.offset})`);
  }
  outLine(
    ctx,
    differences.length === 0
      ? `no verse-count differences in ${shared} shared chapters.`
      : `${differences.length} differing of ${shared} shared chapters.`,
  );
}

export function registerOffsets(program: Command, ctx: CliContext): void {
  program
    .command('offsets')
    .description('Compare verse counts between two stored translations to find versification offsets')
    .argument('<a>', 'first translation abbreviation')
    .argument('<b>', 'second translation abbreviation')
    .argument('[book]', 'limit the comparison to one book, by USFM code or name')
    .action(async (a: string, b: string, book: string | undefined, _options: Record<string, never>, command: Command) => {
      await runOffsets(ctx, a, b, book, command.optsWithGlobals<GlobalOptions>());
    });
}
