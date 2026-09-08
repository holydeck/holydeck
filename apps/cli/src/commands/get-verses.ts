import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import { HolyDeckError, formatMessage } from '@holydeck/core/messages';
import { parseSermonFile } from '@holydeck/core/sermon';
import { errLine } from '../context.js';
import type { CliContext } from '../context.js';
import { loadEntryData, renderAndDeliver } from '../passages.js';
import type { GlobalOptions } from '../program.js';
import { createRuntime } from '../runtime.js';
import { readState, writeState } from '../state.js';

export interface GetVersesOptions {
  last?: boolean;
  refresh?: boolean;
  template?: string;
  copy?: boolean;
  output?: string;
  configFilePath?: string;
  youVersionApiUrl?: string;
  templateOutputFormat?: string;
}

export async function runGetVerses(
  ctx: CliContext,
  file: string | undefined,
  options: GetVersesOptions,
  globals: GlobalOptions,
): Promise<void> {
  if (options.configFilePath !== undefined) {
    errLine(ctx, formatMessage('deprecated_flag', { oldFlag: '--config-file-path', newFlag: 'the <file> argument' }));
  }
  if (options.youVersionApiUrl !== undefined) {
    errLine(ctx, formatMessage('deprecated_flag', { oldFlag: '--you-version-api-url', newFlag: '--server-url' }));
  }
  if (options.templateOutputFormat !== undefined) {
    errLine(ctx, formatMessage('deprecated_flag', { oldFlag: '--template-output-format', newFlag: '--template' }));
  }

  const runtime = await createRuntime(ctx, {
    dataDir: globals.dataDir,
    serverUrl: globals.serverUrl ?? options.youVersionApiUrl,
  });

  let sermonPath = file ?? options.configFilePath;
  if (sermonPath === undefined && options.last === true) {
    const state = await readState(runtime.config.values.dataDir);
    if (state.lastSermonFile === undefined) throw new HolyDeckError('no_last_sermon');
    sermonPath = state.lastSermonFile;
  }
  if (sermonPath === undefined) {
    throw new HolyDeckError('sermon_invalid', { reason: 'no sermon file given (pass a path or --last)' });
  }

  const absolutePath = resolve(ctx.cwd, sermonPath);
  let text: string;
  try {
    text = await readFile(absolutePath, 'utf8');
  } catch {
    throw new HolyDeckError('sermon_file_missing', { path: absolutePath });
  }

  const sermon = parseSermonFile(text);
  for (const notice of sermon.notices) errLine(ctx, notice);

  const loaded = await loadEntryData(runtime, ctx, sermon, { refresh: options.refresh });
  await renderAndDeliver(ctx, runtime, sermon, loaded, {
    template: options.template ?? options.templateOutputFormat,
    copy: options.copy,
    output: options.output,
  });

  await writeState(runtime.config.values.dataDir, { lastSermonFile: absolutePath });
}

export function registerGetVerses(program: Command, ctx: CliContext): void {
  program
    .command('get-verses')
    .description('Render a sermon file to text output')
    .argument('[file]', 'sermon file path')
    .option('--last', 'replay the most recently rendered sermon file')
    .option('--refresh', 'fetch fresh content before rendering')
    .option('--template <template>', 'override the output template')
    .option('--copy', 'copy the rendered output to the clipboard')
    .option('--output <file>', 'write the rendered output to a file instead of stdout')
    .addOption(new Option('--config-file-path <path>', 'deprecated alias for the <file> argument').hideHelp())
    .addOption(new Option('--you-version-api-url <url>', 'deprecated alias for --server-url').hideHelp())
    .addOption(new Option('--template-output-format <template>', 'deprecated alias for --template').hideHelp())
    .action(async (file: string | undefined, options: GetVersesOptions, command: Command) => {
      await runGetVerses(ctx, file, options, command.optsWithGlobals<GlobalOptions>());
    });
}
