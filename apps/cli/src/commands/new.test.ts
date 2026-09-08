import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSermonFile } from '@holydeck/core/sermon';
import { makeContext } from '../../test/harness.js';
import { runCli } from '../program.js';
import { sermonFileName, sermonScaffold } from './new.js';

describe('sermonFileName', () => {
  it('uses today when no name is given', () => {
    expect(sermonFileName(undefined, '2026-09-08')).toBe('2026-09-08.yml');
  });

  it('uses a date name as-is', () => {
    expect(sermonFileName('2026-12-24', '2026-09-08')).toBe('2026-12-24.yml');
  });

  it('prefixes non-date names with today', () => {
    expect(sermonFileName('advent', '2026-09-08')).toBe('2026-09-08-advent.yml');
  });
});

describe('sermonScaffold', () => {
  it('produces a valid sermon file with the given translations', () => {
    const sermon = parseSermonFile(sermonScaffold(['KJV', 'WEB']));
    expect(sermon.translations).toEqual(['KJV', 'WEB']);
    expect(sermon.entries).toHaveLength(1);
    expect(sermon.notices).toEqual([]);
  });

  it('defaults to KJV when nothing is configured', () => {
    expect(parseSermonFile(sermonScaffold([])).translations).toEqual(['KJV']);
  });
});

describe('new', () => {
  it('creates the file, prints its path, remembers it, and skips the editor when not a TTY', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['new'])).resolves.toBe(0);
    const path = join(setup.home, '2026-09-08.yml');
    expect(setup.stdout().trim()).toBe(path);
    expect(existsSync(path)).toBe(true);
    expect(setup.edits).toEqual([]);
    const state = JSON.parse(readFileSync(join(setup.dataDir, 'state.json'), 'utf8')) as { lastSermonFile: string };
    expect(state.lastSermonFile).toBe(path);
  });

  it('opens the editor when attached to a TTY', async () => {
    const setup = makeContext({ overrides: { isTTY: true } });
    await expect(runCli(setup.ctx, ['new', 'advent'])).resolves.toBe(0);
    expect(setup.edits).toEqual([join(setup.home, '2026-09-08-advent.yml')]);
  });

  it('respects --no-edit even on a TTY', async () => {
    const setup = makeContext({ overrides: { isTTY: true } });
    await expect(runCli(setup.ctx, ['new', '--no-edit'])).resolves.toBe(0);
    expect(setup.edits).toEqual([]);
  });

  it('notices when the editor is skipped because $EDITOR is unset', async () => {
    const setup = makeContext({ overrides: { isTTY: true, editor: async () => 'skipped' } });
    await expect(runCli(setup.ctx, ['new'])).resolves.toBe(0);
    expect(setup.stderr()).toContain('$EDITOR is not set; skipping editor launch.');
  });

  it('seeds configured default translations into the scaffold', async () => {
    const setup = makeContext({ env: { HOLYDECK_TRANSLATIONS: 'WEB,KJV' } });
    await expect(runCli(setup.ctx, ['new'])).resolves.toBe(0);
    const text = readFileSync(join(setup.home, '2026-09-08.yml'), 'utf8');
    expect(parseSermonFile(text).translations).toEqual(['WEB', 'KJV']);
  });

  it('refuses to overwrite an existing file', async () => {
    const setup = makeContext();
    writeFileSync(join(setup.home, '2026-09-08.yml'), 'existing');
    await expect(runCli(setup.ctx, ['new'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('already exists; refusing to overwrite.');
    expect(readFileSync(join(setup.home, '2026-09-08.yml'), 'utf8')).toBe('existing');
  });
});
