import { describe, expect, it } from 'vitest';

import {
  CANONICAL_SETTINGS_PATH,
  DEFAULT_SETTINGS,
  SettingsError,
  loadSettings,
  settingsPath,
} from './settings.js';

const load = (fileText?: string, env: Record<string, string | undefined> = {}) =>
  loadSettings({ fileText, env, path: CANONICAL_SETTINGS_PATH });

const problemsOf = (
  fileText?: string,
  env: Record<string, string | undefined> = {},
): readonly string[] => {
  try {
    load(fileText, env);
  } catch (error) {
    if (error instanceof SettingsError) return error.problems;
    throw error;
  }
  throw new Error('expected the settings to be refused');
};

describe('precedence', () => {
  it('falls back to the defaults and says so for every value', () => {
    const loaded = load();
    expect(loaded.values).toEqual(DEFAULT_SETTINGS);
    expect(loaded.sources).toEqual({
      port: 'default',
      dataDir: 'default',
      mediaRoot: 'default',
      locale: 'default',
    });
    expect(loaded.path).toBe(CANONICAL_SETTINGS_PATH);
  });

  it('lets the file override a default and leaves the rest alone', () => {
    const loaded = load('port: 4100\nlocale: de\n');
    expect(loaded.values.port).toBe(4100);
    expect(loaded.values.locale).toBe('de');
    expect(loaded.values.dataDir).toBe(DEFAULT_SETTINGS.dataDir);
    expect(loaded.sources).toEqual({
      port: 'file',
      dataDir: 'default',
      mediaRoot: 'default',
      locale: 'file',
    });
  });

  it('lets the environment override the file, which is what a container needs', () => {
    const loaded = load('port: 4100\nlocale: de\n', { HOLYDECK_PORT: '4200' });
    expect(loaded.values.port).toBe(4200);
    expect(loaded.values.locale).toBe('de');
    expect(loaded.sources.port).toBe('env');
    expect(loaded.sources.locale).toBe('file');
  });

  it('reads every setting from the environment when nothing else is set', () => {
    const loaded = load(undefined, {
      HOLYDECK_PORT: '8080',
      HOLYDECK_DATA_DIR: '/srv/holydeck',
      HOLYDECK_MEDIA_ROOT: '/srv/media',
      HOLYDECK_LOCALE: 'ta',
    });
    expect(loaded.values).toEqual({
      port: 8080,
      dataDir: '/srv/holydeck',
      mediaRoot: '/srv/media',
      locale: 'ta',
    });
    expect(Object.values(loaded.sources)).toEqual(['env', 'env', 'env', 'env']);
  });
});

describe('zero configuration', () => {
  it('answers with the defaults at the canonical path when asked about nothing at all', () => {
    const loaded = loadSettings({});

    expect(loaded.values).toEqual(DEFAULT_SETTINGS);
    expect(loaded.path).toBe(CANONICAL_SETTINGS_PATH);
    expect(loaded.sources.port).toBe('default');
  });
});

describe('validation', () => {
  it('reports every problem at once, because a deployment fixes them in one pass', () => {
    expect(problemsOf('port: 0\nlocale: fr\ndataDir: ""\n')).toEqual([
      'port: expected a whole number between 1 and 65535, got 0',
      'dataDir: expected an absolute path, got ""',
      'locale: expected one of en, de, ta, got "fr"',
    ]);
  });

  it('refuses a key nobody reads instead of ignoring it', () => {
    expect(problemsOf('prot: 4100\n')).toEqual(['prot: unknown setting']);
  });

  it('refuses a file that is not a mapping, and one that is not YAML at all', () => {
    expect(problemsOf('- port\n')).toEqual([`${CANONICAL_SETTINGS_PATH}: expected a mapping of settings`]);
    expect(problemsOf('port: [\n')).toEqual([`${CANONICAL_SETTINGS_PATH}: is not valid YAML`]);
  });

  it('names the environment variable rather than the setting when the environment is at fault', () => {
    expect(problemsOf(undefined, { HOLYDECK_PORT: 'http' })).toEqual([
      'HOLYDECK_PORT: expected a whole number between 1 and 65535, got "http"',
    ]);
  });

  it('accepts an empty file, which is what a fresh deployment mounts', () => {
    expect(load('').values).toEqual(DEFAULT_SETTINGS);
    expect(load('# nothing set yet\n').values).toEqual(DEFAULT_SETTINGS);
  });
});

describe('the settings path', () => {
  // The deployment mounts the parent directory and never the file, because an atomic replace
  // changes the inode and a file-level bind mount would keep serving the old one.
  it('is the canonical path unless the environment moves it', () => {
    expect(settingsPath({})).toBe(CANONICAL_SETTINGS_PATH);
    expect(CANONICAL_SETTINGS_PATH).toBe('/data/holydeck/config/settings.yaml');
    expect(settingsPath({ HOLYDECK_SETTINGS_PATH: '/etc/holydeck/settings.yaml' })).toBe(
      '/etc/holydeck/settings.yaml',
    );
  });
});
