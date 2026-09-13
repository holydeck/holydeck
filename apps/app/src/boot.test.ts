import { MESSAGE_CODES, REMOVED_CODES } from '@holydeck/contracts/http';
import { describe, expect, it } from 'vitest';

import { checkCorpusBoundary, checkCorpusIsClosed, checkReleasedContracts, checkSchema, readSettingsText } from './boot.js';

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
