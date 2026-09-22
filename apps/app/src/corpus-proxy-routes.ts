// Proxies the handful of corpus routes the CLI needs straight through this application's own origin,
// exactly as the corpus itself answers them: no `{data,meta}` envelope, no session, no permission — the
// client's own bearer token is what the corpus checks, never anything this deployment holds. `corpus.ts`'s
// `corpusClient` is a different, incompatible thing (translated, enveloped answers for this application's
// own routes, always sent with this deployment's own corpus token) and is untouched by this file. Named
// with the `-routes.ts` suffix so `route-coverage.mjs` and `role-coverage.mjs` census it the same way
// every other route module here is censused — see research-notes.md for why that suffix is load-bearing.

import { Readable } from 'node:stream';

import type { RouteNeed } from './authorization.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

const PUBLIC: RouteNeed = { kind: 'public' };

/** The prefix this application strips before asking the corpus; every registered path starts with it. */
const PROXY_PREFIX = '/corpus';

/** The one mutating path this file registers — named here so `csrf.ts` can declare it unguarded by name. */
export const CORPUS_RENDER_PROXY_PATH = `${PROXY_PREFIX}/api/v1/render`;

/** Long enough for a real answer, short enough that a corpus that never will does not hang a caller forever. */
const PROXY_TIMEOUT_MS = 10_000;

/**
 * What this proxy asks the network with — Node's real `fetch`, or a stand-in a test hands it. A real
 * `Response` rather than `corpus.ts`'s narrower `CorpusAnswer`: this file forwards headers and streams a
 * body neither the client nor the corpus asked this application to look inside, which `CorpusAnswer`
 * cannot carry.
 */
export type ProxyFetching = (url: string, init: RequestInit) => Promise<Response>;

export interface CorpusProxyOptions {
  readonly corpusUrl: string;
  /** Defaults to Node's global `fetch`: this file is the network boundary itself, not a caller of one. */
  readonly fetching?: ProxyFetching;
  readonly timeoutMs?: number;
}

// Meaningful only to the hop that set it, or already stale by the time this file can act on it —
// `content-encoding` included, because `fetch` has already transparently decoded the body by the time a
// handler here ever sees it, which makes the corpus's own header wrong to repeat to this proxy's caller.
const HOP_BY_HOP = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'host',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
]);

function forwardableHeaders(source: FastifyRequest['headers']): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

// Fastify leaves a matched route's `request.url` exactly as the client sent it, params and query string
// included, so the corpus is asked with the same path and query it would answer for a direct call.
const upstreamPathFor = (request: FastifyRequest): string => request.url.slice(PROXY_PREFIX.length);

const isAbort = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';

async function proxy(
  request: FastifyRequest,
  reply: FastifyReply,
  fetching: ProxyFetching,
  address: string,
  timeoutMs: number,
): Promise<FastifyReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetching(`${address}${upstreamPathFor(request)}`, {
      method: request.method,
      headers: forwardableHeaders(request.headers),
      // The one body this proxy ever forwards is render's, and Fastify has already parsed it into an
      // object by the time a handler sees it — re-serialized here rather than streamed, which is
      // byte-identical to what a client sent for the well-formed JSON every render request carries.
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
    });
    reply.code(response.status);
    response.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.has(name)) reply.header(name, value);
    });
    if (response.body === null) return reply.send();
    return reply.send(Readable.fromWeb(response.body as unknown as NodeReadableStream));
  } catch (error) {
    return reply.code(isAbort(error) ? 504 : 502).send();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Registers the corpus routes the CLI needs at `/corpus/*`, forwarding each request to the corpus this
 * deployment is configured with and streaming its answer back unchanged — status, `content-type` and body
 * alike, never this application's own envelope. Every route needs `PUBLIC`: there is no session to prove
 * here, because the CLI authenticates with a corpus token this application never sees or holds. A path
 * outside the five registered here is not this file's to refuse — Fastify's own router answers it with
 * this application's usual not-found, the same as any other path nothing serves, and never reaches
 * `proxy` at all.
 */
export function serveCorpusProxyRoutes(
  app: FastifyInstance,
  { corpusUrl, fetching = fetch, timeoutMs = PROXY_TIMEOUT_MS }: CorpusProxyOptions,
): void {
  if (corpusUrl === '') return; // Nothing configured, nothing to proxy to — matches corpus.ts's own precedent.
  const address = corpusUrl.replace(/\/+$/u, '');
  const handle = (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
    proxy(request, reply, fetching, address, timeoutMs);

  app.get(`${PROXY_PREFIX}/health`, { config: { need: PUBLIC } }, handle);
  app.get(`${PROXY_PREFIX}/api/v1/translations`, { config: { need: PUBLIC } }, handle);
  app.get(`${PROXY_PREFIX}/api/v1/translations/:abbr/canon`, { config: { need: PUBLIC } }, handle);
  app.get(`${PROXY_PREFIX}/api/v1/translations/:abbr/verses`, { config: { need: PUBLIC } }, handle);
  app.post(CORPUS_RENDER_PROXY_PATH, { config: { need: PUBLIC } }, handle);
}
