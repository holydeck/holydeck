import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { HolyDeckError, formatMessage } from '@holydeck/core/messages';
import { errLine, outLine } from '../context.js';
import type { CliContext } from '../context.js';
import type { GlobalOptions } from '../program.js';
import { createRuntime, runtimeFlags } from '../runtime.js';
import { writeState } from '../state.js';

export function sermonFileName(name: string | undefined, today: string): string {
  if (name === undefined) return `${today}.yml`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(name)) return `${name}.yml`;
  return `${today}-${name}.yml`;
}

export function sermonScaffold(translations: string[]): string {
  const list = translations.length > 0 ? translations : ['KJV'];
  return [
    '# HolyDeck sermon file — render it with: holydeck get-verses <this file>',
    '',
    '# Translations to render, in order:',
    `translations: [${list.join(', ')}]`,
    '',
    '# Optional Liquid template override for this file:',
    '# template: "{% for e in entries %}...{% endfor %}"',
    '',
    'verses:',
    '  - book: PSA',
    '    chapter: 118',
    '    verses: 24',
    '    # Per-translation verse offsets for versification differences, e.g.:',
    '    # offsets:',
    '    #   SCH2000: 1',
    '',
  ].join('\n');
}

export async function runNew(
  ctx: CliContext,
  name: string | undefined,
  options: { edit?: boolean },
  globals: GlobalOptions,
): Promise<void> {
  const runtime = await createRuntime(ctx, runtimeFlags(globals));
  const today = ctx.now().toISOString().slice(0, 10);
  const path = join(ctx.cwd, sermonFileName(name, today));
  if (existsSync(path)) throw new HolyDeckError('file_exists', { path });
  await writeFile(path, sermonScaffold(runtime.config.values.defaultTranslations), { encoding: 'utf8', flag: 'wx' });
  await writeState(runtime.config.values.dataDir, { lastSermonFile: path });
  if (options.edit !== false && ctx.isTTY) {
    const result = await ctx.editor(path);
    if (result === 'skipped') errLine(ctx, formatMessage('editor_not_set'));
  }
  outLine(ctx, path);
}

export function registerNew(program: Command, ctx: CliContext): void {
  program
    .command('new')
    .description('Scaffold a dated sermon file and open it in $EDITOR')
    .argument('[name]', 'date (YYYY-MM-DD) or name suffix for the file')
    .option('--no-edit', 'do not open the file in $EDITOR')
    .action(async (name: string | undefined, options: { edit?: boolean }, command: Command) => {
      await runNew(ctx, name, options, command.optsWithGlobals<GlobalOptions>());
    });
}
