import { join } from 'node:path';
import { parse } from 'yaml';
import { HolyDeckError, formatMessage } from './messages.js';

export interface HolyDeckConfig {
  dataDir: string;
  serverUrl?: string;
  template?: string;
  defaultTranslations: string[];
  syncConcurrency: number;
  syncDelayMs: number;
  /** Fetch bible.com through a headless browser, which can pass its bot-protection challenge. */
  browserFetch: boolean;
}

export type ConfigSource = 'default' | 'file' | 'env' | 'flag';

export interface PlatformInfo {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homeDir: string;
}

export interface ResolvedConfig {
  values: HolyDeckConfig;
  sources: Record<keyof HolyDeckConfig, ConfigSource>;
  notices: string[];
}

export function dataDir({ platform, env, homeDir }: PlatformInfo): string {
  if (platform === 'darwin') return join(homeDir, 'Library', 'Application Support', 'holydeck');
  if (platform === 'win32') return join(env.APPDATA ?? join(homeDir, 'AppData', 'Roaming'), 'holydeck');
  return join(env.XDG_DATA_HOME ?? join(homeDir, '.local', 'share'), 'holydeck');
}

export function configFilePath({ platform, env, homeDir }: PlatformInfo): string {
  if (platform === 'win32') return join(env.APPDATA ?? join(homeDir, 'AppData', 'Roaming'), 'holydeck', 'config.yaml');
  return join(env.XDG_CONFIG_HOME ?? join(homeDir, '.config'), 'holydeck', 'config.yaml');
}

export function parseConfigFile(text: string, path: string): Partial<HolyDeckConfig> {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new HolyDeckError('config_file_unreadable', { path, reason: (error as Error).message });
  }
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HolyDeckError('config_file_unreadable', { path, reason: 'expected a YAML mapping' });
  }
  const obj = raw as Record<string, unknown>;
  const out: Partial<HolyDeckConfig> = {};
  const dataDirValue = stringValue(obj, 'dataDir');
  if (dataDirValue !== undefined) out.dataDir = dataDirValue;
  const serverUrlValue = stringValue(obj, 'serverUrl');
  if (serverUrlValue !== undefined) out.serverUrl = serverUrlValue;
  const templateValue = stringValue(obj, 'template');
  if (templateValue !== undefined) out.template = templateValue;
  if (obj.defaultTranslations !== undefined) {
    if (!Array.isArray(obj.defaultTranslations) || obj.defaultTranslations.some((item) => typeof item !== 'string')) {
      throw new HolyDeckError('config_invalid_value', {
        key: 'defaultTranslations',
        value: String(obj.defaultTranslations),
        reason: 'expected a list of strings',
      });
    }
    out.defaultTranslations = (obj.defaultTranslations as string[]).map((item) => item.trim().toUpperCase());
  }
  const concurrency = intValue(obj, 'syncConcurrency', 1);
  if (concurrency !== undefined) out.syncConcurrency = concurrency;
  const delay = intValue(obj, 'syncDelayMs', 0);
  if (delay !== undefined) out.syncDelayMs = delay;
  const browserFetchValue = boolValue(obj, 'browserFetch');
  if (browserFetchValue !== undefined) out.browserFetch = browserFetchValue;
  return out;
}

function boolValue(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new HolyDeckError('config_invalid_value', { key, value: String(value), reason: 'expected true or false' });
  }
  return value;
}

function stringValue(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new HolyDeckError('config_invalid_value', { key, value: String(value), reason: 'expected a string' });
  }
  return value;
}

function intValue(obj: Record<string, unknown>, key: string, minimum: number): number | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new HolyDeckError('config_invalid_value', {
      key,
      value: String(value),
      reason: `expected an integer >= ${minimum}`,
    });
  }
  return value;
}

function parseIntEnv(key: string, value: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new HolyDeckError('config_invalid_value', {
      key,
      value,
      reason: `expected an integer >= ${minimum}`,
    });
  }
  return parsed;
}

function parseBoolEnv(key: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new HolyDeckError('config_invalid_value', { key, value, reason: 'expected true or false' });
}

function envLayer(env: Record<string, string | undefined>, notices: string[]): Partial<HolyDeckConfig> {
  const layer: Partial<HolyDeckConfig> = {};
  if (env.YOU_VERSION_CLI_API_URL !== undefined && env.HOLYDECK_SERVER_URL === undefined) {
    notices.push(formatMessage('deprecated_env', { oldName: 'YOU_VERSION_CLI_API_URL', newName: 'HOLYDECK_SERVER_URL' }));
    layer.serverUrl = env.YOU_VERSION_CLI_API_URL;
  }
  if (env.YOU_VERSION_CLI_TEMPLATE_OUTPUT_FORMAT !== undefined && env.HOLYDECK_TEMPLATE === undefined) {
    notices.push(
      formatMessage('deprecated_env', { oldName: 'YOU_VERSION_CLI_TEMPLATE_OUTPUT_FORMAT', newName: 'HOLYDECK_TEMPLATE' }),
    );
    layer.template = env.YOU_VERSION_CLI_TEMPLATE_OUTPUT_FORMAT;
  }
  if (env.HOLYDECK_SERVER_URL !== undefined) layer.serverUrl = env.HOLYDECK_SERVER_URL;
  if (env.HOLYDECK_DATA_DIR !== undefined) layer.dataDir = env.HOLYDECK_DATA_DIR;
  if (env.HOLYDECK_TEMPLATE !== undefined) layer.template = env.HOLYDECK_TEMPLATE;
  if (env.HOLYDECK_TRANSLATIONS !== undefined) {
    layer.defaultTranslations = env.HOLYDECK_TRANSLATIONS.split(',')
      .map((item) => item.trim().toUpperCase())
      .filter((item) => item !== '');
  }
  if (env.HOLYDECK_SYNC_CONCURRENCY !== undefined && env.HOLYDECK_SYNC_CONCURRENCY.trim() !== '') {
    layer.syncConcurrency = parseIntEnv('HOLYDECK_SYNC_CONCURRENCY', env.HOLYDECK_SYNC_CONCURRENCY, 1);
  }
  if (env.HOLYDECK_SYNC_DELAY_MS !== undefined && env.HOLYDECK_SYNC_DELAY_MS.trim() !== '') {
    layer.syncDelayMs = parseIntEnv('HOLYDECK_SYNC_DELAY_MS', env.HOLYDECK_SYNC_DELAY_MS, 0);
  }
  if (env.HOLYDECK_BROWSER_FETCH !== undefined && env.HOLYDECK_BROWSER_FETCH.trim() !== '') {
    layer.browserFetch = parseBoolEnv('HOLYDECK_BROWSER_FETCH', env.HOLYDECK_BROWSER_FETCH);
  }
  return layer;
}

export function resolveConfig(inputs: {
  platform: PlatformInfo;
  file?: Partial<HolyDeckConfig>;
  env: Record<string, string | undefined>;
  flags?: Partial<HolyDeckConfig>;
}): ResolvedConfig {
  const notices: string[] = [];
  const values: HolyDeckConfig = {
    dataDir: dataDir(inputs.platform),
    defaultTranslations: [],
    syncConcurrency: 2,
    syncDelayMs: 1000,
    browserFetch: false,
  };
  const sources: Record<keyof HolyDeckConfig, ConfigSource> = {
    dataDir: 'default',
    serverUrl: 'default',
    template: 'default',
    defaultTranslations: 'default',
    syncConcurrency: 'default',
    syncDelayMs: 'default',
    browserFetch: 'default',
  };
  const apply = (layer: Partial<HolyDeckConfig>, source: ConfigSource): void => {
    for (const key of Object.keys(layer) as Array<keyof HolyDeckConfig>) {
      const value = layer[key];
      if (value === undefined) continue;
      (values as unknown as Record<string, unknown>)[key] = value;
      sources[key] = source;
    }
  };
  apply(inputs.file ?? {}, 'file');
  apply(envLayer(inputs.env, notices), 'env');
  apply(inputs.flags ?? {}, 'flag');
  return { values, sources, notices };
}
