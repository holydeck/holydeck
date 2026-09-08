import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Command } from 'commander';
import { configFilePath } from '@holydeck/core/config';
import { HolyDeckError } from '@holydeck/core/messages';
import { DEFAULT_TEMPLATE } from '@holydeck/core/template';
import { outLine } from '../context.js';
import type { CliContext } from '../context.js';

/** The built-in template, written the way a YAML double-quoted string has to spell it. */
export const TEMPLATE_EXAMPLE = DEFAULT_TEMPLATE.replace(/\n/g, '\\n');

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
    '# Reusable settings for "holydeck auth login". The client is public; do not add a secret.',
    '# Env: HOLYDECK_OIDC_ISSUER',
    '# oidcIssuer: https://auth.example.com',
    '# Env: HOLYDECK_OIDC_CLIENT_ID',
    '# oidcClientId: holydeck-cli',
    '# Env: HOLYDECK_OIDC_AUDIENCE (optional exact audience)',
    '# oidcAudience: https://holydeck.example.com',
    '# Env: HOLYDECK_OIDC_RESOURCE (optional resource prefix)',
    '# oidcResource: https://holydeck.example.com',
    '# Env: HOLYDECK_OIDC_SCOPE',
    '# oidcScope: openid offline_access',
    '# Env: HOLYDECK_OIDC_CALLBACK_PORT',
    '# oidcCallbackPort: 53682',
    '',
    '# Where the local bible datastore lives.',
    '# Env: HOLYDECK_DATA_DIR',
    '# dataDir: /path/to/holydeck-data',
    '',
    '# Output template, in Liquid. "entries" holds one entry per passage of the sermon file,',
    '# each with a "passages" list holding one passage per translation. A passage carries',
    '# text, citation, translation, book, bookName, chapter, verses, revision and fetchedAt.',
    '# Env: HOLYDECK_TEMPLATE (deprecated alias: YOU_VERSION_CLI_TEMPLATE_OUTPUT_FORMAT)',
    `# template: "${TEMPLATE_EXAMPLE}"`,
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
