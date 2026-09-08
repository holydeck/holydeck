import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeContext, seedStore } from '../../test/harness.js';
import type { TestSetup } from '../../test/harness.js';
import { runCli } from '../program.js';

const psalm117 = { '1': 'O praise the LORD, all ye nations.', '2': 'For his merciful kindness is great.' };
const SERMON = 'translations: [KJV]\nverses:\n  - book: PSA\n    chapter: 117\n    verses: 1-2\n';

async function seeded(setup: TestSetup): Promise<string> {
  await seedStore(setup.dataDir, 'KJV', [{ book: 'PSA', chapter: '117', verses: psalm117 }]);
  const path = join(setup.home, 'sunday.yml');
  writeFileSync(path, SERMON);
  return path;
}

describe('get-verses', () => {
  it('renders a sermon file, footers on stderr, and remembers it for --last', async () => {
    const setup = makeContext();
    const path = await seeded(setup);
    await expect(runCli(setup.ctx, ['get-verses', path])).resolves.toBe(0);
    expect(setup.stdout()).toContain('O praise the LORD, all ye nations.');
    expect(setup.stdout()).toContain('Psalms 117:1-2 (KJV)');
    expect(setup.stderr()).toContain('source: cache · revision 1 · fetched 2026-09-01 — KJV PSA 117');
    expect(setup.stdout()).not.toContain('source: cache');
    const state = JSON.parse(readFileSync(join(setup.dataDir, 'state.json'), 'utf8')) as { lastSermonFile: string };
    expect(state.lastSermonFile).toBe(path);
  });

  it('replays the remembered file with --last', async () => {
    const setup = makeContext();
    const path = await seeded(setup);
    await expect(runCli(setup.ctx, ['get-verses', path])).resolves.toBe(0);
    const before = setup.stdout().length;
    await expect(runCli(setup.ctx, ['get-verses', '--last'])).resolves.toBe(0);
    expect(setup.stdout().length).toBeGreaterThan(before);
  });

  it('fails with no_last_sermon when --last has nothing to replay', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['get-verses', '--last'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('No sermon file remembered yet.');
  });

  it('fails when neither a file nor --last is given', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['get-verses'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('no sermon file given');
  });

  it('fails with sermon_file_missing for a nonexistent path', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['get-verses', join(setup.home, 'nope.yml')])).resolves.toBe(1);
    expect(setup.stderr()).toContain('does not exist.');
  });

  it('emits the json error envelope with --json', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['--json', 'get-verses', join(setup.home, 'nope.yml')])).resolves.toBe(1);
    const parsed = JSON.parse(setup.stderr()) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('sermon_file_missing');
  });

  it('supports --copy and --output', async () => {
    const setup = makeContext();
    const path = await seeded(setup);
    await expect(runCli(setup.ctx, ['get-verses', path, '--copy', '--output', 'render.txt'])).resolves.toBe(0);
    expect(setup.stdout()).toBe('');
    expect(setup.copies).toHaveLength(1);
    expect(setup.stderr()).toContain('Copied to clipboard.');
    expect(readFileSync(join(setup.home, 'render.txt'), 'utf8')).toContain('Psalms 117:1-2 (KJV)');
  });

  it('honors the deprecated --config-file-path alias with a warning', async () => {
    const setup = makeContext();
    const path = await seeded(setup);
    await expect(runCli(setup.ctx, ['get-verses', '--config-file-path', path])).resolves.toBe(0);
    expect(setup.stdout()).toContain('Psalms 117:1-2 (KJV)');
    expect(setup.stderr()).toContain('Flag --config-file-path is deprecated; use the <file> argument instead.');
  });

  it('honors the deprecated --template-output-format alias with a warning', async () => {
    const setup = makeContext();
    const path = await seeded(setup);
    await expect(runCli(setup.ctx, ['get-verses', path, '--template-output-format', '{0.passage}'])).resolves.toBe(0);
    expect(setup.stdout().trim()).toBe('O praise the LORD, all ye nations. For his merciful kindness is great.');
    expect(setup.stderr()).toContain('Flag --template-output-format is deprecated; use --template instead.');
  });

  it('honors the deprecated --you-version-api-url alias and switches to server mode', async () => {
    const base = 'https://holydeck.example.com';
    const setup = makeContext({
      responses: {
        [`${base}/api/v1/translations/KJV/canon`]: {
          status: 200,
          body: JSON.stringify({ books: [{ usfm: 'PSA', canon: 'ot', name: 'Psalms', chapters: [{ id: 'PSA.117', label: '117' }] }] }),
        },
        [`${base}/api/v1/translations/KJV/verses?book=PSA&chapter=117&verses=1-2`]: {
          status: 200,
          body: JSON.stringify({ verses: psalm117, citation: 'Psalms 117:1-2', revision: 3, fetchedAt: '2026-09-05T00:00:00.000Z', source: 'cache' }),
        },
      },
    });
    const path = join(setup.home, 'sunday.yml');
    writeFileSync(path, SERMON);
    await expect(runCli(setup.ctx, ['get-verses', path, '--you-version-api-url', base])).resolves.toBe(0);
    expect(setup.stdout()).toContain('Psalms 117:1-2 (KJV)');
    expect(setup.stderr()).toContain('Flag --you-version-api-url is deprecated; use --server-url instead.');
    expect(setup.stderr()).toContain('source: cache · revision 3 · fetched 2026-09-05 — KJV PSA 117');
  });

  it('renders via a configured server without any local store', async () => {
    const base = 'https://holydeck.example.com';
    const setup = makeContext({
      env: { HOLYDECK_SERVER_URL: base },
      responses: {
        [`${base}/api/v1/translations/KJV/canon`]: {
          status: 200,
          body: JSON.stringify({ books: [{ usfm: 'PSA', canon: 'ot', name: 'Psalms', chapters: [{ id: 'PSA.117', label: '117' }] }] }),
        },
        [`${base}/api/v1/translations/KJV/verses?book=PSA&chapter=117&verses=1-2`]: {
          status: 200,
          body: JSON.stringify({ verses: psalm117, citation: 'Psalms 117:1-2', revision: 1, fetchedAt: '2026-09-05T00:00:00.000Z', source: 'cache' }),
        },
      },
    });
    const path = join(setup.home, 'sunday.yml');
    writeFileSync(path, SERMON);
    await expect(runCli(setup.ctx, ['get-verses', path])).resolves.toBe(0);
    expect(setup.stdout()).toContain('O praise the LORD, all ye nations.');
  });

  it('surfaces legacy sermon format notices on stderr', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [{ book: 'PSA', chapter: '117', verses: psalm117 }]);
    const path = join(setup.home, 'legacy.yml');
    writeFileSync(path, 'version: [KJV]\nverses:\n  - book: PSA\n    chapter: 117\n    verses: 1-2\n');
    await expect(runCli(setup.ctx, ['get-verses', path])).resolves.toBe(0);
    expect(setup.stderr()).toContain('Sermon file uses the legacy format');
  });

  it('resolves relative sermon paths against cwd', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [{ book: 'PSA', chapter: '117', verses: psalm117 }]);
    mkdirSync(join(setup.home, 'sub'));
    writeFileSync(join(setup.home, 'sub', 's.yml'), SERMON);
    setup.ctx.cwd = join(setup.home, 'sub');
    await expect(runCli(setup.ctx, ['get-verses', 's.yml'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('Psalms 117:1-2 (KJV)');
  });
});
