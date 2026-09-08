import { readFile } from 'node:fs/promises';
import { configFilePath, parseConfigFile, resolveConfig } from '@holydeck/core/config';
import type { HolyDeckConfig, ResolvedConfig } from '@holydeck/core/config';
import { Fetcher } from '@holydeck/core/fetcher';
import { FileStore } from '@holydeck/core/file-store';
import { HolyDeckError } from '@holydeck/core/messages';
import { errLine } from './context.js';
import type { CliContext } from './context.js';
import { ServerClient } from './server-client.js';

export interface GlobalFlags {
  dataDir?: string;
  serverUrl?: string;
  translations?: string;
}

export interface Runtime {
  config: ResolvedConfig;
  store: FileStore;
  fetcher: Fetcher;
  server?: ServerClient;
  mode: 'local' | 'server';
}

export async function createRuntime(ctx: CliContext, flags: GlobalFlags = {}): Promise<Runtime> {
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
  if (flags.translations !== undefined) {
    flagValues.defaultTranslations = flags.translations
      .split(',')
      .map((abbr) => abbr.trim())
      .filter((abbr) => abbr.length > 0);
  }

  const config = resolveConfig({ platform: ctx.platform, file, env: ctx.platform.env, flags: flagValues });
  for (const notice of config.notices) errLine(ctx, notice);

  const store = new FileStore(config.values.dataDir, { now: () => ctx.now().toISOString() });
  const fetcher = new Fetcher({ httpGet: ctx.httpGet, sleep: ctx.sleep });

  const serverUrl = config.values.serverUrl;
  if (serverUrl !== undefined) {
    const server = new ServerClient(serverUrl, { httpGet: ctx.httpGet, httpPost: ctx.httpPost });
    return { config, store, fetcher, server, mode: 'server' };
  }
  return { config, store, fetcher, mode: 'local' };
}

export function requireLocal(runtime: Runtime, command: string): void {
  if (runtime.mode === 'server') throw new HolyDeckError('local_only_command', { command });
}
