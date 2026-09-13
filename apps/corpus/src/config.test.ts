import { describe, expect, it } from 'vitest';
import { HolyDeckError } from '@holydeck/core/messages';
import { resolveServerConfig } from './config.js';

function thrownCode(env: NodeJS.ProcessEnv): string {
  try {
    resolveServerConfig(env);
    return 'did not throw';
  } catch (error) {
    return error instanceof HolyDeckError ? error.code : 'not a HolyDeckError';
  }
}

describe('resolveServerConfig', () => {
  it('returns documented defaults for an empty environment', () => {
    expect(resolveServerConfig({})).toEqual({
      host: '0.0.0.0',
      port: 3000,
      mongoUrl: 'mongodb://127.0.0.1:27017',
      mongoDb: 'holydeck',
      logLevel: 'info',
      syncConcurrency: 2,
      syncDelayMs: 1000,
      browserFetch: false,
    });
  });

  it('reads every HOLYDECK_* override', () => {
    expect(
      resolveServerConfig({
        HOLYDECK_HOST: '127.0.0.1',
        HOLYDECK_PORT: '8080',
        HOLYDECK_MONGO_URL: 'mongodb://db.example.com:27017',
        HOLYDECK_MONGO_DB: 'bibles',
        HOLYDECK_LOG_LEVEL: 'debug',
        HOLYDECK_SYNC_CONCURRENCY: '4',
        HOLYDECK_SYNC_DELAY_MS: '0',
        HOLYDECK_BROWSER_FETCH: 'true',
        HOLYDECK_BROWSER_EXECUTABLE: '/usr/bin/chromium',
      }),
    ).toEqual({
      host: '127.0.0.1',
      port: 8080,
      mongoUrl: 'mongodb://db.example.com:27017',
      mongoDb: 'bibles',
      logLevel: 'debug',
      syncConcurrency: 4,
      syncDelayMs: 0,
      browserFetch: true,
      browserExecutablePath: '/usr/bin/chromium',
    });
  });

  it('treats an empty string as unset', () => {
    expect(resolveServerConfig({ HOLYDECK_PORT: '' }).port).toBe(3000);
    expect(resolveServerConfig({ HOLYDECK_BROWSER_EXECUTABLE: '' })).not.toHaveProperty('browserExecutablePath');
    expect(resolveServerConfig({ HOLYDECK_BROWSER_FETCH: '  ' }).browserFetch).toBe(false);
  });

  it.each([
    ['1', true],
    ['YES', true],
    [' on ', true],
    ['0', false],
    ['false', false],
    ['OFF', false],
  ])('reads HOLYDECK_BROWSER_FETCH=%j as %s', (raw, expected) => {
    expect(resolveServerConfig({ HOLYDECK_BROWSER_FETCH: raw }).browserFetch).toBe(expected);
  });

  it('rejects non-integer, too-small and too-large values with config_invalid_value', () => {
    expect(thrownCode({ HOLYDECK_PORT: 'abc' })).toBe('config_invalid_value');
    expect(thrownCode({ HOLYDECK_PORT: '3.5' })).toBe('config_invalid_value');
    expect(thrownCode({ HOLYDECK_PORT: '0' })).toBe('config_invalid_value');
    expect(thrownCode({ HOLYDECK_PORT: '70000' })).toBe('config_invalid_value');
    expect(thrownCode({ HOLYDECK_SYNC_CONCURRENCY: '0' })).toBe('config_invalid_value');
    expect(thrownCode({ HOLYDECK_SYNC_DELAY_MS: '-1' })).toBe('config_invalid_value');
    expect(thrownCode({ HOLYDECK_BROWSER_FETCH: 'maybe' })).toBe('config_invalid_value');
  });

  it('explains the allowed range in the error message', () => {
    try {
      resolveServerConfig({ HOLYDECK_PORT: '70000' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('between 1 and 65535');
    }
    try {
      resolveServerConfig({ HOLYDECK_SYNC_CONCURRENCY: '0' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('integer >= 1');
    }
  });

  it('reads process.env by default', () => {
    const previous = process.env.HOLYDECK_MONGO_DB;
    process.env.HOLYDECK_MONGO_DB = 'from-process-env';
    try {
      expect(resolveServerConfig().mongoDb).toBe('from-process-env');
    } finally {
      if (previous === undefined) delete process.env.HOLYDECK_MONGO_DB;
      else process.env.HOLYDECK_MONGO_DB = previous;
    }
  });
});
