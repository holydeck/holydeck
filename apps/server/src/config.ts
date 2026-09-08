import { HolyDeckError } from '@holydeck/core/messages';

export interface ServerConfig {
  host: string;
  port: number;
  mongoUrl: string;
  mongoDb: string;
  logLevel: string;
  syncConcurrency: number;
  syncDelayMs: number;
  /** Fetch bible.com through a headless browser, which can pass its bot-protection challenge. */
  browserFetch: boolean;
  /** Chromium executable to drive; defaults to the one puppeteer downloaded. */
  browserExecutablePath?: string;
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max?: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new HolyDeckError('config_invalid_value', {
      key,
      value: raw,
      reason: max === undefined ? `expected an integer >= ${min}` : `expected an integer between ${min} and ${max}`,
    });
  }
  return value;
}

function boolFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new HolyDeckError('config_invalid_value', { key, value: raw, reason: 'expected true or false' });
}

export function resolveServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const browserExecutablePath = env.HOLYDECK_BROWSER_EXECUTABLE;
  return {
    ...(browserExecutablePath === undefined || browserExecutablePath === ''
      ? {}
      : { browserExecutablePath }),
    host: env.HOLYDECK_HOST ?? '0.0.0.0',
    port: intFromEnv(env, 'HOLYDECK_PORT', 3000, 1, 65535),
    mongoUrl: env.HOLYDECK_MONGO_URL ?? 'mongodb://127.0.0.1:27017',
    mongoDb: env.HOLYDECK_MONGO_DB ?? 'holydeck',
    logLevel: env.HOLYDECK_LOG_LEVEL ?? 'info',
    syncConcurrency: intFromEnv(env, 'HOLYDECK_SYNC_CONCURRENCY', 2, 1),
    syncDelayMs: intFromEnv(env, 'HOLYDECK_SYNC_DELAY_MS', 1000, 0),
    browserFetch: boolFromEnv(env, 'HOLYDECK_BROWSER_FETCH', false),
  };
}
