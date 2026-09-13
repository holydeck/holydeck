import { describe, expect, it } from 'vitest';

import { readSettingsText } from './boot.js';

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
