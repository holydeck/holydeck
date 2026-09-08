import { describe, expect, it } from 'vitest';
import { makeContext, seedStore } from '../../test/harness.js';
import { runCli } from '../program.js';

describe('translations (local)', () => {
  it('lists known translations and marks stored ones', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [{ book: 'GEN', chapter: '1', verses: { '1': 'a' }, canonVerseCount: 1 }]);
    await expect(runCli(setup.ctx, ['translations'])).resolves.toBe(0);
    const lines = setup.stdout().trimEnd().split('\n');
    expect(lines).toContain('KJV      1     stored');
    expect(lines).toContain('SCH2000  157');
    expect(lines[0]).toContain('AMP'); // sorted by abbreviation
  });

  it('emits JSON with --json', async () => {
    const setup = makeContext();
    await seedStore(setup.dataDir, 'KJV', [{ book: 'GEN', chapter: '1', verses: { '1': 'a' }, canonVerseCount: 1 }]);
    await expect(runCli(setup.ctx, ['translations', '--json'])).resolves.toBe(0);
    const parsed = JSON.parse(setup.stdout()) as { translations: Array<{ abbr: string; id: number; stored: boolean }> };
    const kjv = parsed.translations.find((row) => row.abbr === 'KJV');
    expect(kjv).toEqual({ abbr: 'KJV', id: 1, stored: true });
    const niv = parsed.translations.find((row) => row.abbr === 'NIV');
    expect(niv).toEqual({ abbr: 'NIV', id: 111, stored: false });
  });
});

describe('translations (server)', () => {
  const server = 'https://holydeck.example.com';
  const body = JSON.stringify({
    translations: [
      { abbreviation: 'KJV', id: 1, title: 'King James Version', language: 'en', syncedChapters: 1189, canonChapters: 1189 },
    ],
  });

  it('lists what the server reports', async () => {
    const setup = makeContext({ responses: { [`${server}/api/v1/translations`]: { status: 200, body } } });
    await expect(runCli(setup.ctx, ['translations', '--server-url', server])).resolves.toBe(0);
    expect(setup.stdout()).toContain('KJV');
    expect(setup.stdout()).toContain('King James Version');
    expect(setup.stdout()).toContain('1189/1189 chapters');
  });

  it('emits the server rows as JSON with --json', async () => {
    const setup = makeContext({ responses: { [`${server}/api/v1/translations`]: { status: 200, body } } });
    await expect(runCli(setup.ctx, ['translations', '--server-url', server, '--json'])).resolves.toBe(0);
    const parsed = JSON.parse(setup.stdout()) as { translations: Array<{ abbreviation: string }> };
    expect(parsed.translations[0]?.abbreviation).toBe('KJV');
  });

  it('wraps server failures in the JSON error envelope', async () => {
    const setup = makeContext({ responses: { [`${server}/api/v1/translations`]: { status: 500, body: 'down' } } });
    await expect(runCli(setup.ctx, ['translations', '--server-url', server, '--json'])).resolves.toBe(1);
    const parsed = JSON.parse(setup.stderr()) as { error: { code: string } };
    expect(parsed.error.code).toBe('server_error');
  });
});
