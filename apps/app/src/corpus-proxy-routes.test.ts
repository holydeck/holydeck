import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { serveCorpusProxyRoutes } from './corpus-proxy-routes.js';
import { withSafeErrors } from './failures.js';

import type { ProxyFetching } from './corpus-proxy-routes.js';
import type { FastifyInstance } from 'fastify';

const CORPUS_URL = 'http://corpus:8080';

function proxiedApp(fetching: ProxyFetching, corpusUrl = CORPUS_URL, timeoutMs?: number): FastifyInstance {
  const app = Fastify({ logger: false });
  withSafeErrors(app, { diagnostics: false });
  serveCorpusProxyRoutes(app, { corpusUrl, fetching, timeoutMs });
  return app;
}

function answering(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): { fetching: ProxyFetching; asked: Array<{ url: string; init: RequestInit }> } {
  const asked: Array<{ url: string; init: RequestInit }> = [];
  const fetching: ProxyFetching = (url, requestInit) => {
    asked.push({ url, init: requestInit });
    return Promise.resolve(new Response(JSON.stringify(body), { status: init.status ?? 200, headers: init.headers }));
  };
  return { fetching, asked };
}

describe('the corpus proxy', () => {
  it('forwards the health check and streams the corpus answer through unwrapped', async () => {
    const { fetching, asked } = answering({ status: 'ok' });
    const app = proxiedApp(fetching);
    const response = await app.inject({
      method: 'GET',
      url: '/corpus/health',
      headers: { authorization: 'Bearer client-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toBe(`${CORPUS_URL}/health`);
    await app.close();
  });

  it('forwards exactly the client-supplied authorization header, never a configured token', async () => {
    const { fetching, asked } = answering({});
    const app = proxiedApp(fetching);
    await app.inject({
      method: 'GET',
      url: '/corpus/api/v1/translations',
      headers: { authorization: 'Bearer client-token' },
    });
    const headers = asked[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer client-token');
    await app.close();
  });

  it('forwards a translation abbreviation and query string through to the canon and verses routes', async () => {
    const { fetching, asked } = answering({});
    const app = proxiedApp(fetching);
    await app.inject({ method: 'GET', url: '/corpus/api/v1/translations/KJV/canon' });
    await app.inject({ method: 'GET', url: '/corpus/api/v1/translations/KJV/verses?book=JHN&chapter=3&verses=16' });
    expect(asked[0]?.url).toBe(`${CORPUS_URL}/api/v1/translations/KJV/canon`);
    expect(asked[1]?.url).toBe(`${CORPUS_URL}/api/v1/translations/KJV/verses?book=JHN&chapter=3&verses=16`);
    await app.close();
  });

  it('streams a render request body through and returns the corpus answer as-is', async () => {
    const { fetching, asked } = answering({ slide: 'rendered' }, { status: 201 });
    const app = proxiedApp(fetching);
    const response = await app.inject({
      method: 'POST',
      url: '/corpus/api/v1/render',
      payload: { reference: 'JHN.3.16' },
      headers: { authorization: 'Bearer client-token' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ slide: 'rendered' });
    expect(asked[0]?.init.body).toBe(JSON.stringify({ reference: 'JHN.3.16' }));
    await app.close();
  });

  it('refuses a path outside the allow-list without contacting the corpus', async () => {
    const { fetching, asked } = answering({});
    const app = proxiedApp(fetching);
    const response = await app.inject({ method: 'GET', url: '/corpus/api/v1/translations/../../etc' });
    expect(response.statusCode).toBe(404);
    expect(asked).toHaveLength(0);
    await app.close();
  });

  it('answers 504 when the corpus does not answer inside its timeout', async () => {
    const fetching: ProxyFetching = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    const app = proxiedApp(fetching, CORPUS_URL, 20);
    const response = await app.inject({ method: 'GET', url: '/corpus/health' });
    expect(response.statusCode).toBe(504);
    await app.close();
  });

  it('answers 502 when the corpus cannot be reached at all', async () => {
    const fetching: ProxyFetching = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const app = proxiedApp(fetching);
    const response = await app.inject({ method: 'GET', url: '/corpus/health' });
    expect(response.statusCode).toBe(502);
    await app.close();
  });

  it('serves nothing at all when this deployment has no corpus configured', async () => {
    const { fetching, asked } = answering({});
    const app = proxiedApp(fetching, '');
    const response = await app.inject({ method: 'GET', url: '/corpus/health' });
    expect(response.statusCode).toBe(404);
    expect(asked).toHaveLength(0);
    await app.close();
  });
});
