import { describe, expect, it } from 'vitest';
import type { TranslationMeta } from '@holydeck/core/canon';
import { chapterUrl, versionUrl } from '@holydeck/core/scraper';
import { chapterHtml, makeContext, seedStore, versionMetaJson } from '../../test/harness.js';
import { runCli } from '../program.js';

// tiny canon: GEN with chapters 1 and 2 (versionMetaJson default)
function responses(): Record<string, { status: number; body: string }> {
  return {
    [versionUrl(1)]: { status: 200, body: versionMetaJson({}) },
    [chapterUrl(1, 'KJV', 'GEN', '1')]: { status: 200, body: chapterHtml('GEN', '1', { '1': 'In the beginning' }) },
    [chapterUrl(1, 'KJV', 'GEN', '2')]: { status: 200, body: chapterHtml('GEN', '2', { '1': 'Thus the heavens' }) },
  };
}

function env(): Record<string, string> {
  return { HOLYDECK_SYNC_DELAY_MS: '0' };
}

describe('sync', () => {
  it('fetches all missing chapters and prints a summary', async () => {
    const setup = makeContext({ env: env(), responses: responses() });
    await expect(runCli(setup.ctx, ['sync', 'KJV'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('KJV: 2 planned, 2 fetched, 0 unchanged, 2 new revisions, 0 failed');
    expect(setup.stderr()).toContain('[KJV] 1/2');
    expect(setup.stderr()).toContain('[KJV] 2/2');
  });

  it('uses configured default translations when no abbr is given', async () => {
    const setup = makeContext({ env: { ...env(), HOLYDECK_TRANSLATIONS: 'KJV' }, responses: responses() });
    await expect(runCli(setup.ctx, ['sync'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('KJV: 2 planned');
  });

  it('refuses when no abbr is given and none are configured', async () => {
    const setup = makeContext({ env: env() });
    await expect(runCli(setup.ctx, ['sync'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('defaultTranslations');
  });

  it('prints the plan without fetching chapters in --dry-run', async () => {
    const setup = makeContext({ env: env(), responses: { [versionUrl(1)]: { status: 200, body: versionMetaJson({}) } } });
    await expect(runCli(setup.ctx, ['sync', 'KJV', '--dry-run'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('GEN 1 (missing)');
    expect(setup.stdout()).toContain('GEN 2 (missing)');
    expect(setup.stdout()).toContain('dry run: 2 chapters would be fetched.');
  });

  it('reports changed chapters on --refresh', async () => {
    const setup = makeContext({ env: env(), responses: responses() });
    await seedStore(setup.dataDir, 'KJV', [
      { book: 'GEN', chapter: '1', verses: { '1': 'older text' }, canonVerseCount: 1 },
      { book: 'GEN', chapter: '2', verses: { '1': 'Thus the heavens' }, canonVerseCount: 1 },
    ]);
    await expect(runCli(setup.ctx, ['sync', 'KJV', '--refresh'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('1 chapters changed online: GEN 1 (new revisions created)');
    expect(setup.stdout()).toContain('KJV: 2 planned, 2 fetched, 1 unchanged, 1 new revisions, 0 failed');
  });

  it('reports a metadata build change', async () => {
    const setup = makeContext({
      env: env(),
      responses: {
        ...responses(),
        [versionUrl(1)]: { status: 200, body: versionMetaJson({ metadataBuild: 52 }) },
      },
    });
    const meta: TranslationMeta = {
      id: 1,
      abbreviation: 'KJV',
      localAbbreviation: 'KJV',
      title: 'King James Version',
      localTitle: 'King James Version',
      language: { iso6393: 'eng', name: 'English', localName: 'English', textDirection: 'ltr', languageTag: 'en' },
      metadataBuild: 51,
    };
    await seedStore(setup.dataDir, 'KJV', [], { meta });
    await expect(runCli(setup.ctx, ['sync', 'KJV'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('KJV metadata build changed 51 → 52.');
  });

  it('lists failed chapters with their error code and exits 1', async () => {
    const setup = makeContext({
      env: env(),
      responses: {
        [versionUrl(1)]: { status: 200, body: versionMetaJson({}) },
        [chapterUrl(1, 'KJV', 'GEN', '1')]: { status: 200, body: chapterHtml('GEN', '1', { '1': 'ok' }) },
        [chapterUrl(1, 'KJV', 'GEN', '2')]: { status: 500, body: 'boom' },
      },
    });
    await expect(runCli(setup.ctx, ['sync', 'KJV'])).resolves.toBe(1);
    expect(setup.stdout()).toContain('failed: GEN 2 (scrape_http_error)');
  });

  it('is local-only', async () => {
    const setup = makeContext({ env: env() });
    await expect(runCli(setup.ctx, ['sync', 'KJV', '--server-url', 'https://holydeck.example.com'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('works on the local datastore');
  });
});
