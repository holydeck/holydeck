import { describe, expect, it } from 'vitest';
import { configFilePath, dataDir, parseConfigFile, resolveConfig } from './config.js';
import { HolyDeckError } from './messages.js';
import type { PlatformInfo } from './config.js';

const darwin: PlatformInfo = { platform: 'darwin', env: {}, homeDir: '/Users/pat' };
const linux: PlatformInfo = { platform: 'linux', env: {}, homeDir: '/home/pat' };
const linuxXdg: PlatformInfo = {
  platform: 'linux',
  env: { XDG_DATA_HOME: '/xdg/data', XDG_CONFIG_HOME: '/xdg/config' },
  homeDir: '/home/pat',
};
const win32: PlatformInfo = { platform: 'win32', env: { APPDATA: 'C:\\Users\\pat\\AppData\\Roaming' }, homeDir: 'C:\\Users\\pat' };
const win32Bare: PlatformInfo = { platform: 'win32', env: {}, homeDir: 'C:\\Users\\pat' };

describe('platform paths', () => {
  it('picks the right data dir per platform', () => {
    expect(dataDir(darwin)).toBe('/Users/pat/Library/Application Support/holydeck');
    expect(dataDir(linux)).toBe('/home/pat/.local/share/holydeck');
    expect(dataDir(linuxXdg)).toBe('/xdg/data/holydeck');
    expect(dataDir(win32)).toContain('AppData');
    expect(dataDir(win32Bare)).toContain('AppData');
  });

  it('picks the config file path', () => {
    expect(configFilePath(darwin)).toBe('/Users/pat/.config/holydeck/config.yaml');
    expect(configFilePath(linuxXdg)).toBe('/xdg/config/holydeck/config.yaml');
    expect(configFilePath(win32)).toContain('holydeck');
    expect(configFilePath(win32Bare)).toContain('holydeck');
  });
});

describe('parseConfigFile', () => {
  it('parses known keys and ignores an empty document', () => {
    expect(parseConfigFile('dataDir: /tmp/hd\ndefaultTranslations: [KJV, SCH2000]\nsyncDelayMs: 250\n', 'x.yaml'))
      .toEqual({ dataDir: '/tmp/hd', defaultTranslations: ['KJV', 'SCH2000'], syncDelayMs: 250 });
    expect(parseConfigFile('', 'x.yaml')).toEqual({});
    expect(parseConfigFile('serverUrl: http://localhost:3000\ntemplate: "{{ x }}"\nsyncConcurrency: 4\n', 'x.yaml'))
      .toEqual({ serverUrl: 'http://localhost:3000', template: '{{ x }}', syncConcurrency: 4 });
  });

  it.each([
    ['[1,2]', 'config_file_unreadable'],
    ['dataDir: [nope]', 'config_invalid_value'],
    ['defaultTranslations: KJV', 'config_invalid_value'],
    ['syncConcurrency: many', 'config_invalid_value'],
    ['syncConcurrency: 0', 'config_invalid_value'],
    ['syncDelayMs: -5', 'config_invalid_value'],
    ['serverUrl: 7', 'config_invalid_value'],
    ['template: 7', 'config_invalid_value'],
    [': : :', 'config_file_unreadable'],
  ])('rejects %j with %s', (text, code) => {
    try {
      parseConfigFile(text, 'x.yaml');
      expect.unreachable();
    } catch (error) {
      expect((error as HolyDeckError).code).toBe(code);
    }
  });
});

describe('resolveConfig', () => {
  it('applies defaults with source tracking', () => {
    const resolved = resolveConfig({ platform: darwin, env: {} });
    expect(resolved.values.dataDir).toBe('/Users/pat/Library/Application Support/holydeck');
    expect(resolved.values.syncConcurrency).toBe(2);
    expect(resolved.values.syncDelayMs).toBe(1000);
    expect(resolved.values.defaultTranslations).toEqual([]);
    expect(resolved.sources.dataDir).toBe('default');
    expect(resolved.notices).toEqual([]);
  });

  it('layers file < env < flags', () => {
    const resolved = resolveConfig({
      platform: darwin,
      file: { dataDir: '/from-file', syncDelayMs: 5 },
      env: { HOLYDECK_DATA_DIR: '/from-env', HOLYDECK_TRANSLATIONS: 'kjv, sch2000,' },
      flags: { dataDir: '/from-flag' },
    });
    expect(resolved.values.dataDir).toBe('/from-flag');
    expect(resolved.sources.dataDir).toBe('flag');
    expect(resolved.values.syncDelayMs).toBe(5);
    expect(resolved.sources.syncDelayMs).toBe('file');
    expect(resolved.values.defaultTranslations).toEqual(['KJV', 'SCH2000']);
    expect(resolved.sources.defaultTranslations).toBe('env');
  });

  it('reads the remaining HOLYDECK_* env vars', () => {
    const resolved = resolveConfig({
      platform: darwin,
      env: {
        HOLYDECK_SERVER_URL: 'http://s:3000',
        HOLYDECK_TEMPLATE: 't',
        HOLYDECK_SYNC_CONCURRENCY: '4',
        HOLYDECK_SYNC_DELAY_MS: '0',
      },
    });
    expect(resolved.values.serverUrl).toBe('http://s:3000');
    expect(resolved.values.template).toBe('t');
    expect(resolved.values.syncConcurrency).toBe(4);
    expect(resolved.values.syncDelayMs).toBe(0);
  });

  it('honors deprecated aliases only when the new name is unset, with a notice', () => {
    const legacy = resolveConfig({ platform: darwin, env: { YOU_VERSION_CLI_API_URL: 'http://old:8000' } });
    expect(legacy.values.serverUrl).toBe('http://old:8000');
    expect(legacy.notices).toHaveLength(1);
    expect(legacy.notices[0]).toContain('YOU_VERSION_CLI_API_URL');

    const both = resolveConfig({
      platform: darwin,
      env: { YOU_VERSION_CLI_API_URL: 'http://old:8000', HOLYDECK_SERVER_URL: 'http://new:3000' },
    });
    expect(both.values.serverUrl).toBe('http://new:3000');
    expect(both.notices).toEqual([]);

    const template = resolveConfig({ platform: darwin, env: { YOU_VERSION_CLI_TEMPLATE_OUTPUT_FORMAT: '{0.passage}' } });
    expect(template.values.template).toBe('{0.passage}');
    expect(template.notices).toHaveLength(1);
  });

  it('treats an empty or whitespace-only numeric env var as unset rather than 0', () => {
    const resolved = resolveConfig({
      platform: darwin,
      env: { HOLYDECK_SYNC_DELAY_MS: '', HOLYDECK_SYNC_CONCURRENCY: '   ' },
    });
    expect(resolved.values.syncDelayMs).toBe(1000);
    expect(resolved.sources.syncDelayMs).toBe('default');
    expect(resolved.values.syncConcurrency).toBe(2);
    expect(resolved.sources.syncConcurrency).toBe('default');
  });

  it('rejects malformed numeric env values', () => {
    expect(() => resolveConfig({ platform: darwin, env: { HOLYDECK_SYNC_CONCURRENCY: 'zero' } }))
      .toThrowError(HolyDeckError);
    expect(() => resolveConfig({ platform: darwin, env: { HOLYDECK_SYNC_DELAY_MS: '-1' } }))
      .toThrowError(HolyDeckError);
  });

  it('ignores an explicit undefined value in a layer', () => {
    const resolved = resolveConfig({ platform: darwin, env: {}, flags: { dataDir: undefined } });
    expect(resolved.values.dataDir).toBe('/Users/pat/Library/Application Support/holydeck');
    expect(resolved.sources.dataDir).toBe('default');
  });
});
