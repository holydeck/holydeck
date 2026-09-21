import { basename, dirname } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { settingsAdminOn } from './settings-admin.js';
import { CANONICAL_SETTINGS_PATH, SettingsError, loadSettings } from './settings.js';
import { fakeSettingsIO } from '../test/helpers/settings-io.js';

const PATH = CANONICAL_SETTINGS_PATH;

const seeded = (fileText?: string, env: Record<string, string | undefined> = {}) =>
  loadSettings({ fileText, env, path: PATH });

describe('writing a change atomically', () => {
  it('writes a temp file in the same directory, then renames it onto the canonical path, and adopts the result', async () => {
    const io = fakeSettingsIO({ [PATH]: 'port: 4100\n' });
    const admin = settingsAdminOn(seeded('port: 4100\n'), { ...io, env: {} });

    const updated = await admin.update({ locale: 'de' });

    expect(updated.values).toMatchObject({ port: 4100, locale: 'de' });
    expect(admin.current().values.locale).toBe('de');
    expect(io.writes).toHaveLength(1);
    expect(io.renames).toHaveLength(1);
    expect(io.renames[0]?.to).toBe(PATH);
    expect(dirname(io.writes[0]?.path ?? '')).toBe(dirname(PATH));
    expect(io.writes[0]?.path).toBe(io.renames[0]?.from);
    expect(parse(io.files.get(PATH) ?? '')).toMatchObject({ port: 4100, locale: 'de' });
  });

  it('leaves the previous valid file intact, and the snapshot unmoved, when the rename is interrupted', async () => {
    const io = fakeSettingsIO({ [PATH]: 'port: 4100\n' });
    io.failNextRename();
    const admin = settingsAdminOn(seeded('port: 4100\n'), { ...io, env: {} });

    await expect(admin.update({ locale: 'de' })).rejects.toThrow();

    expect(io.files.get(PATH)).toBe('port: 4100\n');
    expect(io.writes).toHaveLength(1);
    expect(io.renames).toHaveLength(1);
    expect(admin.current().values.port).toBe(4100);
    expect(admin.current().values.locale).toBe('en');
  });
});

describe('validating the whole file before writing any of it', () => {
  it('applies neither field from a partial update that mixes a valid field with an invalid one', async () => {
    const io = fakeSettingsIO({ [PATH]: '' });
    const admin = settingsAdminOn(seeded(''), { ...io, env: {} });

    await expect(admin.update({ locale: 'de', port: 0 })).rejects.toThrow(SettingsError);

    expect(io.writes).toHaveLength(0);
    expect(io.renames).toHaveLength(0);
    expect(admin.current().values.locale).toBe('en');
    expect(admin.current().values.port).toBe(3000);
  });
});

describe('writability validated before anything is written', () => {
  it('rejects an unwritable media root with a named error, leaving the file untouched', async () => {
    const io = fakeSettingsIO({ [PATH]: '' });
    io.markUnwritable('/mnt/nas/media');
    const admin = settingsAdminOn(seeded(''), { ...io, env: {} });

    const failure: unknown = await admin.update({ mediaRoot: '/mnt/nas/media' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SettingsError);
    expect((failure as SettingsError).kind).toBe('unwritable');
    expect((failure as SettingsError).problems).toEqual([
      'mediaRoot: expected a writable path, but this process cannot write to "/mnt/nas/media"',
    ]);
    expect(io.writes).toHaveLength(0);
    expect(io.renames).toHaveLength(0);
    expect(admin.current().values.mediaRoot).toBe('/data/holydeck/media');
  });

  it('rejects an unwritable Restic repository the same way', async () => {
    const io = fakeSettingsIO({ [PATH]: '' });
    io.markUnwritable('/mnt/nas/restic');
    const admin = settingsAdminOn(seeded(''), { ...io, env: {} });

    const failure: unknown = await admin.update({ resticRepository: '/mnt/nas/restic' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SettingsError);
    expect((failure as SettingsError).kind).toBe('unwritable');
    expect(io.writes).toHaveLength(0);
    expect(io.renames).toHaveLength(0);
  });

  it('reports both paths at once when a single change makes neither writable', async () => {
    const io = fakeSettingsIO({ [PATH]: '' });
    io.markUnwritable('/mnt/nas/media');
    io.markUnwritable('/mnt/nas/restic');
    const admin = settingsAdminOn(seeded(''), { ...io, env: {} });

    const failure: unknown = await admin
      .update({ mediaRoot: '/mnt/nas/media', resticRepository: '/mnt/nas/restic' })
      .catch((error: unknown) => error);

    expect((failure as SettingsError).problems).toEqual([
      'mediaRoot: expected a writable path, but this process cannot write to "/mnt/nas/media"',
      'resticRepository: expected a writable path, but this process cannot write to "/mnt/nas/restic"',
    ]);
    expect(io.writes).toHaveLength(0);
  });

  it('adopts a writable path for either setting', async () => {
    const io = fakeSettingsIO({ [PATH]: '' });
    const admin = settingsAdminOn(seeded(''), { ...io, env: {} });

    const updated = await admin.update({ mediaRoot: '/mnt/nas/media' });

    expect(updated.values.mediaRoot).toBe('/mnt/nas/media');
    expect(io.writabilityChecks).toEqual(['/mnt/nas/media']);
  });
});

describe('the media root and the Restic repository are probed independently', () => {
  it('changing the Restic repository alone never probes the media root', async () => {
    const io = fakeSettingsIO({ [PATH]: '' });
    // Marked unwritable to prove it: if the untouched media root were probed too, this update would fail.
    io.markUnwritable('/data/holydeck/media');
    const admin = settingsAdminOn(seeded(''), { ...io, env: {} });

    const updated = await admin.update({ resticRepository: '/mnt/nas/restic' });

    expect(updated.values.resticRepository).toBe('/mnt/nas/restic');
    expect(updated.values.mediaRoot).toBe('/data/holydeck/media');
    expect(io.writabilityChecks).toEqual(['/mnt/nas/restic']);
  });

  it('changing the media root alone never probes the Restic repository', async () => {
    const io = fakeSettingsIO({ [PATH]: '' });
    io.markUnwritable('/data/holydeck/restic');
    const admin = settingsAdminOn(seeded(''), { ...io, env: {} });

    const updated = await admin.update({ mediaRoot: '/mnt/nas/media' });

    expect(updated.values.mediaRoot).toBe('/mnt/nas/media');
    expect(updated.values.resticRepository).toBe('/data/holydeck/restic');
    expect(io.writabilityChecks).toEqual(['/mnt/nas/media']);
  });
});

describe('the file layer a write did not touch', () => {
  it('keeps an env-sourced field env-sourced, and a file-sourced field unchanged, after a third field is written', async () => {
    const env = { HOLYDECK_PORT: '4200' };
    const fileText = 'locale: de\n';
    const seed = loadSettings({ fileText, env, path: PATH });
    expect(seed.sources.port).toBe('env');
    expect(seed.sources.locale).toBe('file');

    const io = fakeSettingsIO({ [PATH]: fileText });
    const admin = settingsAdminOn(seed, { ...io, env });

    const updated = await admin.update({ mediaRoot: '/data/holydeck/other-media' });

    expect(updated.sources.port).toBe('env');
    expect(updated.values.port).toBe(4200);
    expect(updated.sources.locale).toBe('file');
    expect(updated.values.locale).toBe('de');
    expect(updated.values.mediaRoot).toBe('/data/holydeck/other-media');
    // The write started from the raw file, not the resolved snapshot: the env-sourced port never
    // entered the file, so a later read of the file layer alone still would not find it there.
    expect(parse(io.files.get(PATH) ?? '')).not.toHaveProperty('port');
  });
});

describe('reading the file that is not there yet', () => {
  it('treats a missing settings file as an empty one, the same as a fresh install', async () => {
    const io = fakeSettingsIO();
    const admin = settingsAdminOn(seeded(''), { ...io, env: {} });

    const updated = await admin.update({ locale: 'de' });

    expect(updated.values.locale).toBe('de');
    expect(io.writes).toHaveLength(1);
  });

  it('does not swallow a read failure that is not the file simply being absent', async () => {
    const io = fakeSettingsIO({ [PATH]: 'port: 4100\n' });
    io.readFile = () => Promise.reject(new Error('the disk is unavailable'));
    const admin = settingsAdminOn(seeded('port: 4100\n'), { ...io, env: {} });

    await expect(admin.update({ locale: 'de' })).rejects.toThrow('the disk is unavailable');
  });
});

describe('refusing to write over a file already corrupted on disk', () => {
  it('refuses an update rather than merging into an empty mapping, when the existing file is not valid YAML', async () => {
    const io = fakeSettingsIO({ [PATH]: 'port: 3000\n\tlocale: en\n' });
    const admin = settingsAdminOn(seeded('port: 3000\n'), { ...io, env: {} });

    // The seed above predates the corruption, so this is the same shape the route sees: a snapshot from
    // the last good load, and a file an external hand has since broken underneath it.
    await expect(admin.update({ locale: 'de' })).rejects.toThrow(SettingsError);

    expect(io.writes).toHaveLength(0);
    expect(io.renames).toHaveLength(0);
    expect(admin.current().values.port).toBe(3000);
    expect(admin.current().values.locale).toBe('en');
  });

  it('refuses an update rather than merging into an empty mapping, when the existing file is not a mapping', async () => {
    const io = fakeSettingsIO({ [PATH]: '- port\n- locale\n' });
    const admin = settingsAdminOn(seeded('port: 3000\n'), { ...io, env: {} });

    await expect(admin.update({ locale: 'de' })).rejects.toThrow(SettingsError);

    expect(io.writes).toHaveLength(0);
    expect(io.renames).toHaveLength(0);
    expect(admin.current().values.port).toBe(3000);
    expect(admin.current().values.locale).toBe('en');
  });
});

describe('hot reload from an external edit', () => {
  it('watches the parent directory, not the file itself', () => {
    const io = fakeSettingsIO({ [PATH]: '' });
    const admin = settingsAdminOn(seeded(''), { ...io, env: {} });

    admin.watch();

    expect(io.watchedDirs).toEqual([dirname(PATH)]);
  });

  it('adopts a valid external edit when the watcher sees the file change', async () => {
    const io = fakeSettingsIO({ [PATH]: '' });
    const admin = settingsAdminOn(seeded(''), { ...io, env: {} });
    admin.watch();

    io.files.set(PATH, 'locale: de\n');
    await io.emit('change', basename(PATH));

    expect(admin.current().values.locale).toBe('de');
    expect(admin.lastReloadError()).toBeUndefined();
  });

  it('does nothing for a change event naming an unrelated file in the same directory', async () => {
    const io = fakeSettingsIO({ [PATH]: '' });
    const admin = settingsAdminOn(seeded(''), { ...io, env: {} });
    admin.watch();

    io.files.set(PATH, 'locale: de\n');
    await io.emit('change', 'unrelated.yaml');

    expect(admin.current().values.locale).toBe('en');
  });

  it('keeps the previous snapshot and records the rejection when the edit fails validation', async () => {
    const io = fakeSettingsIO({ [PATH]: '' });
    const admin = settingsAdminOn(seeded(''), { ...io, env: {} });
    admin.watch();

    io.files.set(PATH, 'port: 0\n');
    await io.emit('change', basename(PATH));

    expect(admin.current().values.port).toBe(3000);
    expect(admin.lastReloadError()).toContain('port');
  });

  it('records a read failure as a reload error too, not only a rejected value', async () => {
    const io = fakeSettingsIO({ [PATH]: '' });
    io.readFile = () => Promise.reject(new Error('the disk is unavailable'));
    const admin = settingsAdminOn(seeded(''), { ...io, env: {} });
    admin.watch();

    await io.emit('change', basename(PATH));

    expect(admin.current().values.locale).toBe('en');
    expect(admin.lastReloadError()).toContain('the disk is unavailable');
  });

  it('does not crash boot when the settings directory does not exist at all, and hands back a working close', () => {
    const io = fakeSettingsIO({ [PATH]: '' });
    io.watch = () => {
      throw Object.assign(new Error(`ENOENT: no such file or directory, watch '${dirname(PATH)}'`), { code: 'ENOENT' });
    };
    const admin = settingsAdminOn(seeded(''), { ...io, env: {} });

    const watcher = admin.watch();

    expect(() => watcher.close()).not.toThrow();
  });

  it('closes the watch it was given', () => {
    const io = fakeSettingsIO({ [PATH]: '' });
    const admin = settingsAdminOn(seeded(''), { ...io, env: {} });

    admin.watch().close();

    expect(io.closed).toBe(true);
  });
});
