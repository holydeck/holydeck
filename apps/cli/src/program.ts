import { Command, CommanderError } from 'commander';
import { HolyDeckError } from '@holydeck/core/messages';
import { registerGet } from './commands/get.js';
import { registerGetVerses } from './commands/get-verses.js';
import { registerInfo } from './commands/info.js';
import { registerNew } from './commands/new.js';
import { registerPreflight } from './commands/preflight.js';
import { registerStats } from './commands/stats.js';
import { registerSync } from './commands/sync.js';
import { registerTranslations } from './commands/translations.js';
import { errLine } from './context.js';
import type { CliContext } from './context.js';
import { CLI_VERSION } from './version.js';

export interface GlobalOptions {
  dataDir?: string;
  serverUrl?: string;
  json?: boolean;
}

export function buildProgram(ctx: CliContext): Command {
  const program = new Command();
  program
    .name('holydeck')
    .description('Bible verses for sermons and presentations, from a local revisioned datastore.')
    .version(CLI_VERSION)
    .option('--data-dir <dir>', 'override the data directory')
    .option('--server-url <url>', 'use a remote HolyDeck server instead of the local datastore')
    .option('--json', 'machine-readable output on informational commands')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => ctx.out(text),
      writeErr: (text) => ctx.err(text),
    });

  // command registrations (one line appended per command task):
  registerGetVerses(program, ctx);
  registerGet(program, ctx);
  registerInfo(program, ctx);
  registerNew(program, ctx);
  registerPreflight(program, ctx);
  registerStats(program, ctx);
  registerSync(program, ctx);
  registerTranslations(program, ctx);

  return program;
}

export function reportError(ctx: CliContext, json: boolean, error: unknown): number {
  if (error instanceof HolyDeckError) {
    if (json) {
      errLine(ctx, JSON.stringify({ error: { code: error.code, message: error.message } }));
    } else {
      errLine(ctx, error.message);
    }
    return 1;
  }
  if (error instanceof CommanderError) {
    // commander already wrote its message through configureOutput
    return error.exitCode;
  }
  errLine(ctx, error instanceof Error ? error.message : String(error));
  return 1;
}

export async function runCli(ctx: CliContext, args: string[]): Promise<number> {
  const program = buildProgram(ctx);
  try {
    await program.parseAsync(args, { from: 'user' });
    return ctx.exitCode ?? 0;
  } catch (error) {
    return reportError(ctx, Boolean(program.opts<GlobalOptions>().json), error);
  }
}
