import { resolve } from 'node:path';

import { LOCALES } from '@holydeck/localization/locales';
import { describe, expect, it } from 'vitest';

import {
  CANONICAL_SETTINGS_PATH,
  DEFAULT_SETTINGS,
  PROTECTED_SETTINGS,
  SETTINGS_SECRET_FIELDS,
  SettingsError,
  loadSettings,
  redactSettingsText,
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
      resticRepository: 'default',
      resticPassword: 'default',
      locale: 'default',
      corpusUrl: 'default',
      corpusToken: 'default',
      mongoUrl: 'default',
      timezone: 'default',
      developmentDiagnostics: 'default',
      backupDailyAt: 'default',
      backupComponents: 'default',
      backupMinimumGapMinutes: 'default',
      backupRehearsalWeekday: 'default',
      retentionSweepAt: 'default',
      notificationReadRetentionDays: 'default',
      autosaveRetentionDays: 'default',
      auditRetentionDays: 'default',
      mediaArchivedPurgeGraceDays: 'default',
      mediaUploadLimitBytes: 'default',
      mediaFreeSpaceReserveBytes: 'default',
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
      resticRepository: 'default',
      resticPassword: 'default',
      locale: 'file',
      corpusUrl: 'default',
      corpusToken: 'default',
      mongoUrl: 'default',
      timezone: 'default',
      developmentDiagnostics: 'default',
      backupDailyAt: 'default',
      backupComponents: 'default',
      backupMinimumGapMinutes: 'default',
      backupRehearsalWeekday: 'default',
      retentionSweepAt: 'default',
      notificationReadRetentionDays: 'default',
      autosaveRetentionDays: 'default',
      auditRetentionDays: 'default',
      mediaArchivedPurgeGraceDays: 'default',
      mediaUploadLimitBytes: 'default',
      mediaFreeSpaceReserveBytes: 'default',
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
      HOLYDECK_RESTIC_REPOSITORY: '/srv/restic',
      HOLYDECK_RESTIC_PASSWORD: 'r'.repeat(24),
      HOLYDECK_LOCALE: 'ta',
      HOLYDECK_CORPUS_URL: 'http://corpus:8080',
      HOLYDECK_CORPUS_TOKEN: 'c'.repeat(24),
      HOLYDECK_MONGO_URL: 'mongodb://mongo:27017/holydeck',
      HOLYDECK_TIMEZONE: 'Asia/Tokyo',
      HOLYDECK_DEVELOPMENT_DIAGNOSTICS: 'true',
      HOLYDECK_BACKUP_DAILY_AT: '01:30',
      HOLYDECK_BACKUP_COMPONENTS: 'mongo,media',
      HOLYDECK_BACKUP_MINIMUM_GAP_MINUTES: '180',
      HOLYDECK_BACKUP_REHEARSAL_WEEKDAY: 'monday',
      HOLYDECK_RETENTION_SWEEP_AT: '02:30',
      HOLYDECK_NOTIFICATION_READ_RETENTION_DAYS: '31',
      HOLYDECK_AUTOSAVE_RETENTION_DAYS: '32',
      HOLYDECK_AUDIT_RETENTION_DAYS: '401',
      HOLYDECK_MEDIA_ARCHIVED_PURGE_GRACE_DAYS: '181',
      HOLYDECK_MEDIA_UPLOAD_LIMIT_BYTES: '2147483648',
      HOLYDECK_MEDIA_FREE_SPACE_RESERVE_BYTES: '10737418240',
    });
    expect(loaded.values).toEqual({
      port: 8080,
      dataDir: '/srv/holydeck',
      mediaRoot: '/srv/media',
      resticRepository: '/srv/restic',
      resticPassword: 'r'.repeat(24),
      locale: 'ta',
      corpusUrl: 'http://corpus:8080',
      corpusToken: 'c'.repeat(24),
      mongoUrl: 'mongodb://mongo:27017/holydeck',
      timezone: 'Asia/Tokyo',
      developmentDiagnostics: true,
      backupDailyAt: '01:30',
      backupComponents: ['mongo', 'media'],
      backupMinimumGapMinutes: 180,
      backupRehearsalWeekday: 'monday',
      retentionSweepAt: '02:30',
      notificationReadRetentionDays: 31,
      autosaveRetentionDays: 32,
      auditRetentionDays: 401,
      mediaArchivedPurgeGraceDays: 181,
      mediaUploadLimitBytes: 2_147_483_648,
      mediaFreeSpaceReserveBytes: 10_737_418_240,
    });
    expect(Object.values(loaded.sources)).toEqual(Array(22).fill('env'));
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

  it('normalizes a relative override, so the exact-string mount check in boot.ts still recognizes it', () => {
    expect(settingsPath({ HOLYDECK_SETTINGS_PATH: 'config/settings.yaml' })).toBe(
      resolve('config/settings.yaml'),
    );
  });
});

describe('the Restic repository, configured separately from the media root', () => {
  it('defaults to a path under /data/holydeck, distinct from the media root', () => {
    const loaded = load();
    expect(loaded.values.resticRepository).toBe('/data/holydeck/restic');
    expect(loaded.sources.resticRepository).toBe('default');
  });

  it('is overridden by the file', () => {
    const loaded = load('resticRepository: /mnt/nas/restic\n');
    expect(loaded.values.resticRepository).toBe('/mnt/nas/restic');
    expect(loaded.sources.resticRepository).toBe('file');
  });

  it('is overridden by the environment, over the file', () => {
    const loaded = load('resticRepository: /mnt/nas/restic\n', { HOLYDECK_RESTIC_REPOSITORY: '/srv/restic' });
    expect(loaded.values.resticRepository).toBe('/srv/restic');
    expect(loaded.sources.resticRepository).toBe('env');
  });

  it('is configured independently of the media root, each free to move without the other', () => {
    const loaded = load('mediaRoot: /mnt/nas/media\nresticRepository: /mnt/nas/restic\n');
    expect(loaded.values.mediaRoot).toBe('/mnt/nas/media');
    expect(loaded.values.resticRepository).toBe('/mnt/nas/restic');
  });

  it('rejects a relative path the same way every other path field does', () => {
    expect(problemsOf('resticRepository: relative/restic\n')).toEqual([
      'resticRepository: expected an absolute path, got "relative/restic"',
    ]);
  });
});

describe('the media root and the Restic repository accept a filesystem path only', () => {
  it('has no backend-selection field: the settings schema names nothing an object-storage address could fill', () => {
    expect(Object.keys(DEFAULT_SETTINGS)).toEqual([
      'port', 'dataDir', 'mediaRoot', 'resticRepository', 'resticPassword', 'locale', 'corpusUrl', 'corpusToken',
      'mongoUrl', 'timezone', 'developmentDiagnostics',
      'backupDailyAt', 'backupComponents', 'backupMinimumGapMinutes', 'backupRehearsalWeekday',
      'retentionSweepAt', 'notificationReadRetentionDays', 'autosaveRetentionDays', 'auditRetentionDays',
      'mediaArchivedPurgeGraceDays', 'mediaUploadLimitBytes', 'mediaFreeSpaceReserveBytes',
    ]);
  });

  it('rejects an object-storage address the same way it rejects any other non-absolute value', () => {
    expect(problemsOf('mediaRoot: s3://bucket/media\n')).toEqual([
      'mediaRoot: expected an absolute path, got "s3://bucket/media"',
    ]);
    expect(problemsOf('resticRepository: s3://bucket/restic\n')).toEqual([
      'resticRepository: expected an absolute path, got "s3://bucket/restic"',
    ]);
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

describe('operations settings', () => {
  const fields = [
    'backupDailyAt',
    'backupComponents',
    'backupMinimumGapMinutes',
    'backupRehearsalWeekday',
    'retentionSweepAt',
    'notificationReadRetentionDays',
    'autosaveRetentionDays',
    'auditRetentionDays',
    'mediaArchivedPurgeGraceDays',
  ] as const;

  it('defaults every operations setting when neither layer sets it', () => {
    const loaded = load();
    for (const field of fields) {
      expect(loaded.values[field]).toEqual(DEFAULT_SETTINGS[field]);
      expect(loaded.sources[field]).toBe('default');
    }
  });

  it('reads every operations setting from the file', () => {
    const loaded = load([
      'backupDailyAt: "01:30"',
      'backupComponents: [mongo, media]',
      'backupMinimumGapMinutes: 180',
      'backupRehearsalWeekday: monday',
      'retentionSweepAt: "02:30"',
      'notificationReadRetentionDays: 31',
      'autosaveRetentionDays: 32',
      'auditRetentionDays: 401',
      'mediaArchivedPurgeGraceDays: 181',
    ].join('\n'));
    expect(loaded.values).toMatchObject({
      backupDailyAt: '01:30',
      backupComponents: ['mongo', 'media'],
      backupMinimumGapMinutes: 180,
      backupRehearsalWeekday: 'monday',
      retentionSweepAt: '02:30',
      notificationReadRetentionDays: 31,
      autosaveRetentionDays: 32,
      auditRetentionDays: 401,
      mediaArchivedPurgeGraceDays: 181,
    });
    for (const field of fields) expect(loaded.sources[field]).toBe('file');
  });

  it('lets the environment override every operations setting from the file', () => {
    const loaded = load([
      'backupDailyAt: "01:30"',
      'backupComponents: [mongo]',
      'backupMinimumGapMinutes: 180',
      'backupRehearsalWeekday: monday',
      'retentionSweepAt: "02:30"',
      'notificationReadRetentionDays: 31',
      'autosaveRetentionDays: 32',
      'auditRetentionDays: 401',
      'mediaArchivedPurgeGraceDays: 181',
    ].join('\n'), {
      HOLYDECK_BACKUP_DAILY_AT: '03:30',
      HOLYDECK_BACKUP_COMPONENTS: 'settings,media',
      HOLYDECK_BACKUP_MINIMUM_GAP_MINUTES: '181',
      HOLYDECK_BACKUP_REHEARSAL_WEEKDAY: 'tuesday',
      HOLYDECK_RETENTION_SWEEP_AT: '04:30',
      HOLYDECK_NOTIFICATION_READ_RETENTION_DAYS: '33',
      HOLYDECK_AUTOSAVE_RETENTION_DAYS: '34',
      HOLYDECK_AUDIT_RETENTION_DAYS: '402',
      HOLYDECK_MEDIA_ARCHIVED_PURGE_GRACE_DAYS: '182',
    });
    expect(loaded.values).toMatchObject({
      backupDailyAt: '03:30',
      backupComponents: ['settings', 'media'],
      backupMinimumGapMinutes: 181,
      backupRehearsalWeekday: 'tuesday',
      retentionSweepAt: '04:30',
      notificationReadRetentionDays: 33,
      autosaveRetentionDays: 34,
      auditRetentionDays: 402,
      mediaArchivedPurgeGraceDays: 182,
    });
    for (const field of fields) expect(loaded.sources[field]).toBe('env');
  });

  it('requires a zero-padded valid 24-hour time', () => {
    for (const field of ['backupDailyAt', 'retentionSweepAt']) {
      for (const raw of ['3:00', '24:00', '03:60', '', 300]) {
        expect(problemsOf(`${field}: ${typeof raw === 'string' ? JSON.stringify(raw) : raw}\n`)[0]).toContain(
          `${field}: expected HH:mm (24-hour)`,
        );
      }
    }
  });

  it('accepts backup components as YAML or comma-separated text, and deduplicates them', () => {
    expect(load('backupComponents: [mongo, media]\n').values.backupComponents).toEqual(['mongo', 'media']);
    expect(load(undefined, { HOLYDECK_BACKUP_COMPONENTS: 'mongo,media,mongo' }).values.backupComponents)
      .toEqual(['mongo', 'media']);
  });

  it('requires at least one known backup component', () => {
    expect(problemsOf('backupComponents: []\n')).toEqual(['backupComponents: expected at least one component']);
    expect(problemsOf('backupComponents: [unknown]\n')[0]).toContain('"unknown"');
  });

  it('bounds every operations retention and gap window to whole positive days or minutes', () => {
    for (const [field, max] of [
      ['backupMinimumGapMinutes', 10_080],
      ['notificationReadRetentionDays', 3_650],
      ['autosaveRetentionDays', 3_650],
      ['auditRetentionDays', 3_650],
      ['mediaArchivedPurgeGraceDays', 3_650],
    ] as const) {
      for (const raw of [0, -1, max + 1, '12.5']) {
        expect(problemsOf(`${field}: ${raw}\n`)[0]).toContain(`expected a whole number between 1 and ${max}`);
      }
    }
  });

  it('requires a lower-case named weekday', () => {
    for (const raw of ['Sunday', 'someday']) {
      expect(problemsOf(`backupRehearsalWeekday: ${raw}\n`)[0]).toContain('expected one of sunday, monday');
    }
  });

  it('does not treat operations settings as secrets', () => {
    for (const field of fields) expect(SETTINGS_SECRET_FIELDS).not.toContain(field);
  });
});

describe('media settings', () => {
  const fields = ['mediaUploadLimitBytes', 'mediaFreeSpaceReserveBytes'] as const;

  it('defaults every media setting when neither layer sets it', () => {
    const loaded = load();
    for (const field of fields) {
      expect(loaded.values[field]).toEqual(DEFAULT_SETTINGS[field]);
      expect(loaded.sources[field]).toBe('default');
    }
  });

  it('reads every media setting from the file', () => {
    const loaded = load([
      'mediaUploadLimitBytes: 2147483648',
      'mediaFreeSpaceReserveBytes: 10737418240',
    ].join('\n'));
    expect(loaded.values).toMatchObject({
      mediaUploadLimitBytes: 2_147_483_648,
      mediaFreeSpaceReserveBytes: 10_737_418_240,
    });
    for (const field of fields) expect(loaded.sources[field]).toBe('file');
  });

  it('lets the environment override every media setting from the file', () => {
    const loaded = load([
      'mediaUploadLimitBytes: 2147483648',
      'mediaFreeSpaceReserveBytes: 10737418240',
    ].join('\n'), {
      HOLYDECK_MEDIA_UPLOAD_LIMIT_BYTES: '3221225472',
      HOLYDECK_MEDIA_FREE_SPACE_RESERVE_BYTES: '21474836480',
    });
    expect(loaded.values).toMatchObject({
      mediaUploadLimitBytes: 3_221_225_472,
      mediaFreeSpaceReserveBytes: 21_474_836_480,
    });
    for (const field of fields) expect(loaded.sources[field]).toBe('env');
  });

  it('bounds the upload limit to whole bytes from 1 up to 10 GiB', () => {
    for (const raw of [0, -1, 10_737_418_240 + 1, '12.5']) {
      expect(problemsOf(`mediaUploadLimitBytes: ${raw}\n`)[0]).toContain(
        'expected a whole number between 1 and 10737418240',
      );
    }
  });

  it('bounds the free-space reserve to whole bytes from zero up to 1 TiB, zero meaning no reserve', () => {
    expect(load('mediaFreeSpaceReserveBytes: 0\n').values.mediaFreeSpaceReserveBytes).toBe(0);
    for (const raw of [-1, 1_099_511_627_776 + 1, '12.5']) {
      expect(problemsOf(`mediaFreeSpaceReserveBytes: ${raw}\n`)[0]).toContain(
        'expected a whole number between 0 and 1099511627776',
      );
    }
  });

  it('does not treat media settings as secrets', () => {
    for (const field of fields) expect(SETTINGS_SECRET_FIELDS).not.toContain(field);
  });
});

describe('developer diagnostics are off unless the deployment itself turns them on', () => {
  it('is off by default, which is what every installation that never touches it gets', () => {
    const loaded = load();
    expect(loaded.values.developmentDiagnostics).toBe(false);
    expect(loaded.sources.developmentDiagnostics).toBe('default');
    expect(DEFAULT_SETTINGS.developmentDiagnostics).toBe(false);
  });

  it('is named among the protected settings, so what is refused below is declared rather than incidental', () => {
    expect([...PROTECTED_SETTINGS]).toEqual(['developmentDiagnostics']);
  });

  // The protection. Every other setting is administrable: the settings file is what an administrator's
  // own PATCH writes into, so a setting the file accepts is a setting a signed-in account can turn on.
  // This one is refused there and readable only from the environment, which means turning it on requires
  // reaching the deployment — the compose file, the unit, the container's own definition — and not
  // merely holding the permission that manages settings.
  it('is refused from the settings file, which is the same door an administrator’s request writes through', () => {
    expect(problemsOf('developmentDiagnostics: true\n')).toEqual([
      'developmentDiagnostics: is set by this deployment only, not by the settings file',
    ]);
  });

  it('is refused from the file even when it is being set to off, so the file is never the place it lives', () => {
    expect(problemsOf('developmentDiagnostics: false\n')).toEqual([
      'developmentDiagnostics: is set by this deployment only, not by the settings file',
    ]);
  });

  it('is refused once, not twice, and does not take the rest of the file down with a second complaint', () => {
    expect(problemsOf('developmentDiagnostics: true\nport: 70000\n')).toEqual([
      'developmentDiagnostics: is set by this deployment only, not by the settings file',
      'port: expected a whole number between 1 and 65535, got 70000',
    ]);
  });

  it('is read from the environment, where only the deployment can write', () => {
    const loaded = load(undefined, { HOLYDECK_DEVELOPMENT_DIAGNOSTICS: 'true' });
    expect(loaded.values.developmentDiagnostics).toBe(true);
    expect(loaded.sources.developmentDiagnostics).toBe('env');
  });

  it('reads an explicit off the same way, so a deployment can say no as deliberately as it says yes', () => {
    const loaded = load(undefined, { HOLYDECK_DEVELOPMENT_DIAGNOSTICS: 'false' });
    expect(loaded.values.developmentDiagnostics).toBe(false);
    expect(loaded.sources.developmentDiagnostics).toBe('env');
  });

  // Anything approximate is refused rather than read as on. A variable set to "no", "0" or an empty
  // string is somebody trying to turn this off, and a loader that read any of those as truthy would turn
  // stack traces on in the one deployment that explicitly asked for them to be off.
  it('refuses a value that is neither, rather than guessing which of the two was meant', () => {
    for (const raw of ['yes', 'no', '1', '0', 'TRUE', '']) {
      expect(problemsOf(undefined, { HOLYDECK_DEVELOPMENT_DIAGNOSTICS: raw })).toEqual([
        `HOLYDECK_DEVELOPMENT_DIAGNOSTICS: expected true or false, got ${JSON.stringify(raw)}`,
      ]);
    }
  });

  it('is not a secret, so a backup carries it unredacted and an operator can see what a deployment set', () => {
    expect(SETTINGS_SECRET_FIELDS).not.toContain('developmentDiagnostics');
    expect(redactSettingsText('developmentDiagnostics: true\n')).toBe('developmentDiagnostics: true\n');
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

describe('the password the backup repository is encrypted under', () => {
  const password = 'r'.repeat(24);

  it('is empty until a deployment has one, which is what a first boot generates one into', () => {
    expect(load().values.resticPassword).toBe('');
    expect(DEFAULT_SETTINGS.resticPassword).toBe('');
  });

  it('is read from the settings file, which is where a generated one is kept', () => {
    const loaded = load(`resticPassword: ${password}\n`);
    expect(loaded.values.resticPassword).toBe(password);
    expect(loaded.sources.resticPassword).toBe('file');
  });

  // An operator who would rather hold this secret themselves — in a password manager, out of the
  // deployment entirely — sets it here, and a generated one is never written over the top of it.
  it('is read from the environment, which overrides whatever the file kept', () => {
    const loaded = load(`resticPassword: ${password}\n`, { HOLYDECK_RESTIC_PASSWORD: 'e'.repeat(32) });
    expect(loaded.values.resticPassword).toBe('e'.repeat(32));
    expect(loaded.sources.resticPassword).toBe('env');
  });

  it('refuses one too short to be a password, without ever repeating it', () => {
    const problems = problemsOf(undefined, { HOLYDECK_RESTIC_PASSWORD: 'hunter2' });
    expect(problems).toEqual(['HOLYDECK_RESTIC_PASSWORD: expected a credential of at least 24 characters']);
    expect(problems.join(' ')).not.toContain('hunter2');
  });

  it('refuses a setting that is not text at all', () => {
    expect(problemsOf('resticPassword: 12345678901234567890123456\n')).toEqual([
      'resticPassword: expected a credential of at least 24 characters',
    ]);
  });
});

// A backup keeps the settings file verbatim through Restic, so this is the one place that file is ever
// written back out somewhere new — and the one place its credential-bearing fields must not survive.
describe('redacting the settings file for a backup', () => {
  it('names exactly the fields this file holds a credential in', () => {
    expect(SETTINGS_SECRET_FIELDS).toEqual(['resticPassword', 'corpusToken', 'mongoUrl']);
  });

  // The one secret that is redacted out of the very archive it unlocks. Keeping it would put the key
  // inside the box: anyone holding the backup disk could read everything on it, which is precisely the
  // exposure encrypting the repository exists to close.
  it('strips the repository password out of the copy that goes into the repository', () => {
    const password = 'r'.repeat(24);
    const redacted = redactSettingsText(`resticPassword: ${password}\nport: 4100\n`);
    expect(redacted).not.toContain(password);
    expect(load(redacted).values.port).toBe(4100);
    expect(load(redacted).values.resticPassword).toBe('');
  });

  it('strips the corpus token and the store address, leaving every other field untouched', () => {
    const token = 'c'.repeat(24);
    const text = `port: 4100\ncorpusToken: ${token}\nmongoUrl: mongodb://operator:hunter2@mongo:27017/holydeck\n`;
    const redacted = redactSettingsText(text);
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain(token);
    const reloaded = load(redacted);
    expect(reloaded.values.port).toBe(4100);
    expect(reloaded.values.corpusToken).toBe('');
    expect(reloaded.values.mongoUrl).toBe('');
  });

  it('leaves a file with no secret set alone, byte for byte in substance', () => {
    const redacted = redactSettingsText('port: 4100\n');
    expect(load(redacted).values).toEqual({ ...DEFAULT_SETTINGS, port: 4100 });
  });

  it('redacts an empty file to itself, which is what a fresh deployment mounts', () => {
    expect(redactSettingsText('')).toBe('');
  });

  it('does not fail a backup over a file it cannot parse, and holds nothing of it back either', () => {
    expect(() => redactSettingsText('port: [\n')).not.toThrow();
    expect(redactSettingsText('port: [\n')).not.toContain('[');
  });

  // A file that parses but is not a mapping has nothing to single a secret field out from, so the whole
  // of it is withheld. Each of the three ways a document fails to be one is its own case here, because
  // a backup that exported any of them verbatim would be exporting a file nobody had looked at.
  it('withholds a whole document that is not a mapping, whichever way it fails to be one', () => {
    for (const text of ['4100\n', 'null\n', '- corpusToken: hunter2\n']) {
      const redacted = redactSettingsText(text);
      expect(redacted).not.toContain('hunter2');
      expect(redacted).toContain('omitted from the backup');
    }
  });
});
