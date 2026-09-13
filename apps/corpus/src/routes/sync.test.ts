import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../../test/helpers/app.js';
import type { SyncReport } from '@holydeck/core/sync';
import type { TestApp } from '../../test/helpers/app.js';

let ctx: TestApp;
let releaseJob: () => void;
let jobRefresh: boolean | undefined;

const report: SyncReport = {
  translation: 'KJV',
  planned: 1,
  fetched: 1,
  unchanged: 0,
  newRevisions: [{ book: 'PSA', chapter: '117', rev: 1 }],
  failed: [],
  dryRun: false,
};

beforeAll(async () => {
  ctx = await buildTestApp({
    runSync: async (_store, _fetcher, _abbr, options) => {
      jobRefresh = options?.refresh;
      await new Promise<void>((resolve) => {
        releaseJob = resolve;
      });
      return report;
    },
  });
});

afterAll(async () => {
  await ctx.stop();
});

beforeEach(async () => {
  await ctx.db.dropDatabase();
  jobRefresh = undefined;
});

const url = '/api/v1/translations/KJV/sync';

describe('POST /api/v1/translations/:abbr/sync', () => {
  it('starts a job with 202 and rejects a concurrent start with 409', async () => {
    const started = await ctx.app.inject({ method: 'POST', url, payload: {} });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ translation: 'KJV', state: 'running', refresh: false });

    const conflict = await ctx.app.inject({ method: 'POST', url: '/api/v1/translations/kjv/sync', payload: {} });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe('sync_already_running');

    const running = await ctx.app.inject({ method: 'GET', url });
    expect(running.statusCode).toBe(200);
    expect(running.json()).toMatchObject({ state: 'running' });

    releaseJob();
    await ctx.jobs.onIdle();
    const done = await ctx.app.inject({ method: 'GET', url });
    expect(done.json()).toMatchObject({
      state: 'completed',
      report: { planned: 1, fetched: 1, unchanged: 0, newRevisions: 1, failed: [] },
    });
  });

  it('passes refresh: true through and defaults to false without a body', async () => {
    const withRefresh = await ctx.app.inject({ method: 'POST', url, payload: { refresh: true } });
    expect(withRefresh.statusCode).toBe(202);
    expect(withRefresh.json()).toMatchObject({ refresh: true });
    expect(jobRefresh).toBe(true);
    releaseJob();
    await ctx.jobs.onIdle();

    const noBody = await ctx.app.inject({ method: 'POST', url });
    expect(noBody.statusCode).toBe(202);
    expect(noBody.json()).toMatchObject({ refresh: false });
    expect(jobRefresh).toBe(false);
    releaseJob();
    await ctx.jobs.onIdle();
  });

  it('404s with unknown_translation for an unknown abbreviation', async () => {
    const response = await ctx.app.inject({ method: 'POST', url: '/api/v1/translations/ZZZ/sync', payload: {} });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('unknown_translation');
  });
});

describe('GET /api/v1/translations/:abbr/sync', () => {
  it('404s with sync_job_not_found when no job exists', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/translations/NIV/sync' });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('sync_job_not_found');
    expect(body.error.message).toContain('POST /api/v1/translations/NIV/sync');
  });
});
