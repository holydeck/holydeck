import { MESSAGE_CODES, REMOVED_CODES } from '@holydeck/contracts/http';
import { describe, expect, it } from 'vitest';

import {
  SettingsMountError,
  checkCorpusBoundary,
  checkCorpusIsClosed,
  checkOwnSettingsMount,
  checkReleasedContracts,
  checkSchema,
  checkSettingsMount,
  mountedPaths,
  readMountInfo,
  readSettingsText,
} from './boot.js';

import type { SchemaStatus } from './migrations.js';

const enoent = (path: string): never => {
  throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
    code: 'ENOENT',
  });
};

describe('reading the settings file', () => {
  it('returns the text of the file that is there', () => {
    expect(readSettingsText(() => 'port: 4100\n', '/data/holydeck/config/settings.yaml')).toBe(
      'port: 4100\n',
    );
  });

  it('treats a missing file as no file, because a fresh install has none', () => {
    expect(readSettingsText(enoent, '/data/holydeck/config/settings.yaml')).toBeUndefined();
  });

  it('refuses to guess when the file is there but unreadable', () => {
    const denied = (): never => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };
    expect(() => readSettingsText(denied, '/data/holydeck/config/settings.yaml')).toThrow(
      /EACCES/u,
    );
  });
});

describe('checking the released contracts before serving them', () => {
  it('accepts the registry this build ships, so the check is one the service actually passes', () => {
    expect(() => checkReleasedContracts(MESSAGE_CODES, REMOVED_CODES)).not.toThrow();
    expect(() => checkReleasedContracts()).not.toThrow();
  });

  it('refuses to serve a code that was withdrawn instead of deprecated', () => {
    expect(() => checkReleasedContracts(MESSAGE_CODES, ['auth.forbidden'])).toThrow(
      /auth\.forbidden: was removed rather than deprecated/u,
    );
  });

  it('refuses to serve a code a client is not allowed to depend on', () => {
    const unstable = [...MESSAGE_CODES, { code: 'draft.thing', status: 418, stable: false, since: 1 }];
    expect(() => checkReleasedContracts(unstable, REMOVED_CODES)).toThrow(/draft\.thing: is not marked stable/u);
  });
});

describe('grading the corpus boundary before serving anything across it', () => {
  const token = 'b'.repeat(24);

  it('accepts a library inside the deployment that this build has a credential for', () => {
    expect(() => checkCorpusBoundary({ url: 'http://corpus:8080', token })).not.toThrow();
  });

  it('has nothing to grade where no library is configured', () => {
    expect(() => checkCorpusBoundary({ url: '', token: '' })).not.toThrow();
  });

  it('refuses to start against a library the outside world could reach, naming what is wrong', () => {
    expect(() => checkCorpusBoundary({ url: 'https://corpus.example.com', token }))
      .toThrow(/binding corpus\.example\.com is not internal/u);
  });

  it('refuses to start against a library nothing has to authenticate against', () => {
    expect(() => checkCorpusBoundary({ url: 'http://corpus:8080', token: '' })).toThrow(/unauthenticated/u);
  });
});

describe('proving the corpus is closed before serving', () => {
  it('starts when the library refused an unauthenticated request', () => {
    expect(() => checkCorpusIsClosed({ reached: true, closed: true, detail: 'refused' })).not.toThrow();
  });

  it('starts when the library is not up yet, because start-up order is not a guarantee', () => {
    expect(() => checkCorpusIsClosed({ reached: false, closed: false, detail: 'not reachable' })).not.toThrow();
  });

  it('refuses to start when the library answers anyone who can reach it, quoting what it found', () => {
    expect(() => checkCorpusIsClosed({ reached: true, closed: false, detail: 'answered with 200' }))
      .toThrow(/answered with 200/u);
  });
});

describe('grading the schema before serving', () => {
  const status = (over: Partial<SchemaStatus>): SchemaStatus => ({ recorded: 1, required: 1, pending: [], ...over });

  it('starts when the database is at the version this build was written against', () => {
    expect(() => checkSchema(status({}))).not.toThrow();
  });

  it('refuses to serve a database a migration has not been run against', () => {
    expect(() => checkSchema(status({ recorded: 0, pending: [1] }))).toThrow(/dist\/migrate\.js/u);
  });

  it('refuses to serve a database a newer build has already migrated', () => {
    expect(() => checkSchema(status({ recorded: 2, pending: [] }))).toThrow(/schema version 2/u);
  });

  it('refuses to serve a database a failed run left half migrated', () => {
    const blocked = { version: 1, direction: 'up', attempt: 1, phase: 'failed' } as const;
    expect(() => checkSchema(status({ recorded: 0, pending: [], blocked }))).toThrow(/roll/u);
  });
});

describe('reading /proc/self/mountinfo for the mount points this process actually has', () => {
  const enoentMountinfo = (path: string): never => {
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
      code: 'ENOENT',
    });
  };

  it('returns the table text when there is one', () => {
    expect(readMountInfo(() => 'a mount line\n')).toBe('a mount line\n');
  });

  it('treats a missing table as no table, because a platform without one has nothing to check', () => {
    expect(readMountInfo(enoentMountinfo)).toBeUndefined();
  });

  it('refuses to guess when the table is there but unreadable', () => {
    const denied = (): never => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    };
    expect(() => readMountInfo(denied)).toThrow(/EACCES/u);
  });

  it('reads /proc/self/mountinfo by default, which is the only table this process has to consult', () => {
    let seen: string | undefined;
    readMountInfo((path) => {
      seen = path;
      return '';
    });
    expect(seen).toBe('/proc/self/mountinfo');
  });
});

describe('parsing a mount table into the paths this process sees mounted directly', () => {
  it('reads the mount point out of every line, in the field order mountinfo uses', () => {
    const text = [
      '36 35 98:0 / /data/holydeck rw,relatime master:1 - ext4 /dev/sda1 rw',
      '37 36 98:1 / /data/holydeck/config rw,relatime master:2 - ext4 /dev/sda2 rw',
    ].join('\n');
    expect(mountedPaths(text)).toEqual(new Set(['/data/holydeck', '/data/holydeck/config']));
  });

  it('un-escapes the octal sequences mountinfo uses for characters a path cannot hold literally', () => {
    const text = '38 36 98:2 / /mnt/my\\040folder rw,relatime master:3 - ext4 /dev/sda3 rw';
    expect(mountedPaths(text)).toEqual(new Set(['/mnt/my folder']));
  });

  it('reads nothing out of an empty table', () => {
    expect(mountedPaths('')).toEqual(new Set());
    expect(mountedPaths('\n')).toEqual(new Set());
  });
});

describe('refusing a settings path that is itself a mount point', () => {
  const path = '/data/holydeck/config/settings.yaml';

  it('starts when the mount is on the parent directory, which is the arrangement this needs', () => {
    expect(() => checkSettingsMount(path, new Set(['/data/holydeck/config']))).not.toThrow();
  });

  it('starts when nothing at all is mounted, because there is nothing here to catch the mistake on', () => {
    expect(() => checkSettingsMount(path, new Set())).not.toThrow();
  });

  it('refuses a settings path mounted directly, naming the path in a SettingsMountError', () => {
    let caught: unknown;
    try {
      checkSettingsMount(path, new Set([path]));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SettingsMountError);
    expect((caught as Error).name).toBe('SettingsMountError');
    expect((caught as Error).message).toContain(path);
  });
});

describe('running the whole settings-mount preflight the same way every process that reads settings does', () => {
  const path = '/data/holydeck/config/settings.yaml';

  it('starts when the injected mount table has no entry for the settings path', () => {
    expect(() => checkOwnSettingsMount(path, () => 'irrelevant line\n')).not.toThrow();
  });

  it('starts when there is no mount table at all to read', () => {
    expect(() => checkOwnSettingsMount(path, enoent)).not.toThrow();
  });

  it('refuses when the injected mount table names the settings path itself', () => {
    const line = `36 35 98:0 / ${path} rw,relatime master:1 - ext4 /dev/sda1 rw`;
    expect(() => checkOwnSettingsMount(path, () => line)).toThrow(SettingsMountError);
  });

  it('reads /proc/self/mountinfo when no reader is supplied, the same default readMountInfo uses', () => {
    let seen: string | undefined;
    checkOwnSettingsMount(path, (file) => {
      seen = file;
      return '';
    });
    expect(seen).toBe('/proc/self/mountinfo');
  });
});
