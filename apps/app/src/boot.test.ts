import { MESSAGE_CODES, REMOVED_CODES } from '@holydeck/contracts/http';
import { describe, expect, it } from 'vitest';

import { checkReleasedContracts, readSettingsText } from './boot.js';

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
