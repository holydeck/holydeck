import { Command } from 'commander';
import { knownTranslations } from '@holydeck/core/translations';
import { outLine } from '../context.js';
import type { CliContext } from '../context.js';
import type { GlobalOptions } from '../program.js';
import type { Runtime } from '../runtime.js';
import { createRuntime, runtimeFlags } from '../runtime.js';

async function runLocal(ctx: CliContext, runtime: Runtime, json: boolean): Promise<void> {
  const rows: Array<{ abbr: string; id: number; stored: boolean }> = [];
  for (const [abbr, id] of Object.entries(knownTranslations).sort(([a], [b]) => a.localeCompare(b))) {
    rows.push({ abbr, id, stored: (await runtime.store.load(abbr)) !== undefined });
  }
  if (json) {
    outLine(ctx, JSON.stringify({ translations: rows }, undefined, 2));
    return;
  }
  for (const row of rows) {
    const line = `${row.abbr.padEnd(8)} ${String(row.id).padEnd(5)}${row.stored ? ' stored' : ''}`;
    outLine(ctx, line.trimEnd());
  }
}

async function runServer(ctx: CliContext, runtime: Runtime, json: boolean): Promise<void> {
  const server = runtime.server;
  /* v8 ignore next */
  if (server === undefined) throw new Error('server mode without server client');
  const rows = await server.getTranslations();
  if (json) {
    outLine(ctx, JSON.stringify({ translations: rows }, undefined, 2));
    return;
  }
  for (const row of rows) {
    outLine(
      ctx,
      `${row.abbreviation.padEnd(8)} ${row.title} (${row.language}) — ${row.syncedChapters}/${row.canonChapters} chapters`,
    );
  }
}

export async function runTranslations(ctx: CliContext, globals: GlobalOptions): Promise<void> {
  const runtime = await createRuntime(ctx, runtimeFlags(globals));
  const json = globals.json === true;
  if (runtime.mode === 'server') {
    await runServer(ctx, runtime, json);
  } else {
    await runLocal(ctx, runtime, json);
  }
}

export function registerTranslations(program: Command, ctx: CliContext): void {
  program
    .command('translations')
    .description('List known translations (local) or the translations a server offers')
    .action(async (_options: Record<string, never>, command: Command) => {
      await runTranslations(ctx, command.optsWithGlobals<GlobalOptions>());
    });
}
