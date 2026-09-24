import { describe, expect, it } from 'vitest';
import { HolyDeckError } from '@holydeck/core/messages';
import type { TranslationMeta } from '@holydeck/core/canon';
import { chapterUrl, versionUrl } from '@holydeck/core/scraper';
import { chapterHtml, makeContext, seedStore, versionMetaJson } from '../../test/harness.js';
import type { TestSetup } from '../../test/harness.js';
import { runCli } from '../program.js';
import { createRuntime, runtimeFlags } from '../runtime.js';
import type { Runtime } from '../runtime.js';
import type { ServerClient, ServerSyncJobStatus } from '../server-client.js';
import { runSyncServer } from './sync.js';

/** Builds a real Runtime (config/store/fetcher) in server mode, then swaps in a hand-scripted
 *  ServerClient — this is the seam T7 needs to unit-test polling without real HTTP. */
async function serverSetup(
  env: Record<string, string> = {},
  server?: ServerClient,
  overrides: Parameters<typeof makeContext>[0] = {},
): Promise<TestSetup & { runtime: Runtime }> {
  const setup = makeContext({
    env: { HOLYDECK_SERVER_URL: 'https://s.test', HOLYDECK_SYNC_POLL_INTERVAL_MS: '1', ...env },
    ...overrides,
  });
  const runtime = await createRuntime(setup.ctx, runtimeFlags({}));
  if (server !== undefined) runtime.server = server;
  return { ...setup, runtime };
}

function fakeServer(script: {
  sync?: (abbr: string, options: { refresh?: boolean }) => Promise<ServerSyncJobStatus>;
  syncStatus?: (abbr: string) => Promise<ServerSyncJobStatus | undefined>;
}): ServerClient {
  return {
    sync: script.sync ?? (async () => { throw new Error('sync not scripted'); }),
    syncStatus: script.syncStatus ?? (async () => { throw new Error('syncStatus not scripted'); }),
    stats: async () => { throw new Error('not used'); },
    health: async () => { throw new Error('not used'); },
    getTranslations: async () => { throw new Error('not used'); },
    getCanon: async () => { throw new Error('not used'); },
    getVerses: async () => { throw new Error('not used'); },
    render: async () => { throw new Error('not used'); },
  } as unknown as ServerClient;
}

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

  it('stops early on an interrupt, keeping what it fetched, and says how to resume', async () => {
    const controller = new AbortController();
    const canned = responses();
    const setup = makeContext({
      env: { ...env(), HOLYDECK_SYNC_CONCURRENCY: '1' },
      responses: canned,
      overrides: {
        abortSignal: controller.signal,
        httpGet: async (url: string) => {
          const response = canned[url];
          if (response === undefined) throw new Error(`no canned response for GET ${url}`);
          if (url.endsWith('GEN.1.KJV')) controller.abort();
          return response;
        },
      },
    });
    await expect(runCli(setup.ctx, ['sync', 'KJV'])).resolves.toBe(130);
    expect(setup.stdout()).toContain('KJV: 2 planned, 1 fetched');
    expect(setup.stdout()).toContain('KJV: stopped early — run sync again to continue where it left off.');
  });

});

describe('sync in server mode', () => {
  it('refuses --dry-run with local_only_option', async () => {
    const setup = await serverSetup();
    await expect(runCli(setup.ctx, ['sync', 'KJV', '--dry-run'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('"--dry-run" is local-only and not available in server mode');
  });

  it('polls until completion and prints a done/total line per tick', async () => {
    const polls: ServerSyncJobStatus[] = [
      { translation: 'KJV', state: 'running', refresh: false, startedAt: 't', progress: { done: 0, total: 2 } },
      { translation: 'KJV', state: 'running', refresh: false, startedAt: 't', progress: { done: 1, total: 2 } },
      { translation: 'KJV', state: 'running', refresh: false, startedAt: 't', progress: { done: 2, total: 2 } },
      {
        translation: 'KJV',
        state: 'completed',
        refresh: false,
        startedAt: 't',
        finishedAt: 't2',
        progress: { done: 2, total: 2 },
        report: { planned: 2, fetched: 2, unchanged: 0, newRevisions: 2, failed: [] },
      },
    ];
    let i = 0;
    const setup = await serverSetup(
      {},
      fakeServer({ sync: async () => polls[0]!, syncStatus: async () => polls[Math.min(++i, polls.length - 1)]! }),
    );
    await runSyncServer(setup.ctx, setup.runtime, ['KJV'], {});
    expect(setup.stderr()).toContain('[KJV] 0/2');
    expect(setup.stderr()).toContain('[KJV] 1/2');
    expect(setup.stderr()).toContain('[KJV] 2/2');
    expect(setup.stdout()).toContain('KJV: 2 planned, 2 fetched, 0 unchanged, 2 new revisions, 0 failed');
  });

  it('attaches to an already-running job on a 409 instead of failing', async () => {
    const running: ServerSyncJobStatus = {
      translation: 'KJV',
      state: 'completed',
      refresh: false,
      startedAt: 't',
      finishedAt: 't2',
      progress: { done: 2, total: 2 },
      report: { planned: 2, fetched: 2, unchanged: 0, newRevisions: 0, failed: [] },
    };
    const setup = await serverSetup(
      {},
      fakeServer({
        sync: async () => {
          throw new HolyDeckError('server_error', { status: 409, url: 'https://s.test/api/v1/translations/KJV/sync', message: 'running' });
        },
        syncStatus: async () => running,
      }),
    );
    await runSyncServer(setup.ctx, setup.runtime, ['KJV'], {});
    expect(setup.stdout()).toContain('KJV: 2 planned, 2 fetched, 0 unchanged, 0 new revisions, 0 failed');
  });

  it('sets exit code 1 when the job ends failed, printing the job error', async () => {
    const failed: ServerSyncJobStatus = {
      translation: 'KJV',
      state: 'failed',
      refresh: false,
      startedAt: 't',
      finishedAt: 't2',
      progress: { done: 1, total: 2 },
      error: { code: 'sync_interrupted', message: 'server restarted mid-run' },
    };
    const setup = await serverSetup({}, fakeServer({ sync: async () => failed }));
    await runSyncServer(setup.ctx, setup.runtime, ['KJV'], {});
    expect(setup.ctx.exitCode).toBe(1);
    expect(setup.stdout()).toContain('KJV: sync failed: server restarted mid-run');
  });

  it('stops polling and exits 130 when the abort signal fires mid-poll', async () => {
    const controller = new AbortController();
    controller.abort();
    const running: ServerSyncJobStatus = {
      translation: 'KJV',
      state: 'running',
      refresh: false,
      startedAt: 't',
      progress: { done: 0, total: 2 },
    };
    const setup = await serverSetup({}, fakeServer({ sync: async () => running }), { overrides: { abortSignal: controller.signal } });
    await runSyncServer(setup.ctx, setup.runtime, ['KJV'], {});
    expect(setup.ctx.exitCode).toBe(130);
    expect(setup.stdout()).toContain('KJV: stopped early — run sync again to continue where it left off.');
  });
});

describe('sync status', () => {
  it('reports no background jobs locally, and exits 0', async () => {
    const setup = makeContext({});
    await expect(runCli(setup.ctx, ['sync', 'status', 'KJV'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('KJV: no background jobs locally.');
  });

  it('prints no sync job yet on a 404, and exits 0', async () => {
    const setup = makeContext({
      env: { HOLYDECK_SERVER_URL: 'https://s.test' },
      responses: {
        'https://s.test/api/v1/translations/KJV/sync': { status: 404, body: JSON.stringify({ error: { message: 'nope' } }) },
      },
    });
    await expect(runCli(setup.ctx, ['sync', 'status', 'KJV'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('KJV: no sync job yet.');
  });

  it('prints the found job state/counts/times', async () => {
    const setup = makeContext({
      env: { HOLYDECK_SERVER_URL: 'https://s.test' },
      responses: {
        'https://s.test/api/v1/translations/KJV/sync': {
          status: 200,
          body: JSON.stringify({
            translation: 'KJV',
            state: 'running',
            refresh: false,
            startedAt: '2026-09-01T00:00:00.000Z',
            progress: { done: 1, total: 2 },
          }),
        },
      },
    });
    await expect(runCli(setup.ctx, ['sync', 'status', 'KJV'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('KJV: running, 1/2 chapters, started 2026-09-01T00:00:00.000Z');
  });

  it('prints the last error when the job failed', async () => {
    const setup = makeContext({
      env: { HOLYDECK_SERVER_URL: 'https://s.test' },
      responses: {
        'https://s.test/api/v1/translations/KJV/sync': {
          status: 200,
          body: JSON.stringify({
            translation: 'KJV',
            state: 'failed',
            refresh: false,
            startedAt: '2026-09-01T00:00:00.000Z',
            finishedAt: '2026-09-01T00:01:00.000Z',
            progress: { done: 1, total: 2 },
            error: { code: 'sync_interrupted', message: 'server restarted mid-run' },
          }),
        },
      },
    });
    await expect(runCli(setup.ctx, ['sync', 'status', 'KJV'])).resolves.toBe(0);
    expect(setup.stdout()).toContain(
      'KJV: failed, 1/2 chapters, started 2026-09-01T00:00:00.000Z, finished 2026-09-01T00:01:00.000Z',
    );
    expect(setup.stdout()).toContain('  error: server restarted mid-run');
  });

  it('--json prints the raw job (or null) per abbreviation', async () => {
    const setup = makeContext({
      env: { HOLYDECK_SERVER_URL: 'https://s.test' },
      responses: {
        'https://s.test/api/v1/translations/KJV/sync': {
          status: 200,
          body: JSON.stringify({
            translation: 'KJV',
            state: 'completed',
            refresh: false,
            startedAt: '2026-09-01T00:00:00.000Z',
            finishedAt: '2026-09-01T00:01:00.000Z',
            progress: { done: 2, total: 2 },
          }),
        },
        'https://s.test/api/v1/translations/WEB/sync': { status: 404, body: JSON.stringify({ error: { message: 'nope' } }) },
      },
    });
    await expect(runCli(setup.ctx, ['sync', 'status', 'KJV', 'WEB', '--json'])).resolves.toBe(0);
    const parsed = JSON.parse(setup.stdout()) as Array<{ abbr: string; job: Record<string, unknown> | null }>;
    expect(parsed).toEqual([
      {
        abbr: 'KJV',
        job: {
          translation: 'KJV',
          state: 'completed',
          refresh: false,
          startedAt: '2026-09-01T00:00:00.000Z',
          finishedAt: '2026-09-01T00:01:00.000Z',
          progress: { done: 2, total: 2 },
        },
      },
      { abbr: 'WEB', job: null },
    ]);
  });

  it('uses defaultTranslations when no abbr is given', async () => {
    const setup = makeContext({ env: { HOLYDECK_TRANSLATIONS: 'KJV' } });
    await expect(runCli(setup.ctx, ['sync', 'status'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('KJV: no background jobs locally.');
  });
});
