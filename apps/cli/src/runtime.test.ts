import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HolyDeckError } from '@holydeck/core/messages';
import { FIXED_NOW, makeContext } from '../test/harness.js';
import { createRuntime, requireLocal } from './runtime.js';

describe('createRuntime', () => {
  it('builds a local runtime from env defaults', async () => {
    const { ctx, dataDir } = makeContext();
    const runtime = await createRuntime(ctx);
    expect(runtime.mode).toBe('local');
    expect(runtime.server).toBeUndefined();
    expect(runtime.config.values.dataDir).toBe(dataDir);
    expect(runtime.config.sources.dataDir).toBe('env');
    expect(runtime.store.dataDir).toBe(dataDir);
    expect(runtime.store.now()).toBe(FIXED_NOW);
  });

  it('reads the config file and lets flags win', async () => {
    const { ctx, home } = makeContext();
    const configDir = join(home, '.config', 'holydeck');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'defaultTranslations: [KJV, NIV]\nsyncDelayMs: 250\n');
    const runtime = await createRuntime(ctx, { translations: 'NLT , AMP' });
    expect(runtime.config.values.syncDelayMs).toBe(250);
    expect(runtime.config.sources.syncDelayMs).toBe('file');
    expect(runtime.config.values.defaultTranslations).toEqual(['NLT', 'AMP']);
    expect(runtime.config.sources.defaultTranslations).toBe('flag');
  });

  it('switches to server mode when --server-url is given', async () => {
    const { ctx } = makeContext();
    const runtime = await createRuntime(ctx, { serverUrl: 'https://holydeck.example.com/' });
    expect(runtime.mode).toBe('server');
    expect(runtime.server?.baseUrl).toBe('https://holydeck.example.com');
    expect(runtime.config.sources.serverUrl).toBe('flag');
  });

  it('switches to server mode from the environment too', async () => {
    const { ctx } = makeContext({ env: { HOLYDECK_SERVER_URL: 'https://holydeck.example.com' } });
    const runtime = await createRuntime(ctx);
    expect(runtime.mode).toBe('server');
  });

  it('forwards config notices (deprecated env) to stderr', async () => {
    const { ctx, stderr } = makeContext({ env: { YOU_VERSION_CLI_API_URL: 'https://holydeck.example.com' } });
    const runtime = await createRuntime(ctx);
    expect(runtime.mode).toBe('server');
    expect(stderr()).toContain('YOU_VERSION_CLI_API_URL');
    expect(stderr()).toContain('deprecated');
  });

  it('honors --data-dir over the env', async () => {
    const { ctx, home } = makeContext();
    const runtime = await createRuntime(ctx, { dataDir: join(home, 'elsewhere') });
    expect(runtime.config.values.dataDir).toBe(join(home, 'elsewhere'));
    expect(runtime.config.sources.dataDir).toBe('flag');
  });

  it('propagates config file errors', async () => {
    const { ctx, home } = makeContext();
    const configDir = join(home, '.config', 'holydeck');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'dataDir: [not, a, string]\n');
    await expect(createRuntime(ctx)).rejects.toMatchObject({ code: expect.stringMatching(/config/) });
  });
});

describe('requireLocal', () => {
  it('passes in local mode and refuses in server mode', async () => {
    const { ctx } = makeContext();
    const local = await createRuntime(ctx);
    expect(() => requireLocal(local, 'sync')).not.toThrow();
    const server = await createRuntime(ctx, { serverUrl: 'https://holydeck.example.com' });
    const error = (() => {
      try {
        requireLocal(server, 'sync');
        return undefined;
      } catch (e) {
        return e as HolyDeckError;
      }
    })();
    expect(error?.code).toBe('local_only_command');
    expect(error?.message).toContain('"holydeck sync"');
  });
});
