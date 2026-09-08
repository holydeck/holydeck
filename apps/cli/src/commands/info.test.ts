import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configFilePath } from '@holydeck/core/config';
import { makeContext } from '../../test/harness.js';
import { runCli } from '../program.js';
import { CLI_VERSION } from '../version.js';

describe('info', () => {
  it('prints version, mode, config path, and each value with its source', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['info'])).resolves.toBe(0);
    const out = setup.stdout();
    expect(out).toContain(`holydeck ${CLI_VERSION}`);
    expect(out).toContain('mode: local');
    expect(out).toContain(`config file: ${configFilePath(setup.ctx.platform)} (missing)`);
    expect(out).toContain(`dataDir: ${setup.dataDir} (env)`);
    expect(out).toContain('serverUrl: (not set) (default)');
    expect(out).toContain('defaultTranslations: (none) (default)');
    expect(out).toContain('syncConcurrency: 2 (default)');
    expect(out).toContain('lastSermonFile: (none)');
  });

  it('reports file-sourced values, server mode, and the last sermon file', async () => {
    const setup = makeContext();
    const configPath = configFilePath(setup.ctx.platform);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, 'defaultTranslations: [KJV, WEB]\n');
    mkdirSync(setup.dataDir, { recursive: true });
    writeFileSync(join(setup.dataDir, 'state.json'), JSON.stringify({ lastSermonFile: '/somewhere/sermon.yml' }));
    await expect(
      runCli(setup.ctx, ['info', '--server-url', 'https://holydeck.example.com']),
    ).resolves.toBe(0);
    const out = setup.stdout();
    expect(out).toContain('mode: server');
    expect(out).toContain(`config file: ${configPath}`);
    expect(out).not.toContain('(missing)');
    expect(out).toContain('defaultTranslations: KJV, WEB (file)');
    expect(out).toContain('serverUrl: https://holydeck.example.com (flag)');
    expect(out).toContain('lastSermonFile: /somewhere/sermon.yml');
  });

  it('emits the full picture as JSON with --json', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['info', '--json'])).resolves.toBe(0);
    const parsed = JSON.parse(setup.stdout()) as {
      version: string;
      mode: string;
      configFile: { path: string; exists: boolean };
      values: Record<string, unknown>;
      sources: Record<string, string>;
      lastSermonFile: string | null;
    };
    expect(parsed.version).toBe(CLI_VERSION);
    expect(parsed.mode).toBe('local');
    expect(parsed.configFile.exists).toBe(false);
    expect(parsed.values['dataDir']).toBe(setup.dataDir);
    expect(parsed.sources['dataDir']).toBe('env');
    expect(parsed.lastSermonFile).toBeNull();
  });
});
