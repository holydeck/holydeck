import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HolyDeckError } from '@holydeck/core/messages';
import { Fetcher } from '@holydeck/core/fetcher';
import { API_ENDPOINTS } from './errors.js';
import { buildApp } from './app.js';
import { buildTestApp } from '../test/helpers/app.js';
import type { TestApp } from '../test/helpers/app.js';

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
  ctx.app.get('/boom', async () => {
    throw new Error('plain failure');
  });
  ctx.app.get('/boom503', async () => {
    const error = new Error('upstream broke') as Error & { statusCode: number };
    error.statusCode = 503;
    throw error;
  });
  ctx.app.get('/hd', async () => {
    throw new HolyDeckError('unknown_translation', { abbr: 'ZZZ' });
  });
  ctx.app.get(
    '/valid',
    { schema: { querystring: { type: 'object', required: ['n'], properties: { n: { type: 'integer' } } } } },
    async () => ({ ok: true }),
  );
  ctx.app.post('/echo', async (request) => ({ received: request.body }));
});

afterAll(async () => {
  await ctx.stop();
});

describe('GET /health', () => {
  it('reports ok with version, uptime and store state', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; version: string; uptime: number; store: string }>();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.0.0-test');
    expect(body.store).toBe('ok');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });
});

describe('error handling', () => {
  it('renders HolyDeckError as the envelope with its mapped status', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/hd' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'unknown_translation', message: expect.stringContaining('ZZZ') as string },
    });
  });

  it('renders schema validation failures as 400 request_invalid', async () => {
    const missing = await ctx.app.inject({ method: 'GET', url: '/valid' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe('request_invalid');
    const wrongType = await ctx.app.inject({ method: 'GET', url: '/valid?n=hello' });
    expect(wrongType.statusCode).toBe(400);
  });

  it('renders malformed JSON bodies as 400 request_invalid', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('request_invalid');
  });

  it('hides unexpected errors behind 500 internal_error', async () => {
    for (const url of ['/boom', '/boom503']) {
      const response = await ctx.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: { code: 'internal_error', message: 'Unexpected server error.' },
      });
    }
  });
});

describe('not-found handler', () => {
  it('returns the envelope plus the endpoint map', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: { code: string; message: string }; endpoints: Record<string, string> }>();
    expect(body.error.code).toBe('route_not_found');
    expect(body.error.message).toContain('GET /api/v1/nope');
    expect(body.endpoints).toEqual(API_ENDPOINTS);
  });
});

describe('content types', () => {
  it('passes yaml bodies through as raw strings', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'text/yaml' },
      payload: 'translations:\n  - KJV\n',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: 'translations:\n  - KJV\n' });
  });
});

describe('rate limiting', () => {
  it('limits datastore reads per route and preserves the API error envelope', async () => {
    for (let request = 0; request < 60; request += 1) {
      const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/stats' });
      expect(response.statusCode).toBe(200);
    }

    const limited = await ctx.app.inject({ method: 'GET', url: '/api/v1/stats' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.json()).toEqual({
      error: { code: 'rate_limit_exceeded', message: 'Rate limit exceeded. Try again later.' },
    });

    const separateRoute = await ctx.app.inject({ method: 'GET', url: '/api/v1/translations' });
    expect(separateRoute.statusCode).toBe(200);
  });
});

describe('degraded store', () => {
  it('still answers 200 with degraded status when mongo is down', async () => {
    const dedicated = await buildTestApp();
    await dedicated.stopMongo();
    const response = await dedicated.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; store: string }>();
    expect(body.status).toBe('degraded');
    expect(body.store).toBe('unreachable');
    await dedicated.app.close();
  });
});

describe('logger option', () => {
  it('accepts an explicit logger config (covers the left branch of `deps.logger ?? false`)', async () => {
    const silent = buildApp({
      store: ctx.store,
      fetcher: new Fetcher({ retries: 0, backoffMs: 1, sleep: async () => {} }),
      jobs: ctx.jobs,
      version: 'x',
      logger: false,
    });
    const response = await silent.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    await silent.close();
  });
});
