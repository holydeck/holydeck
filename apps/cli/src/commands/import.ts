import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { HolyDeckError } from '@holydeck/core/messages';
import { validateStoreFile } from '@holydeck/core/storage';
import { outLine } from '../context.js';
import type { CliContext } from '../context.js';
import type { GlobalOptions } from '../program.js';
import { createRuntime, requireLocal, runtimeFlags } from '../runtime.js';

export async function runImport(ctx: CliContext, file: string, globals: GlobalOptions): Promise<void> {
  const runtime = await createRuntime(ctx, runtimeFlags(globals));
  requireLocal(runtime, 'import');
  const path = resolve(ctx.cwd, file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new HolyDeckError('store_corrupt', { path, reason: String(error) });
  }
  const incoming = validateStoreFile(parsed, path);
  const report = await runtime.store.importFile(incoming.translation, incoming);
  outLine(
    ctx,
    `imported into ${incoming.translation}: ${report.newChapters} new chapters, ${report.addedRevisions} added revisions.`,
  );
}

export function registerImport(program: Command, ctx: CliContext): void {
  program
    .command('import')
    .description('Merge an exported translation store file into the local datastore')
    .argument('<file>', 'path to the exported .json store file')
    .action(async (file: string, _options: Record<string, never>, command: Command) => {
      await runImport(ctx, file, command.optsWithGlobals<GlobalOptions>());
    });
}
