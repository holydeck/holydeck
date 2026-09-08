import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '@holydeck/core/file-store';
import { getChapter } from '@holydeck/core/storage';
import { makeContext, seedStore } from '../../test/harness.js';
import { runCli } from '../program.js';

describe('import', () => {
  it('imports a valid export into the datastore and summarizes', async () => {
    const donor = makeContext();
    await seedStore(donor.dataDir, 'KJV', [
      { book: 'PSA', chapter: '117', verses: { '1': 'O praise the LORD' }, canonVerseCount: 2 },
    ]);
    const exportPath = join(donor.home, 'KJV-export.json');
    writeFileSync(exportPath, readFileSync(join(donor.dataDir, 'bibles', 'KJV.json')));

    const setup = makeContext();
    setup.ctx.cwd = donor.home;
    await expect(runCli(setup.ctx, ['import', 'KJV-export.json'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('imported into KJV: 1 new chapters, 1 added revisions.');
    const store = new FileStore(setup.dataDir, { now: () => '2026-09-08T12:00:00.000Z' });
    const file = await store.load('KJV');
    expect(getChapter(file, 'PSA', '117')).toBeDefined();
  });

  it('reports zero changes when re-importing the same file', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [
      { book: 'PSA', chapter: '117', verses: { '1': 'O praise the LORD' }, canonVerseCount: 2 },
    ]);
    const exportPath = join(setup.home, 'again.json');
    writeFileSync(exportPath, readFileSync(join(setup.dataDir, 'bibles', 'KJV.json')));
    await expect(runCli(setup.ctx, ['import', exportPath])).resolves.toBe(0);
    expect(setup.stdout()).toContain('imported into KJV: 0 new chapters, 0 added revisions.');
  });

  it('rejects files that are not JSON', async () => {
    const setup = makeContext();
    const path = join(setup.home, 'broken.json');
    writeFileSync(path, 'not json {');
    await expect(runCli(setup.ctx, ['import', path])).resolves.toBe(1);
    expect(setup.stderr().toLowerCase()).toContain('corrupt');
  });

  it('rejects JSON that is not a store file', async () => {
    const setup = makeContext();
    const path = join(setup.home, 'wrong.json');
    writeFileSync(path, JSON.stringify({ hello: 'world' }));
    await expect(runCli(setup.ctx, ['import', path])).resolves.toBe(1);
    expect(setup.stderr().toLowerCase()).toContain('corrupt');
  });

  it('errors on a missing file', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['import', join(setup.home, 'nope.json')])).resolves.toBe(1);
    expect(setup.stderr().toLowerCase()).toContain('corrupt');
  });

  it('is local-only', async () => {
    const setup = makeContext();
    await expect(
      runCli(setup.ctx, ['import', 'x.json', '--server-url', 'https://holydeck.example.com']),
    ).resolves.toBe(1);
    expect(setup.stderr()).toContain('works on the local datastore');
  });
});
