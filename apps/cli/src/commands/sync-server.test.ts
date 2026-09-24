import { describe, expect, it } from 'vitest';
import { makeContext } from '../../test/harness.js';
import type { StubResponse } from '../../test/server-stub.js';
import { startStubCorpusServer } from '../../test/server-stub.js';
import { fetchHttpGet, fetchHttpPost } from '../context.js';
import { runCli } from '../program.js';

// These tests exercise runCli end to end over real sockets (plan's Definition of Done), so they
// override the harness's default fake httpGet/httpPost (canned in-memory responses) with the
// real fetch-based transport, pointed at a real stub HTTP server started per test.
const realTransport = { httpGet: fetchHttpGet, httpPost: fetchHttpPost };

function jobStatus(overrides: Record<string, unknown> = {}): StubResponse {
  return {
    status: 200,
    body: {
      translation: 'KJV',
      state: 'running',
      refresh: false,
      startedAt: '2026-09-01T00:00:00.000Z',
      progress: { done: 0, total: 2 },
      ...overrides,
    },
  };
}

describe('sync against a stub corpus server', () => {
  it('runs a real sync against a stub server end to end: start, poll, complete', async () => {
    let polls = 0;
    const stub = await startStubCorpusServer((method, path) => {
      if (method === 'POST' && path === '/api/v1/translations/KJV/sync') {
        return jobStatus({ progress: { done: 0, total: 2 } });
      }
      if (method === 'GET' && path === '/api/v1/translations/KJV/sync') {
        polls += 1;
        if (polls === 1) return jobStatus({ progress: { done: 1, total: 2 } });
        return {
          status: 200,
          body: {
            translation: 'KJV',
            state: 'completed',
            refresh: false,
            startedAt: '2026-09-01T00:00:00.000Z',
            finishedAt: '2026-09-01T00:01:00.000Z',
            progress: { done: 2, total: 2 },
            report: { planned: 2, fetched: 2, unchanged: 0, newRevisions: 2, failed: [] },
          },
        };
      }
      return undefined;
    });
    try {
      const setup = makeContext({
        env: {
          HOLYDECK_SERVER_URL: stub.url,
          HOLYDECK_SYNC_POLL_INTERVAL_MS: '1',
          HOLYDECK_SERVER_TOKEN: 'stub-token',
        },
        overrides: realTransport,
      });
      await expect(runCli(setup.ctx, ['sync', 'KJV'])).resolves.toBe(0);
      expect(setup.stderr()).toContain('[KJV] 0/2');
      expect(setup.stderr()).toContain('[KJV] 1/2');
      expect(setup.stdout()).toContain('KJV: 2 planned, 2 fetched, 0 unchanged, 2 new revisions, 0 failed');
    } finally {
      await stub.close();
    }
  });

  it('attaches to an already-running job on a 409 from a second sync call', async () => {
    let syncCalls = 0;
    const stub = await startStubCorpusServer((method, path) => {
      if (method === 'POST' && path === '/api/v1/translations/KJV/sync') {
        syncCalls += 1;
        if (syncCalls === 1) return jobStatus({ progress: { done: 0, total: 1 } });
        return { status: 409, body: { error: { code: 'sync_already_running', message: 'already running' } } };
      }
      if (method === 'GET' && path === '/api/v1/translations/KJV/sync') {
        return {
          status: 200,
          body: {
            translation: 'KJV',
            state: 'completed',
            refresh: false,
            startedAt: '2026-09-01T00:00:00.000Z',
            finishedAt: '2026-09-01T00:01:00.000Z',
            progress: { done: 1, total: 1 },
            report: { planned: 1, fetched: 1, unchanged: 0, newRevisions: 1, failed: [] },
          },
        };
      }
      return undefined;
    });
    try {
      const setup = makeContext({
        env: { HOLYDECK_SERVER_URL: stub.url, HOLYDECK_SYNC_POLL_INTERVAL_MS: '1', HOLYDECK_SERVER_TOKEN: 'stub-token' },
        overrides: realTransport,
      });
      // A second, independent CLI run attaches to the job the first one is presumed to have started.
      await runCli(setup.ctx, ['sync', 'KJV']);
      const second = makeContext({
        env: { HOLYDECK_SERVER_URL: stub.url, HOLYDECK_SYNC_POLL_INTERVAL_MS: '1', HOLYDECK_SERVER_TOKEN: 'stub-token' },
        overrides: realTransport,
      });
      await expect(runCli(second.ctx, ['sync', 'KJV'])).resolves.toBe(0);
      expect(second.stdout()).toContain('KJV: 1 planned, 1 fetched, 0 unchanged, 1 new revisions, 0 failed');
    } finally {
      await stub.close();
    }
  });

  it('maps a 401 with no token configured to the admin-token-required refusal', async () => {
    const stub = await startStubCorpusServer((method, path) => {
      if (method === 'POST' && path === '/api/v1/translations/KJV/sync') {
        return { status: 401, body: { error: { code: 'auth_failed', message: 'no matching bearer token was presented' } } };
      }
      return undefined;
    });
    try {
      const setup = makeContext({
        env: { HOLYDECK_SERVER_URL: stub.url, HOLYDECK_SYNC_POLL_INTERVAL_MS: '1' },
        overrides: realTransport,
      });
      await expect(runCli(setup.ctx, ['sync', 'KJV'])).resolves.toBe(1);
      expect(setup.stderr()).toContain('HOLYDECK_SERVER_TOKEN');
    } finally {
      await stub.close();
    }
  });

  it('reports stats against the stub corpus /api/v1/stats route', async () => {
    const stub = await startStubCorpusServer((method, path) => {
      if (method === 'GET' && path === '/api/v1/stats') {
        return {
          status: 200,
          body: {
            translations: [
              { abbr: 'KJV', chapters: { stored: 2, total: 1189 }, revisions: 3, updatedAt: '2026-09-01T00:00:00.000Z' },
            ],
            totals: { translations: 1, chapters: 2, revisions: 3 },
          },
        };
      }
      return undefined;
    });
    try {
      const setup = makeContext({
        env: { HOLYDECK_SERVER_URL: stub.url, HOLYDECK_SERVER_TOKEN: 'stub-token' },
        overrides: realTransport,
      });
      await expect(runCli(setup.ctx, ['stats'])).resolves.toBe(0);
      expect(setup.stdout()).toContain('KJV: 2/1189 chapters, 3 revisions, updated 2026-09-01');
    } finally {
      await stub.close();
    }
  });
});
