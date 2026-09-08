import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Canon } from '@holydeck/core/canon';
import { makeContext, seedStore } from '../../test/harness.js';
import { runCli } from '../program.js';

const SMALL_CANON: Canon = {
  books: [
    {
      usfm: 'GEN',
      canon: 'ot',
      name: 'Genesis',
      chapters: [
        { id: 'GEN.1', label: '1' },
        { id: 'GEN.2', label: '2' },
        { id: 'GEN.3', label: '3' },
      ],
    },
  ],
};

function storePath(dataDir: string, abbr: string): string {
  return join(dataDir, 'bibles', `${abbr}.json`);
}

describe('stats', () => {
  it('reports counts, store location, size on disk, and totals per stored translation', async () => {
    const setup = makeContext();
    await seedStore(
      setup.dataDir,
      'KJV',
      [
        { book: 'GEN', chapter: '1', verses: { '1': 'a' }, canonVerseCount: 1 },
        { book: 'GEN', chapter: '2', verses: { '1': 'b' }, canonVerseCount: 1 },
      ],
      { canon: SMALL_CANON },
    );
    await seedStore(setup.dataDir, 'WEB', [{ book: 'PSA', chapter: '117', verses: { '1': 'c' }, canonVerseCount: 2 }]);
    const kjvBytes = statSync(storePath(setup.dataDir, 'KJV')).size;
    const webBytes = statSync(storePath(setup.dataDir, 'WEB')).size;
    await expect(runCli(setup.ctx, ['stats'])).resolves.toBe(0);
    const out = setup.stdout();
    expect(out).toContain('KJV: 2/3 chapters, 2 revisions, updated 2026-09-01');
    expect(out).toContain(`  store: ${storePath(setup.dataDir, 'KJV')} (${kjvBytes} bytes)`);
    expect(out).toContain('WEB: 1/? chapters, 1 revisions, updated 2026-09-01');
    expect(out).toContain(`  store: ${storePath(setup.dataDir, 'WEB')} (${webBytes} bytes)`);
    expect(out).toContain(`total: 2 translations, ${kjvBytes + webBytes} bytes on disk`);
  });

  it('limits the report to one translation with --translation', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [{ book: 'GEN', chapter: '1', verses: { '1': 'a' }, canonVerseCount: 1 }]);
    await seedStore(setup.dataDir, 'WEB', [{ book: 'PSA', chapter: '117', verses: { '1': 'c' }, canonVerseCount: 2 }]);
    await expect(runCli(setup.ctx, ['stats', '--translation', 'kjv'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('KJV: 1/? chapters');
    expect(setup.stdout()).not.toContain('WEB:');
    expect(setup.stdout()).toContain('total: 1 translations,');
  });

  it('errors when --translation names an unstored translation', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [{ book: 'GEN', chapter: '1', verses: { '1': 'a' }, canonVerseCount: 1 }]);
    await expect(runCli(setup.ctx, ['stats', '--translation', 'SCH2000'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('Unknown translation "SCH2000"');
    expect(setup.stderr()).toContain('KJV');
  });

  it('handles an empty datastore', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['stats'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('no translations stored yet.');
  });

  it('ignores non-store files in the bibles directory', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [{ book: 'GEN', chapter: '1', verses: { '1': 'a' }, canonVerseCount: 1 }]);
    mkdirSync(join(setup.dataDir, 'bibles'), { recursive: true });
    writeFileSync(join(setup.dataDir, 'bibles', 'KJV.json.lock'), '');
    writeFileSync(join(setup.dataDir, 'bibles', 'notes.txt'), 'not a store');
    await expect(runCli(setup.ctx, ['stats'])).resolves.toBe(0);
    expect(setup.stdout().match(/KJV:/g)).toHaveLength(1);
  });

  it('emits JSON with --json including path, bytes, and totalBytes', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [{ book: 'GEN', chapter: '1', verses: { '1': 'a' }, canonVerseCount: 1 }]);
    const path = storePath(setup.dataDir, 'KJV');
    const bytes = statSync(path).size;
    await expect(runCli(setup.ctx, ['stats', '--json'])).resolves.toBe(0);
    const parsed = JSON.parse(setup.stdout()) as { translations: Array<Record<string, unknown>>; totalBytes: number };
    expect(parsed.translations).toHaveLength(1);
    expect(parsed.translations[0]).toMatchObject({ abbr: 'KJV', chapters: 1, revisions: 1, path, bytes });
    expect(parsed.totalBytes).toBe(bytes);
  });

  it('is local-only', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['stats', '--server-url', 'https://holydeck.example.com'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('works on the local datastore');
  });
});
