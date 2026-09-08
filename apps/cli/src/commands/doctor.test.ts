import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configFilePath } from '@holydeck/core/config';
import { versionUrl } from '@holydeck/core/scraper';
import { makeContext, seedStore, versionMetaJson } from '../../test/harness.js';
import { runCli } from '../program.js';

const BIBLE_OK = { [versionUrl(1)]: { status: 200, body: versionMetaJson({}) } };

describe('doctor', () => {
  it('reports all-ok on a healthy local setup', async () => {
    const setup = makeContext({ responses: BIBLE_OK });
    await seedStore(setup.dataDir, 'KJV', [{ book: 'GEN', chapter: '1', verses: { '1': 'a' }, canonVerseCount: 1 }]);
    await expect(runCli(setup.ctx, ['doctor'])).resolves.toBe(0);
    const out = setup.stdout();
    expect(out).toContain('ok      config — not present (defaults apply)');
    expect(out).toContain('ok      data dir — writable');
    expect(out).toContain('ok      datastore — 1 translations valid');
    expect(out).toContain('ok      bible.com — reachable');
    expect(out).toContain('skipped server — no server configured');
  });

  it('reports the config file path when one is present and parses cleanly', async () => {
    const setup = makeContext({ responses: BIBLE_OK });
    const path = configFilePath(setup.ctx.platform);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'defaultTranslations: [WEB]\n');
    await expect(runCli(setup.ctx, ['doctor'])).resolves.toBe(0);
    expect(setup.stdout()).toContain(`ok      config — parsed ${path}`);
  });

  it('fails the config check on a broken config file but still runs the others', async () => {
    const setup = makeContext({ responses: BIBLE_OK });
    const path = configFilePath(setup.ctx.platform);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, ':\nnot yaml: [unclosed');
    await expect(runCli(setup.ctx, ['doctor'])).resolves.toBe(1);
    expect(setup.stdout()).toContain('fail    config —');
    expect(setup.stdout()).toContain('bible.com');
  });

  it('skips the data dir and datastore checks when config fails and no data dir is known', async () => {
    const setup = makeContext({ responses: BIBLE_OK, env: { HOLYDECK_DATA_DIR: undefined } });
    const path = configFilePath(setup.ctx.platform);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, ':\nnot yaml: [unclosed');
    await expect(runCli(setup.ctx, ['doctor'])).resolves.toBe(1);
    expect(setup.stdout()).toContain('skipped data dir — unknown (config failed)');
    expect(setup.stdout()).toContain('skipped datastore — unknown (config failed)');
  });

  it('fails the data dir check when the directory cannot be created', async () => {
    const setup = makeContext({ responses: BIBLE_OK });
    writeFileSync(setup.dataDir, 'a file blocking the data dir');
    await expect(runCli(setup.ctx, ['doctor'])).resolves.toBe(1);
    expect(setup.stdout()).toContain('fail    data dir —');
  });

  it('fails the datastore check on a corrupt store file', async () => {
    const setup = makeContext({ responses: BIBLE_OK });
    mkdirSync(join(setup.dataDir, 'bibles'), { recursive: true });
    writeFileSync(join(setup.dataDir, 'bibles', 'KJV.json'), '{ broken');
    await expect(runCli(setup.ctx, ['doctor'])).resolves.toBe(1);
    expect(setup.stdout()).toContain('fail    datastore —');
  });

  it('warns when a stored revision fails its content-hash spot check', async () => {
    const setup = makeContext({ responses: BIBLE_OK });
    await seedStore(setup.dataDir, 'KJV', [{ book: 'GEN', chapter: '1', verses: { '1': 'a' }, canonVerseCount: 1 }]);
    const path = join(setup.dataDir, 'bibles', 'KJV.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      books: Record<string, { chapters: Record<string, { revisions: Array<{ verses: Record<string, string> }> }> }>;
    };
    const record = file.books['GEN']?.chapters['1'];
    if (record?.revisions[0]) record.revisions[0].verses['1'] = 'tampered';
    writeFileSync(path, JSON.stringify(file));
    await expect(runCli(setup.ctx, ['doctor'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('warn    datastore —');
    expect(setup.stdout()).toContain('content hash mismatch');
  });

  it('treats a chapter record with no revisions as nothing to spot-check', async () => {
    const setup = makeContext({ responses: BIBLE_OK });
    await seedStore(setup.dataDir, 'KJV', [{ book: 'GEN', chapter: '1', verses: { '1': 'a' }, canonVerseCount: 1 }]);
    const path = join(setup.dataDir, 'bibles', 'KJV.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      books: Record<string, { chapters: Record<string, { revisions: unknown[] }> }>;
    };
    const record = file.books['GEN']?.chapters['1'];
    if (record) record.revisions = [];
    writeFileSync(path, JSON.stringify(file));
    await expect(runCli(setup.ctx, ['doctor'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('ok      datastore — 1 translations valid');
  });

  it('warns when bible.com serves a challenge page and fails when unreachable', async () => {
    const challenged = makeContext({
      responses: { [versionUrl(1)]: { status: 200, body: '<html><title>Client Challenge</title></html>' } },
    });
    await expect(runCli(challenged.ctx, ['doctor'])).resolves.toBe(0);
    expect(challenged.stdout()).toContain('warn    bible.com — reachable but blocked');

    const down = makeContext({ responses: { [versionUrl(1)]: { status: 503, body: 'nope' } } });
    await expect(runCli(down.ctx, ['doctor'])).resolves.toBe(1);
    expect(down.stdout()).toContain('fail    bible.com —');
  });

  it('fails the bible.com check when the request throws', async () => {
    const setup = makeContext({ responses: {} });
    await expect(runCli(setup.ctx, ['doctor'])).resolves.toBe(1);
    expect(setup.stdout()).toContain('fail    bible.com —');
  });

  it('checks server health in server mode and skips local store checks', async () => {
    const server = 'https://holydeck.example.com';
    const setup = makeContext({
      responses: {
        ...BIBLE_OK,
        [`${server}/health`]: {
          status: 200,
          body: JSON.stringify({ status: 'ok', version: '0.0.0', uptime: 12, store: 'mongo' }),
        },
      },
    });
    await expect(runCli(setup.ctx, ['doctor', '--server-url', server])).resolves.toBe(0);
    expect(setup.stdout()).toContain('skipped datastore — server mode');
    expect(setup.stdout()).toContain('ok      server — mongo store, up 12s');
  });

  it('fails the server check when the server is down', async () => {
    const server = 'https://holydeck.example.com';
    const setup = makeContext({
      responses: { ...BIBLE_OK, [`${server}/health`]: { status: 500, body: 'dead' } },
    });
    await expect(runCli(setup.ctx, ['doctor', '--server-url', server])).resolves.toBe(1);
    expect(setup.stdout()).toContain('fail    server —');
  });

  it('emits checks as JSON with --json', async () => {
    const setup = makeContext({ responses: BIBLE_OK });
    await expect(runCli(setup.ctx, ['doctor', '--json'])).resolves.toBe(0);
    const parsed = JSON.parse(setup.stdout()) as { checks: Array<{ name: string; status: string; detail: string }> };
    expect(parsed.checks.map((check) => check.name)).toEqual(['config', 'data dir', 'datastore', 'bible.com', 'server']);
  });
});
