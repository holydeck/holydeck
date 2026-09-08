import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HolyDeckError } from '@holydeck/core/messages';
import { FIXED_NOW, fakeLauncher, makeContext } from '../test/harness.js';
import { closeBrowsers, createRuntime, requireLocal, runtimeFlags } from './runtime.js';

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

  it('routes scrape traffic through the browser when browserFetch is on', async () => {
    const launcher = fakeLauncher('<html>from the browser</html>');
    const { ctx } = makeContext({ overrides: { browserLauncher: launcher } });
    const runtime = await createRuntime(ctx, { browserFetch: true });

    expect(runtime.browser).toBeDefined();
    // The harness has no canned HTTP response, so a plain-HTTP fetcher would have thrown.
    expect(await runtime.fetcher.get('https://www.bible.com/anything')).toBe('<html>from the browser</html>');

    await closeBrowsers();
    expect(launcher.closed()).toBe(1);
    await expect(closeBrowsers()).resolves.toBeUndefined();
  });

  it('leaves fetching on plain HTTP when browserFetch is off or no launcher exists', async () => {
    const { ctx: withLauncher } = makeContext({ overrides: { browserLauncher: fakeLauncher('x') } });
    expect((await createRuntime(withLauncher)).browser).toBeUndefined();

    const { ctx: noLauncher } = makeContext();
    expect((await createRuntime(noLauncher, { browserFetch: true })).browser).toBeUndefined();
  });

  it('maps the global options onto the flag layer', () => {
    expect(runtimeFlags({ dataDir: '/d', serverUrl: 'https://s', translations: 'KJV', browserFetch: true }))
      .toEqual({ dataDir: '/d', serverUrl: 'https://s', translations: 'KJV', browserFetch: true });
    expect(runtimeFlags({})).toEqual({
      dataDir: undefined,
      serverUrl: undefined,
      translations: undefined,
      browserFetch: undefined,
    });
  });

  it('propagates config file errors', async () => {
    const { ctx, home } = makeContext();
    const configDir = join(home, '.config', 'holydeck');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'dataDir: [not, a, string]\n');
    await expect(createRuntime(ctx)).rejects.toMatchObject({ code: expect.stringMatching(/config/) });
  });
});

describe('lock waits', () => {
  /** Holds KJV with a lock this machine's live process owns, so the waiter really has to poll. */
  const holdKjv = (dataDir: string): (() => void) => {
    const lockPath = join(dataDir, 'bibles', '.KJV.lock');
    mkdirSync(join(dataDir, 'bibles'), { recursive: true });
    writeFileSync(lockPath, `${hostname()}:${process.pid}`);
    return () => rmSync(lockPath, { force: true });
  };

  it('says the datastore is busy instead of going quiet', async () => {
    const setup = makeContext();
    const runtime = await createRuntime(setup.ctx);
    const release = holdKjv(runtime.store.dataDir);
    const acquired = runtime.store.withLock('KJV', async () => 'acquired');
    setTimeout(release, 20);
    await expect(acquired).resolves.toBe('acquired');
    expect(setup.stderr()).toContain(`KJV: datastore locked by process ${process.pid}`);
    expect(setup.stderr()).toContain('waiting for it to finish');
  });

  it('retitles a running spinner rather than writing over it', async () => {
    const setup = makeContext();
    const runtime = await createRuntime(setup.ctx);
    const titles: string[] = [];
    setup.ctx.status = (text) => titles.push(text);
    const release = holdKjv(runtime.store.dataDir);
    const acquired = runtime.store.withLock('KJV', async () => 'acquired');
    setTimeout(release, 20);
    await expect(acquired).resolves.toBe('acquired');
    expect(titles[0]).toContain('KJV: datastore locked by');
    expect(setup.stderr()).not.toContain('datastore locked');
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
