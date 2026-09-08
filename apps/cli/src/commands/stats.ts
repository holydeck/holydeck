import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { HolyDeckError } from '@holydeck/core/messages';
import type { TranslationStoreFile } from '@holydeck/core/storage';
import { outLine } from '../context.js';
import type { CliContext } from '../context.js';
import type { GlobalOptions } from '../program.js';
import { createRuntime, requireLocal } from '../runtime.js';

export interface TranslationStats {
  abbr: string;
  chapters: number;
  canonChapters: number | undefined;
  revisions: number;
  updatedAt: string;
  path: string;
  bytes: number;
}

export async function storedAbbrs(dataDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(join(dataDir, 'bibles'));
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

export function statsOf(abbr: string, file: TranslationStoreFile): Omit<TranslationStats, 'path' | 'bytes'> {
  let chapters = 0;
  let revisions = 0;
  for (const book of Object.values(file.books)) {
    for (const record of Object.values(book.chapters)) {
      chapters += 1;
      revisions += record.revisions.length;
    }
  }
  const canonChapters =
    file.canon === undefined ? undefined : file.canon.books.reduce((sum, book) => sum + book.chapters.length, 0);
  return { abbr, chapters, canonChapters, revisions, updatedAt: file.updatedAt };
}

export async function runStats(
  ctx: CliContext,
  options: { translation?: string },
  globals: GlobalOptions,
): Promise<void> {
  const runtime = await createRuntime(ctx, { dataDir: globals.dataDir, serverUrl: globals.serverUrl });
  requireLocal(runtime, 'stats');
  const dataDir = runtime.config.values.dataDir;
  let abbrs = await storedAbbrs(dataDir);
  if (options.translation !== undefined) {
    const wanted = options.translation.toUpperCase();
    if (!abbrs.includes(wanted)) {
      throw new HolyDeckError('unknown_translation', { abbr: wanted, known: abbrs.join(', ') });
    }
    abbrs = [wanted];
  }
  const rows: TranslationStats[] = [];
  for (const abbr of abbrs) {
    const file = await runtime.store.load(abbr);
    // storedAbbrs just listed the file, so load only misses on a delete race
    /* v8 ignore next */
    if (file === undefined) continue;
    const path = join(dataDir, 'bibles', `${abbr}.json`);
    rows.push({ ...statsOf(abbr, file), path, bytes: (await stat(path)).size });
  }
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  if (globals.json === true) {
    outLine(ctx, JSON.stringify({ translations: rows, totalBytes }, undefined, 2));
    return;
  }
  if (rows.length === 0) {
    outLine(ctx, 'no translations stored yet.');
    return;
  }
  for (const row of rows) {
    const canon = row.canonChapters === undefined ? '?' : String(row.canonChapters);
    outLine(
      ctx,
      `${row.abbr}: ${row.chapters}/${canon} chapters, ${row.revisions} revisions, updated ${row.updatedAt.slice(0, 10)}`,
    );
    outLine(ctx, `  store: ${row.path} (${row.bytes} bytes)`);
  }
  outLine(ctx, `total: ${rows.length} translations, ${totalBytes} bytes on disk`);
}

export function registerStats(program: Command, ctx: CliContext): void {
  program
    .command('stats')
    .description('Show what the local datastore holds: coverage, revisions, size on disk, store location')
    .option('--translation <abbr>', 'limit the report to one stored translation')
    .action(async (options: { translation?: string }, command: Command) => {
      await runStats(ctx, options, command.optsWithGlobals<GlobalOptions>());
    });
}
