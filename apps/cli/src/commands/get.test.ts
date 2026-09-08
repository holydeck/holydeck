import { describe, expect, it } from 'vitest';
import { makeContext, seedStore } from '../../test/harness.js';
import { runCli } from '../program.js';

const psalm118 = { '24': 'This is the day which the LORD hath made.' };

describe('get', () => {
  it('renders an ad-hoc reference with --translations', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [{ book: 'PSA', chapter: '118', verses: psalm118, canonVerseCount: 29 }]);
    await expect(runCli(setup.ctx, ['get', 'PSA 118:24', '--translations', 'KJV'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('This is the day which the LORD hath made.');
    expect(setup.stdout()).toContain('Psalms 118:24 (KJV)');
    expect(setup.stderr()).toContain('source: cache · revision 1 · fetched 2026-09-01 — KJV PSA 118');
  });

  it('renders multiple translations in configured order', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [{ book: 'PSA', chapter: '118', verses: psalm118, canonVerseCount: 29 }]);
    await seedStore(setup.dataDir, 'WEB', [
      { book: 'PSA', chapter: '118', verses: { '24': 'Synthetic second-translation text.' }, canonVerseCount: 29 },
    ]);
    await expect(runCli(setup.ctx, ['get', 'PSA 118:24', '--translations', 'KJV,WEB'])).resolves.toBe(0);
    const out = setup.stdout();
    expect(out.indexOf('(KJV)')).toBeGreaterThan(-1);
    expect(out.indexOf('(WEB)')).toBeGreaterThan(out.indexOf('(KJV)'));
    expect(out).toContain('Synthetic second-translation text.');
  });

  it('falls back to configured default translations', async () => {
    const setup = makeContext({ env: { HOLYDECK_TRANSLATIONS: 'KJV' } });
    await seedStore(setup.dataDir, 'KJV', [{ book: 'PSA', chapter: '118', verses: psalm118, canonVerseCount: 29 }]);
    await expect(runCli(setup.ctx, ['get', 'PSA 118:24'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('(KJV)');
  });

  it('refuses when no translations are configured at all', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['get', 'PSA 118:24'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('defaultTranslations');
  });

  it('rejects malformed references', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['get', 'not-a-reference', '--translations', 'KJV'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('Invalid reference');
  });

  it('supports --copy and --template', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [{ book: 'PSA', chapter: '118', verses: psalm118, canonVerseCount: 29 }]);
    await expect(
      runCli(setup.ctx, ['get', 'PSA 118:24', '--translations', 'KJV', '--copy', '--template', '{0.passage}']),
    ).resolves.toBe(0);
    expect(setup.stdout().trim()).toBe('This is the day which the LORD hath made.');
    expect(setup.copies[0]).toContain('This is the day');
  });
});
