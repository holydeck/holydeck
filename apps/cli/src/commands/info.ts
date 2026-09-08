import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { configFilePath } from '@holydeck/core/config';
import type { HolyDeckConfig } from '@holydeck/core/config';
import { outLine } from '../context.js';
import type { CliContext } from '../context.js';
import type { GlobalOptions } from '../program.js';
import { createRuntime } from '../runtime.js';
import { readState } from '../state.js';
import { CLI_VERSION } from '../version.js';

function display(value: HolyDeckConfig[keyof HolyDeckConfig]): string {
  if (value === undefined) return '(not set)';
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(', ');
  return String(value);
}

export async function runInfo(ctx: CliContext, globals: GlobalOptions): Promise<void> {
  const runtime = await createRuntime(ctx, { dataDir: globals.dataDir, serverUrl: globals.serverUrl });
  const configPath = configFilePath(ctx.platform);
  const configExists = existsSync(configPath);
  const state = await readState(runtime.config.values.dataDir);
  if (globals.json === true) {
    outLine(
      ctx,
      JSON.stringify(
        {
          version: CLI_VERSION,
          mode: runtime.mode,
          configFile: { path: configPath, exists: configExists },
          values: runtime.config.values,
          sources: runtime.config.sources,
          lastSermonFile: state.lastSermonFile ?? null,
        },
        undefined,
        2,
      ),
    );
    return;
  }
  outLine(ctx, `holydeck ${CLI_VERSION}`);
  outLine(ctx, `mode: ${runtime.mode}`);
  outLine(ctx, `config file: ${configPath}${configExists ? '' : ' (missing)'}`);
  const keys: Array<keyof HolyDeckConfig> = ['dataDir', 'serverUrl', 'template', 'defaultTranslations', 'syncConcurrency', 'syncDelayMs'];
  for (const key of keys) {
    outLine(ctx, `${key}: ${display(runtime.config.values[key])} (${runtime.config.sources[key]})`);
  }
  outLine(ctx, `lastSermonFile: ${state.lastSermonFile ?? '(none)'}`);
}

export function registerInfo(program: Command, ctx: CliContext): void {
  program
    .command('info')
    .description('Show the effective configuration and where each value came from')
    .action(async (_options: Record<string, never>, command: Command) => {
      await runInfo(ctx, command.optsWithGlobals<GlobalOptions>());
    });
}
