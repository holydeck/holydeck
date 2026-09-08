import { Command } from 'commander';
import { HolyDeckError } from '@holydeck/core/messages';
import type { ChapterRevision } from '@holydeck/core/storage';
import { findRevision, getChapter } from '@holydeck/core/storage';
import { outLine } from '../context.js';
import type { CliContext } from '../context.js';
import type { GlobalOptions } from '../program.js';
import { createRuntime, requireLocal, runtimeFlags } from '../runtime.js';
import { diffWords, renderDiff } from '../word-diff.js';

function chapterText(revision: ChapterRevision): string {
  return Object.keys(revision.verses)
    .map(Number)
    .sort((a, b) => a - b)
    .map((verse) => `${verse} ${revision.verses[String(verse)]}`)
    .join('\n');
}

export async function runRevisions(
  ctx: CliContext,
  abbrInput: string,
  bookInput: string,
  chapterInput: string,
  options: { diff?: string },
  globals: GlobalOptions,
): Promise<void> {
  const runtime = await createRuntime(ctx, runtimeFlags(globals));
  requireLocal(runtime, 'revisions');
  const abbr = abbrInput.toUpperCase();
  const book = bookInput.toUpperCase();
  const chapter = Number(chapterInput);
  if (!Number.isInteger(chapter) || chapter < 1) {
    throw new HolyDeckError('invalid_reference', { input: `${book} ${chapterInput}` });
  }
  const file = await runtime.store.load(abbr);
  const record = getChapter(file, book, String(chapter));
  if (record === undefined) {
    throw new HolyDeckError('chapter_not_in_store', { abbr, book, chapter: String(chapter) });
  }
  if (options.diff !== undefined) {
    const match = /^(\d+)\.\.(\d+)$/.exec(options.diff);
    if (match === null) throw new HolyDeckError('diff_range_invalid', { input: options.diff });
    const refInfo = { abbr, book, chapter: String(chapter) };
    const from = findRevision(record, Number(match[1]), refInfo);
    const to = findRevision(record, Number(match[2]), refInfo);
    outLine(ctx, renderDiff(diffWords(chapterText(from), chapterText(to))));
    return;
  }
  if (globals.json === true) {
    outLine(
      ctx,
      JSON.stringify(
        {
          translation: abbr,
          book,
          chapter,
          revisions: record.revisions.map(({ rev, fetchedAt, contentHash }) => ({ rev, fetchedAt, contentHash })),
        },
        undefined,
        2,
      ),
    );
    return;
  }
  for (const revision of record.revisions) {
    outLine(ctx, `rev ${revision.rev} · fetched ${revision.fetchedAt.slice(0, 10)} · ${revision.contentHash.slice(0, 8)}`);
  }
}

export function registerRevisions(program: Command, ctx: CliContext): void {
  program
    .command('revisions')
    .description('List or diff the stored revisions of a chapter')
    .argument('<abbr>', 'translation abbreviation')
    .argument('<book>', 'USFM book code, e.g. PSA')
    .argument('<chapter>', 'chapter number')
    .option('--diff <range>', 'diff two revisions, e.g. 1..3')
    .action(
      async (abbr: string, book: string, chapter: string, options: { diff?: string }, command: Command) => {
        await runRevisions(ctx, abbr, book, chapter, options, command.optsWithGlobals<GlobalOptions>());
      },
    );
}
