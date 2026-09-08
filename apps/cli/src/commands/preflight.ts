import { Command } from 'commander';
import { bundledCanon, findBook } from '@holydeck/core/canon';
import { HolyDeckError } from '@holydeck/core/messages';
import { formatVerseList } from '@holydeck/core/references';
import type { SermonEntry } from '@holydeck/core/sermon';
import { parseSermonFile } from '@holydeck/core/sermon';
import { getChapter } from '@holydeck/core/storage';
import { translationId } from '@holydeck/core/translations';
import { errLine, outLine } from '../context.js';
import type { CliContext } from '../context.js';
import type { GlobalOptions } from '../program.js';
import type { Runtime } from '../runtime.js';
import { createRuntime, runtimeFlags } from '../runtime.js';
import { readSermonFile } from '../sermon-file.js';
import { startSpinner } from '../spinner.js';
import { readState } from '../state.js';

export interface PreflightRow {
  reference: string;
  translation: string;
  status: 'ok' | 'fetched' | 'failed';
  detail?: string;
}

function referenceOf(entry: SermonEntry): string {
  return `${entry.book} ${entry.chapter}:${formatVerseList(entry.verses)}`;
}

function neededVerses(entry: SermonEntry, abbr: string): number[] {
  const offset = entry.offsets[abbr] ?? 0;
  return entry.verses.map((verse) => verse + offset);
}

function missingIn(verses: Record<string, string>, needed: number[]): number[] {
  return needed.filter((verse) => verses[String(verse)] === undefined);
}

async function checkLocal(runtime: Runtime, abbr: string, entry: SermonEntry): Promise<PreflightRow> {
  const reference = referenceOf(entry);
  const chapter = String(entry.chapter);
  const file = await runtime.store.load(abbr);
  const canon = file?.canon ?? bundledCanon();
  const needed = neededVerses(entry, abbr);
  try {
    if (findBook(canon, entry.book) === undefined) {
      return { reference, translation: abbr, status: 'failed', detail: `unknown book ${entry.book}` };
    }
    let record = getChapter(file, entry.book, chapter);
    let status: PreflightRow['status'] = 'ok';
    if (record === undefined) {
      const parsed = await runtime.fetcher.fetchChapter(translationId(abbr), abbr, entry.book, chapter);
      await runtime.store.putChapter(abbr, entry.book, chapter, parsed.verses, parsed.canonVerseCount);
      record = getChapter(await runtime.store.load(abbr), entry.book, chapter);
      status = 'fetched';
    }
    const verses = record?.revisions.at(-1)?.verses ?? {};
    const missing = missingIn(verses, needed);
    if (missing.length > 0) {
      return { reference, translation: abbr, status: 'failed', detail: `missing verses: ${formatVerseList(missing)}` };
    }
    return { reference, translation: abbr, status };
  } catch (error) {
    const detail = error instanceof HolyDeckError ? error.message : String(error);
    return { reference, translation: abbr, status: 'failed', detail };
  }
}

async function checkServer(runtime: Runtime, abbr: string, entry: SermonEntry): Promise<PreflightRow> {
  const reference = referenceOf(entry);
  const server = runtime.server;
  /* v8 ignore next */
  if (server === undefined) throw new Error('server mode without server client');
  try {
    const response = await server.getVerses(abbr, entry.book, entry.chapter, neededVerses(entry, abbr), {});
    const missing = missingIn(response.verses, neededVerses(entry, abbr));
    if (missing.length > 0) {
      return { reference, translation: abbr, status: 'failed', detail: `missing verses: ${formatVerseList(missing)}` };
    }
    return { reference, translation: abbr, status: 'ok' };
  } catch (error) {
    // ServerClient.request wraps every failure (network, HTTP, malformed body) in HolyDeckError,
    // so this arm is always a HolyDeckError in practice; no defensive String(error) fallback needed.
    return { reference, translation: abbr, status: 'failed', detail: (error as HolyDeckError).message };
  }
}

export async function runPreflight(
  ctx: CliContext,
  file: string | undefined,
  options: { last?: boolean },
  globals: GlobalOptions,
): Promise<void> {
  const runtime = await createRuntime(ctx, runtimeFlags(globals));
  let sermonPath = file;
  if (sermonPath === undefined && options.last === true) {
    const state = await readState(runtime.config.values.dataDir);
    sermonPath = state.lastSermonFile;
    if (sermonPath === undefined) throw new HolyDeckError('no_last_sermon');
  }
  if (sermonPath === undefined) {
    throw new HolyDeckError('sermon_invalid', { reason: 'no sermon file given (pass a path or --last)' });
  }
  const { text } = await readSermonFile(ctx, sermonPath);
  const sermon = parseSermonFile(text);
  for (const notice of sermon.notices) errLine(ctx, notice);
  const rows: PreflightRow[] = [];
  // Missing passages are fetched here, which can mean starting a browser: report the progress
  // rather than printing nothing until the whole table is ready.
  const spinner = startSpinner(ctx, 'preflight: checking passages');
  try {
    for (const abbr of sermon.translations) {
      for (const entry of sermon.entries) {
        spinner.label(`preflight: ${abbr} ${referenceOf(entry)}`);
        rows.push(
          runtime.mode === 'server' ? await checkServer(runtime, abbr, entry) : await checkLocal(runtime, abbr, entry),
        );
      }
    }
  } finally {
    spinner.stop();
  }
  const failed = rows.filter((row) => row.status === 'failed').length;
  if (globals.json === true) {
    outLine(ctx, JSON.stringify({ entries: rows }, undefined, 2));
  } else {
    for (const row of rows) {
      const detail = row.detail === undefined ? '' : ` — ${row.detail}`;
      outLine(ctx, `${row.status.padEnd(8)} ${row.translation} ${row.reference}${detail}`);
    }
    const fetched = rows.filter((row) => row.status === 'fetched').length;
    outLine(ctx, `preflight: ${rows.length - fetched - failed} ok, ${fetched} fetched, ${failed} failed.`);
  }
  if (failed > 0) ctx.exitCode = 1;
}

export function registerPreflight(program: Command, ctx: CliContext): void {
  program
    .command('preflight')
    .description('Verify every passage of a sermon file is available, fetching what is missing')
    .argument('[file]', 'sermon file to check')
    .option('--last', 'check the last sermon file used')
    .action(async (file: string | undefined, options: { last?: boolean }, command: Command) => {
      await runPreflight(ctx, file, options, command.optsWithGlobals<GlobalOptions>());
    });
}
