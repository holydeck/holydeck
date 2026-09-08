import { HolyDeckError } from '@holydeck/core/messages';

export interface ServerConfig {
  host: string;
  port: number;
  mongoUrl: string;
  mongoDb: string;
  logLevel: string;
  syncConcurrency: number;
  syncDelayMs: number;
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

export function resolveServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.HOLYDECK_HOST ?? '0.0.0.0',
    port: intFromEnv(env, 'HOLYDECK_PORT', 3000, 1, 65535),
    mongoUrl: env.HOLYDECK_MONGO_URL ?? 'mongodb://127.0.0.1:27017',
    mongoDb: env.HOLYDECK_MONGO_DB ?? 'holydeck',
    logLevel: env.HOLYDECK_LOG_LEVEL ?? 'info',
    syncConcurrency: intFromEnv(env, 'HOLYDECK_SYNC_CONCURRENCY', 2, 1),
    syncDelayMs: intFromEnv(env, 'HOLYDECK_SYNC_DELAY_MS', 1000, 0),
  };
}
