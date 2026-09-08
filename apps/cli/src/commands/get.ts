import { Command } from 'commander';
import { HolyDeckError } from '@holydeck/core/messages';
import { parseReference } from '@holydeck/core/references';
import type { SermonFile } from '@holydeck/core/sermon';
import type { CliContext } from '../context.js';
import { loadEntryData, renderAndDeliver } from '../passages.js';
import type { GlobalOptions } from '../program.js';
import { createRuntime, runtimeFlags } from '../runtime.js';

export interface GetOptions {
  translations?: string;
  refresh?: boolean;
  fetchMissing?: boolean;
  template?: string;
  copy?: boolean;
}

export async function runGet(
  ctx: CliContext,
  reference: string,
  options: GetOptions,
  globals: GlobalOptions,
): Promise<void> {
  const parsed = parseReference(reference);
  const runtime = await createRuntime(ctx, { ...runtimeFlags(globals), translations: options.translations });
  const translations = runtime.config.values.defaultTranslations;
  if (translations.length === 0) {
    throw new HolyDeckError('config_invalid_value', {
      key: 'defaultTranslations',
      value: '(empty)',
      reason: 'pass --translations or configure default translations',
    });
  }
  const sermon: SermonFile = {
    translations,
    entries: [{ book: parsed.book, chapter: parsed.chapter, verses: parsed.verses, offsets: {} }],
    notices: [],
  };
  const loaded = await loadEntryData(runtime, ctx, sermon, {
    refresh: options.refresh,
    fetchMissing: options.fetchMissing,
  });
  await renderAndDeliver(ctx, runtime, sermon, loaded, {
    template: options.template,
    copy: options.copy,
    verbose: globals.verbose,
  });
}

export function registerGet(program: Command, ctx: CliContext): void {
  program
    .command('get')
    .description('Render a single reference ad hoc, e.g. holydeck get "PSA 118:24"')
    .argument('<reference>', 'reference like "PSA 118:24", "GEN 1:5-7,9" or "1. Mose 30:5"')
    .option('--translations <list>', 'comma-separated translation abbreviations')
    .option('--refresh', 'fetch fresh content before rendering')
    .option('--no-fetch-missing', 'fail on passages the datastore lacks instead of fetching them')
    .option('--template <template>', 'override the output template')
    .option('--copy', 'copy the rendered output to the clipboard')
    .action(async (reference: string, options: GetOptions, command: Command) => {
      await runGet(ctx, reference, options, command.optsWithGlobals<GlobalOptions>());
    });
}
