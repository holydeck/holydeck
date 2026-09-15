import { LOCALES } from '@holydeck/localization/locales';
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
      corpusUrl: 'default',
      corpusToken: 'default',
      mongoUrl: 'default',
      timezone: 'default',
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
      corpusUrl: 'default',
      corpusToken: 'default',
      mongoUrl: 'default',
      timezone: 'default',
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
      HOLYDECK_CORPUS_URL: 'http://corpus:8080',
      HOLYDECK_CORPUS_TOKEN: 'c'.repeat(24),
      HOLYDECK_MONGO_URL: 'mongodb://mongo:27017/holydeck',
      HOLYDECK_TIMEZONE: 'Asia/Tokyo',
    });
    expect(loaded.values).toEqual({
      port: 8080,
      dataDir: '/srv/holydeck',
      mediaRoot: '/srv/media',
      locale: 'ta',
      corpusUrl: 'http://corpus:8080',
      corpusToken: 'c'.repeat(24),
      mongoUrl: 'mongodb://mongo:27017/holydeck',
      timezone: 'Asia/Tokyo',
    });
    expect(Object.values(loaded.sources)).toEqual(['env', 'env', 'env', 'env', 'env', 'env', 'env', 'env']);
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
  // The application accepts the locales the product ships and no others: a locale it would accept and
  // nothing translates is a deployment configured for copy that does not exist.
  it('accepts every locale the product ships, and nothing beyond them', () => {
    for (const locale of LOCALES) {
      expect(load(`locale: ${locale}\n`).values.locale).toBe(locale);
    }
    expect(problemsOf('locale: fr\n')).toEqual([
      `locale: expected one of ${LOCALES.join(', ')}, got "fr"`,
    ]);
  });

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

describe('the installation’s time zone', () => {
  it('defaults to Europe/Zurich', () => {
    const loaded = load();
    expect(loaded.values.timezone).toBe('Europe/Zurich');
    expect(loaded.sources.timezone).toBe('default');
  });

  it('is overridden by the file', () => {
    const loaded = load('timezone: America/New_York\n');
    expect(loaded.values.timezone).toBe('America/New_York');
    expect(loaded.sources.timezone).toBe('file');
  });

  it('is overridden by the environment, over the file', () => {
    const loaded = load('timezone: America/New_York\n', { HOLYDECK_TIMEZONE: 'Asia/Tokyo' });
    expect(loaded.values.timezone).toBe('Asia/Tokyo');
    expect(loaded.sources.timezone).toBe('env');
  });

  it('rejects a string that is not a real IANA identifier', () => {
    expect(problemsOf('timezone: Mordor/Barad-dur\n')).toEqual([
      'timezone: expected an IANA time zone, got "Mordor/Barad-dur"',
    ]);
    expect(problemsOf(undefined, { HOLYDECK_TIMEZONE: 'not/a-zone' })).toEqual([
      'HOLYDECK_TIMEZONE: expected an IANA time zone, got "not/a-zone"',
    ]);
  });
});

describe('the library this deployment reads scripture from', () => {
  const token = 'z'.repeat(24);
  const both = 'corpusUrl and corpusToken: set both or neither, so the library is never read without a credential';

  it('is not configured at all until a deployment configures it', () => {
    expect(load().values.corpusUrl).toBe('');
    expect(load().values.corpusToken).toBe('');
  });

  it('is read from the settings file as readily as from the environment', () => {
    const loaded = load(`corpusUrl: http://corpus:8080\ncorpusToken: ${token}\n`);
    expect(loaded.values.corpusUrl).toBe('http://corpus:8080');
    expect(loaded.values.corpusToken).toBe(token);
    expect(loaded.sources.corpusUrl).toBe('file');
  });

  it('accepts a loopback address, which is what one host running both services uses', () => {
    const loaded = load(undefined, { HOLYDECK_CORPUS_URL: 'http://127.0.0.1:8080', HOLYDECK_CORPUS_TOKEN: token });
    expect(loaded.values.corpusUrl).toBe('http://127.0.0.1:8080');
  });

  it('reads variables passed through empty as no library at all, which is what compose sends', () => {
    const loaded = load('corpusUrl: ""\ncorpusToken: ""\n', { HOLYDECK_CORPUS_URL: '', HOLYDECK_CORPUS_TOKEN: '' });
    expect(loaded.values.corpusUrl).toBe('');
    expect(loaded.values.corpusToken).toBe('');
  });

  it('refuses an address the outside world could reach, naming the host', () => {
    expect(problemsOf(undefined, { HOLYDECK_CORPUS_URL: 'https://corpus.example.com', HOLYDECK_CORPUS_TOKEN: token }))
      .toEqual(['HOLYDECK_CORPUS_URL: expected an address inside this deployment, got corpus.example.com']);
  });

  it('refuses something that is not an address it could ask', () => {
    for (const raw of ['corpus:8080', 'not an address', 'ftp://corpus']) {
      expect(problemsOf(undefined, { HOLYDECK_CORPUS_URL: raw, HOLYDECK_CORPUS_TOKEN: token }), raw)
        .toEqual([`HOLYDECK_CORPUS_URL: expected an http or https address, got ${JSON.stringify(raw)}`]);
    }
  });

  it('refuses a credential too short to be one, without ever repeating it', () => {
    const problems = problemsOf(undefined, { HOLYDECK_CORPUS_URL: 'http://corpus:8080', HOLYDECK_CORPUS_TOKEN: 'short' });
    expect(problems).toEqual(['HOLYDECK_CORPUS_TOKEN: expected a credential of at least 24 characters']);
    expect(problems.join(' ')).not.toContain('short');
  });

  it('refuses settings that are not text at all', () => {
    expect(problemsOf('corpusUrl: 8080\ncorpusToken: 12\n')).toEqual([
      'corpusUrl: expected an http or https address, got 8080',
      'corpusToken: expected a credential of at least 24 characters',
    ]);
  });

  it('refuses an address with no credential, and a credential with no address', () => {
    expect(problemsOf(undefined, { HOLYDECK_CORPUS_URL: 'http://corpus:8080' })).toEqual([both]);
    expect(problemsOf(undefined, { HOLYDECK_CORPUS_TOKEN: token })).toEqual([both]);
  });
});

describe('the durable store address', () => {
  const mongo = (raw: string): string => load(undefined, { HOLYDECK_MONGO_URL: raw }).values.mongoUrl;

  it('is empty until a deployment keeps durable records, which the presentation milestone does not', () => {
    expect(load().values.mongoUrl).toBe('');
    expect(mongo('')).toBe('');
  });

  it('accepts a service only this deployment can resolve', () => {
    expect(mongo('mongodb://mongo:27017/holydeck')).toBe('mongodb://mongo:27017/holydeck');
    expect(mongo('mongodb+srv://mongo/holydeck')).toBe('mongodb+srv://mongo/holydeck');
  });

  it('accepts a replica set, which names more than one host', () => {
    const url = 'mongodb://mongo-a:27017,mongo-b:27017,mongo-c:27017/holydeck?replicaSet=rs0';
    expect(mongo(url)).toBe(url);
  });

  it('refuses a store the rest of the world can reach, naming only the host that is wrong', () => {
    expect(problemsOf(undefined, { HOLYDECK_MONGO_URL: 'mongodb://mongo-a:27017,store.example.com:27017/db' })).toEqual([
      'HOLYDECK_MONGO_URL: expected an address inside this deployment, got store.example.com',
    ]);
  });

  it('never repeats the address back, because it may carry a credential', () => {
    const problems = problemsOf(undefined, { HOLYDECK_MONGO_URL: 'postgres://operator:hunter2@mongo:5432/holydeck' });
    expect(problems).toEqual(['HOLYDECK_MONGO_URL: expected a mongodb:// or mongodb+srv:// address']);
    expect(JSON.stringify(problems)).not.toContain('hunter2');
  });

  it('refuses an address that names no database, which the driver would otherwise choose', () => {
    expect(problemsOf(undefined, { HOLYDECK_MONGO_URL: 'mongodb://mongo:27017' })).toEqual([
      'HOLYDECK_MONGO_URL: expected the address to name a database',
    ]);
    expect(problemsOf(undefined, { HOLYDECK_MONGO_URL: 'mongodb://mongo:27017/?replicaSet=rs0' })).toEqual([
      'HOLYDECK_MONGO_URL: expected the address to name a database',
    ]);
  });

  it('refuses an address that names no host at all', () => {
    expect(problemsOf(undefined, { HOLYDECK_MONGO_URL: 'mongodb:///holydeck' })).toEqual([
      'HOLYDECK_MONGO_URL: expected a mongodb:// or mongodb+srv:// address',
    ]);
  });

  it('reads the credentials past an at sign rather than as a host', () => {
    const url = 'mongodb://operator:hunter2@mongo:27017/holydeck';
    expect(mongo(url)).toBe(url);
  });

  it('accepts a store on this machine, however the address writes the loopback host', () => {
    expect(mongo('mongodb://[::1]:27017/holydeck')).toBe('mongodb://[::1]:27017/holydeck');
    expect(mongo('mongodb://127.0.0.1:27017/holydeck')).toBe('mongodb://127.0.0.1:27017/holydeck');
  });

  it('refuses an address the file writes as something other than text', () => {
    expect(problemsOf('mongoUrl: 27017\n')).toEqual([
      'mongoUrl: expected a mongodb:// or mongodb+srv:// address',
    ]);
  });

  it('refuses a setting the file names but nothing reads under another name', () => {
    expect(load('mongoUrl: mongodb://mongo:27017/holydeck\n').sources.mongoUrl).toBe('file');
  });
});
