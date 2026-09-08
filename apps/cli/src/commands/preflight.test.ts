import { mkdirSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { chapterUrl } from '@holydeck/core/scraper';
import { chapterHtml, makeContext, seedStore } from '../../test/harness.js';
import { runCli } from '../program.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual };
});

const SERMON = 'translations: [KJV]\nverses:\n  - book: PSA\n    chapter: 117\n    verses: 1-2\n';

function writeSermon(home: string, text = SERMON): string {
  const path = join(home, 'sermon.yml');
  writeFileSync(path, text);
  return path;
}

describe('preflight', () => {
  it('reports ok rows and exits 0 when everything is in the store', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [
      { book: 'PSA', chapter: '117', verses: { '1': 'a', '2': 'b' }, canonVerseCount: 2 },
    ]);
    const path = writeSermon(setup.home);
    await expect(runCli(setup.ctx, ['preflight', path])).resolves.toBe(0);
    expect(setup.stdout()).toContain('ok       KJV PSA 117:1-2');
    expect(setup.stdout()).toContain('preflight: 1 ok, 0 fetched, 0 failed.');
  });

  it('fetches missing chapters and reports them as fetched', async () => {
    const setup = makeContext({
      responses: { [chapterUrl(1, 'KJV', 'PSA', '117')]: { status: 200, body: chapterHtml('PSA', '117', { '1': 'x', '2': 'y' }) } },
    });
    const path = writeSermon(setup.home);
    await expect(runCli(setup.ctx, ['preflight', path])).resolves.toBe(0);
    expect(setup.stdout()).toContain('fetched  KJV PSA 117:1-2');
    expect(setup.stdout()).toContain('preflight: 0 ok, 1 fetched, 0 failed.');
    // the fetch was persisted: a second run against the same store needs no network
    const again = makeContext({ env: { HOLYDECK_DATA_DIR: setup.dataDir } });
    await expect(runCli(again.ctx, ['preflight', path])).resolves.toBe(0);
    expect(again.stdout()).toContain('ok       KJV PSA 117:1-2');
  });

  it('marks fetch failures as failed and exits 1', async () => {
    const setup = makeContext({
      responses: { [chapterUrl(1, 'KJV', 'PSA', '117')]: { status: 500, body: 'boom' } },
    });
    const path = writeSermon(setup.home);
    await expect(runCli(setup.ctx, ['preflight', path])).resolves.toBe(1);
    expect(setup.stdout()).toContain('failed   KJV PSA 117:1-2');
    expect(setup.stdout()).toContain('preflight: 0 ok, 0 fetched, 1 failed.');
  });

  it('fails rows for unknown books and out-of-range verses', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [
      { book: 'PSA', chapter: '117', verses: { '1': 'a' }, canonVerseCount: 2 },
    ]);
    const sermon =
      'translations: [KJV]\nverses:\n  - book: XXX\n    chapter: 1\n    verses: 1\n  - book: PSA\n    chapter: 117\n    verses: 2\n';
    const path = writeSermon(setup.home, sermon);
    await expect(runCli(setup.ctx, ['preflight', path])).resolves.toBe(1);
    expect(setup.stdout()).toContain('failed   KJV XXX 1:1');
    expect(setup.stdout()).toContain('failed   KJV PSA 117:2');
    expect(setup.stdout()).toContain('missing verses: 2');
  });

  it('supports --last', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [
      { book: 'PSA', chapter: '117', verses: { '1': 'a', '2': 'b' }, canonVerseCount: 2 },
    ]);
    const path = writeSermon(setup.home);
    writeFileSync(join(setup.dataDir, 'state.json'), JSON.stringify({ lastSermonFile: path }));
    await expect(runCli(setup.ctx, ['preflight', '--last'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('preflight: 1 ok, 0 fetched, 0 failed.');
  });

  it('errors without a file argument or --last', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['preflight'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('no sermon file given');
  });

  it('validates against the server in server mode', async () => {
    const server = 'https://holydeck.example.com';
    const setup = makeContext({
      responses: {
        [`${server}/api/v1/translations/KJV/verses?book=PSA&chapter=117&verses=1-2`]: {
          status: 200,
          body: JSON.stringify({
            verses: { '1': 'a', '2': 'b' },
            citation: 'Psalms 117:1-2 (KJV)',
            revision: 3,
            fetchedAt: '2026-09-05T00:00:00.000Z',
            source: 'cache',
          }),
        },
      },
    });
    const path = writeSermon(setup.home);
    await expect(runCli(setup.ctx, ['preflight', path, '--server-url', server])).resolves.toBe(0);
    expect(setup.stdout()).toContain('ok       KJV PSA 117:1-2');
  });

  it('fails server rows when the server reports an error', async () => {
    const server = 'https://holydeck.example.com';
    const setup = makeContext({
      responses: {
        [`${server}/api/v1/translations/KJV/verses?book=PSA&chapter=117&verses=1-2`]: {
          status: 404,
          body: JSON.stringify({ error: { code: 'chapter_not_in_store', message: 'not stored' } }),
        },
      },
    });
    const path = writeSermon(setup.home);
    await expect(runCli(setup.ctx, ['preflight', path, '--server-url', server])).resolves.toBe(1);
    expect(setup.stdout()).toContain('failed   KJV PSA 117:1-2');
  });

  it('emits rows as JSON with --json', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [
      { book: 'PSA', chapter: '117', verses: { '1': 'a', '2': 'b' }, canonVerseCount: 2 },
    ]);
    const path = writeSermon(setup.home);
    await expect(runCli(setup.ctx, ['preflight', path, '--json'])).resolves.toBe(0);
    const parsed = JSON.parse(setup.stdout()) as { entries: unknown[] };
    expect(parsed.entries).toEqual([
      { reference: 'PSA 117:1-2', translation: 'KJV', status: 'ok' },
    ]);
  });

  it('fails server rows when the server response is missing a requested verse', async () => {
    const server = 'https://holydeck.example.com';
    const setup = makeContext({
      responses: {
        [`${server}/api/v1/translations/KJV/verses?book=PSA&chapter=117&verses=1-2`]: {
          status: 200,
          body: JSON.stringify({
            verses: { '1': 'a' },
            citation: 'Psalms 117:1-2 (KJV)',
            revision: 3,
            fetchedAt: '2026-09-05T00:00:00.000Z',
            source: 'cache',
          }),
        },
      },
    });
    const path = writeSermon(setup.home);
    await expect(runCli(setup.ctx, ['preflight', path, '--server-url', server])).resolves.toBe(1);
    expect(setup.stdout()).toContain('failed   KJV PSA 117:1-2');
    expect(setup.stdout()).toContain('missing verses: 2');
  });

  it('errors with --last when no sermon file has been remembered yet', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['preflight', '--last'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('No sermon file remembered yet');
  });

  it('errors when the sermon file path does not exist', async () => {
    const setup = makeContext();
    const missing = join(setup.home, 'missing.yml');
    await expect(runCli(setup.ctx, ['preflight', missing])).resolves.toBe(1);
    expect(setup.stderr()).toContain('does not exist');
  });

  it('surfaces sermon parse notices for legacy-format sermon files', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [
      { book: 'PSA', chapter: '117', verses: { '1': 'a', '2': 'b' }, canonVerseCount: 2 },
    ]);
    const path = writeSermon(setup.home, 'version: [KJV]\nverses:\n  - book: PSA\n    chapter: 117\n    verses: 1-2\n');
    await expect(runCli(setup.ctx, ['preflight', path])).resolves.toBe(0);
    expect(setup.stderr()).toContain('legacy format');
  });

  it('marks a row failed with a stringified error when a non-HolyDeckError escapes the local check', async () => {
    const setup = makeContext({
      responses: {
        [chapterUrl(1, 'KJV', 'PSA', '117')]: { status: 200, body: chapterHtml('PSA', '117', { '1': 'x', '2': 'y' }) },
      },
    });
    const path = writeSermon(setup.home);
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const openSpy = vi.spyOn(fsPromises, 'open').mockRejectedValueOnce(error as never);
    await expect(runCli(setup.ctx, ['preflight', path])).resolves.toBe(1);
    expect(setup.stdout()).toContain('failed   KJV PSA 117:1-2 — Error: permission denied');
    openSpy.mockRestore();
  });

  it('falls back to an empty verse set when a stored chapter has no revisions', async () => {
    const setup = makeContext();
    const bibleDir = join(setup.dataDir, 'bibles');
    mkdirSync(bibleDir, { recursive: true });
    writeFileSync(
      join(bibleDir, 'KJV.json'),
      JSON.stringify({
        schemaVersion: 1,
        translation: 'KJV',
        updatedAt: '2026-09-01T00:00:00.000Z',
        books: { PSA: { chapters: { '117': { canonVerseCount: 2, revisions: [] } } } },
      }),
    );
    const path = writeSermon(setup.home);
    await expect(runCli(setup.ctx, ['preflight', path])).resolves.toBe(1);
    expect(setup.stdout()).toContain('failed   KJV PSA 117:1-2 — missing verses: 1-2');
  });
});
