import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Command } from 'commander';
import { configFilePath } from '@holydeck/core/config';
import { HolyDeckError } from '@holydeck/core/messages';
import { outLine } from '../context.js';
import type { CliContext } from '../context.js';

export function configScaffold(): string {
  return [
    '# HolyDeck configuration — every key here can also be set via environment variable.',
    '# Flags > environment > this file > built-in defaults.',
    '',
    '# Translations rendered when a sermon file or command does not name any.',
    '# Env: HOLYDECK_TRANSLATIONS (comma-separated, e.g. "KJV,SCH2000")',
    'defaultTranslations: [KJV]',
    '',
    '# Talk to a HolyDeck server instead of the local datastore.',
    '# Env: HOLYDECK_SERVER_URL (deprecated alias: YOU_VERSION_CLI_API_URL)',
    '# serverUrl: https://holydeck.example.com',
    '',
    '# Where the local bible datastore lives.',
    '# Env: HOLYDECK_DATA_DIR',
    '# dataDir: /path/to/holydeck-data',
    '',
    '# Default Liquid output template.',
    '# Env: HOLYDECK_TEMPLATE (deprecated alias: YOU_VERSION_CLI_TEMPLATE_OUTPUT_FORMAT)',
    '# template: "{% for e in entries %}{{ e.citation }}\\n{{ e.passage }}\\n{% endfor %}"',
    '',
    '# Parallel chapter fetches during holydeck sync.',
    '# Env: HOLYDECK_SYNC_CONCURRENCY',
    '# syncConcurrency: 2',
    '',
    '# Delay between fetches in milliseconds (be polite to bible.com).',
    '# Env: HOLYDECK_SYNC_DELAY_MS',
    '# syncDelayMs: 250',
    '',
    '# Fetch bible.com through a headless browser. Slower to start, but it runs the',
    '# JavaScript challenge that blocks plain HTTP clients. Needs the optional',
    '# puppeteer dependency; flag: --browser-fetch.',
    '# Env: HOLYDECK_BROWSER_FETCH',
    '# browserFetch: true',
    '',
  ].join('\n');
}

export async function runConfigInit(ctx: CliContext, options: { force?: boolean }): Promise<void> {
  const path = configFilePath(ctx.platform);
  if (existsSync(path) && options.force !== true) {
    throw new HolyDeckError('config_exists', { path });
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, configScaffold(), 'utf8');
  outLine(ctx, path);
}

export function registerConfig(program: Command, ctx: CliContext): void {
  const config = program.command('config').description('Manage the HolyDeck config file');
  config
    .command('init')
    .description('Write a commented starter config file')
    .option('--force', 'overwrite an existing config file')
    .action(async (options: { force?: boolean }) => {
      await runConfigInit(ctx, options);
    });
}
