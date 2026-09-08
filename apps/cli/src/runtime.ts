import { readFile } from 'node:fs/promises';
import { BrowserHttpClient } from '@holydeck/core/browser-fetch';
import { configFilePath, parseConfigFile, resolveConfig } from '@holydeck/core/config';
import type { HolyDeckConfig, ResolvedConfig } from '@holydeck/core/config';
import { Fetcher } from '@holydeck/core/fetcher';
import { FileStore } from '@holydeck/core/file-store';
import { HolyDeckError } from '@holydeck/core/messages';
import { errLine } from './context.js';
import type { CliContext } from './context.js';
import { createAccessTokenProvider } from './oidc.js';
import { ServerClient } from './server-client.js';

export interface GlobalFlags {
  dataDir?: string;
  serverUrl?: string;
  translations?: string;
  browserFetch?: boolean;
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcAudience?: string;
  oidcResource?: string;
  oidcScope?: string;
  oidcCallbackPort?: number;
}

export interface Runtime {
  config: ResolvedConfig;
  store: FileStore;
  fetcher: Fetcher;
  server?: ServerClient;
  mode: 'local' | 'server';
  /** Present when fetching goes through a headless browser; close it when the command ends. */
  browser?: BrowserHttpClient;
}

/**
 * Browser clients opened during this process. Commands never own the browser lifecycle;
 * runCli closes whatever was opened, so no exit path leaves a Chromium behind.
 */
const openBrowsers = new Set<BrowserHttpClient>();

export async function closeBrowsers(): Promise<void> {
  const clients = [...openBrowsers];
  openBrowsers.clear();
  await Promise.all(clients.map((client) => client.close()));
}

/** Maps the parsed global CLI options onto the flag layer createRuntime resolves config from. */
export function runtimeFlags(globals: {
  dataDir?: string;
  serverUrl?: string;
  translations?: string;
  browserFetch?: boolean;
}): GlobalFlags {
  return {
    dataDir: globals.dataDir,
    serverUrl: globals.serverUrl,
    translations: globals.translations,
    browserFetch: globals.browserFetch,
  };
}

export async function resolveRuntimeConfig(ctx: CliContext, flags: GlobalFlags = {}): Promise<ResolvedConfig> {
  const path = configFilePath(ctx.platform);
  let text: string | undefined;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // no config file — defaults/env/flags rule
  }
  const file = text === undefined ? undefined : parseConfigFile(text, path);

  const flagValues: Partial<HolyDeckConfig> = {};
  if (flags.dataDir !== undefined) flagValues.dataDir = flags.dataDir;
  if (flags.serverUrl !== undefined) flagValues.serverUrl = flags.serverUrl;
  if (flags.oidcIssuer !== undefined) flagValues.oidcIssuer = flags.oidcIssuer;
  if (flags.oidcClientId !== undefined) flagValues.oidcClientId = flags.oidcClientId;
  if (flags.oidcAudience !== undefined) flagValues.oidcAudience = flags.oidcAudience;
  if (flags.oidcResource !== undefined) flagValues.oidcResource = flags.oidcResource;
  if (flags.oidcScope !== undefined) flagValues.oidcScope = flags.oidcScope;
  if (flags.oidcCallbackPort !== undefined) flagValues.oidcCallbackPort = flags.oidcCallbackPort;
  if (flags.translations !== undefined) {
    flagValues.defaultTranslations = flags.translations
      .split(',')
      .map((abbr) => abbr.trim())
      .filter((abbr) => abbr.length > 0);
  }
  if (flags.browserFetch !== undefined) flagValues.browserFetch = flags.browserFetch;

  const config = resolveConfig({ platform: ctx.platform, file, env: ctx.platform.env, flags: flagValues });
  for (const notice of config.notices) errLine(ctx, notice);
  return config;
}

export async function createRuntime(ctx: CliContext, flags: GlobalFlags = {}): Promise<Runtime> {
  const config = await resolveRuntimeConfig(ctx, flags);

  const store = new FileStore(config.values.dataDir, {
    now: () => ctx.now().toISOString(),
    onLockWait: ({ abbr, owner }) => {
      const message = `${abbr}: datastore locked by ${owner} — waiting for it to finish`;
      if (ctx.status === undefined) errLine(ctx, message);
      else ctx.status(message);
    },
  });

  let browser: BrowserHttpClient | undefined;
  let scrapeHttpGet = ctx.httpGet;
  if (config.values.browserFetch && ctx.browserLauncher !== undefined) {
    browser = new BrowserHttpClient({ launch: ctx.browserLauncher });
    openBrowsers.add(browser);
    scrapeHttpGet = browser.httpGet;
  }
  const fetcher = new Fetcher({ httpGet: scrapeHttpGet, sleep: ctx.sleep });

  const serverUrl = config.values.serverUrl;
  if (serverUrl !== undefined) {
    const accessToken = createAccessTokenProvider(ctx.platform, serverUrl, { httpPost: ctx.httpPost, now: ctx.now });
    const server = new ServerClient(serverUrl, { httpGet: ctx.httpGet, httpPost: ctx.httpPost, accessToken });
    return { config, store, fetcher, server, mode: 'server', browser };
  }
  return { config, store, fetcher, mode: 'local', browser };
}

export function requireLocal(runtime: Runtime, command: string): void {
  if (runtime.mode === 'server') throw new HolyDeckError('local_only_command', { command });
}
