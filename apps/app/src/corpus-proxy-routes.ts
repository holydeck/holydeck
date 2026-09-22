// Proxies the handful of corpus routes the CLI needs straight through this application's own origin,
// exactly as the corpus itself answers them: no `{data,meta}` envelope, no session, no permission — the
// client's own bearer token is what the corpus checks, never anything this deployment holds. `corpus.ts`'s
// `corpusClient` is a different, incompatible thing (translated, enveloped answers for this application's
// own routes, always sent with this deployment's own corpus token) and is untouched by this file. Named
// with the `-routes.ts` suffix so `route-coverage.mjs` and `role-coverage.mjs` census it the same way
// every other route module here is censused — see either script for how that suffix is matched.

import { pipeline, Readable, Transform } from 'node:stream';
import { finished } from 'node:stream/promises';

import rateLimit from '@fastify/rate-limit';

import { unexpectedFailure } from './failures.js';

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

// Matches apps/corpus's own per-route convention (see routes/stats.ts), registered per-route rather than
// globally so a burst against one path — say, a sermon's worth of verse lookups — never throttles the
// others.
const PROXY_RATE_LIMIT = { max: 60, timeWindow: '1 minute' };

// Generous for a translations list, a canon, a verse range or a rendered slide payload — all JSON or plain
// text — while still bounding how much of a misbehaving or compromised corpus's answer this application
// ever holds in memory or forwards to a client.
export const PROXY_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

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

// An allowlist, not a drop-list: this application's own session cookie, CSRF headers and forwarded-for
// chain must never reach the corpus, and a drop-list is only ever as safe as the last header anyone
// remembered to add to it. Anything not named here is dropped, including every header added after this
// was written.
const FORWARDABLE_REQUEST_HEADERS = new Set([
  'authorization',
  'accept',
  'accept-language',
  'content-type',
  'if-none-match',
  'if-modified-since',
  'user-agent',
]);

function forwardableHeaders(source: FastifyRequest['headers']): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !FORWARDABLE_REQUEST_HEADERS.has(name)) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

// Also an allowlist: the corpus's own `set-cookie`, CSP, HSTS, CORS or `location` headers must never land
// on this application's origin, where a browser would read them as this deployment's own and a `set-cookie`
// could overwrite or shadow the `__Host-` session cookie. `x-ratelimit-*` is a family, not a fixed name.
const FORWARDABLE_RESPONSE_HEADERS = new Set([
  'content-type',
  'cache-control',
  'etag',
  'last-modified',
  'vary',
  'retry-after',
]);

const isForwardableResponseHeader = (name: string): boolean =>
  FORWARDABLE_RESPONSE_HEADERS.has(name) || name.startsWith('x-ratelimit-');

// Every translation abbreviation this build knows is short and alphanumeric (see
// packages/core/src/translations.ts); this is deliberately generous around that, not a re-statement of
// it, because refusing here is a routing decision, not a validity check. Anything outside this allow-list
// is refused before it is ever concatenated into a URL, rather than trusted to carry the same meaning
// through Fastify's router and `fetch`'s URL parser that it started with — they do not agree: find-my-way
// splits a path on `/` only, so a segment with a literal backslash in it still matches a single `:abbr`
// param, while `fetch` (WHATWG URL) treats a backslash as another `/` and resolves a `..` or `%2e%2e`
// inside it, letting an abbreviation reach routes this proxy never registered.
const ABBR_PATTERN = /^[A-Za-z0-9]{1,32}$/u;

const isAllowedAbbr = (value: string): boolean => ABBR_PATTERN.test(value);

// Rebuilt from Fastify's own parsed querystring rather than copied from request.url, for the same reason
// the path below is built from request.params instead: a raw copy carries forward whatever the client
// wrote, including anything that would mean something different once it reaches the corpus.
function upstreamQuery(request: FastifyRequest): string {
  const query = request.query as Record<string, unknown>;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry !== undefined) params.append(key, String(entry));
    }
  }
  const serialized = params.toString();
  return serialized === '' ? '' : `?${serialized}`;
}

const isAbort = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';

// Wraps the corpus's own response stream so a single answer can never exceed PROXY_MAX_RESPONSE_BYTES,
// however it is chunked — including a corpus that sends the whole thing as one unbroken write. pipeline,
// not a bare .pipe(), so an error here also tears the source stream down rather than leaving it dangling;
// Fastify itself is what notices the resulting 'error' event and ends the client response.
function sizeCapped(request: FastifyRequest, source: Readable): Readable {
  let seen = 0;
  const capped = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > PROXY_MAX_RESPONSE_BYTES) {
        callback(new Error(`corpus response exceeded the ${PROXY_MAX_RESPONSE_BYTES}-byte proxy cap`));
        return;
      }
      callback(null, chunk);
    },
  });
  pipeline(source, capped, (error) => {
    if (error !== undefined && error !== null && !isAbort(error)) {
      request.log.error({ err: error }, 'corpus proxy response failed');
    }
  });
  return capped;
}

const BEARER_AUTHORIZATION = /^Bearer\s+\S+/iu;

// Render is the one mutating route this file registers, and `csrf.ts` leaves it out of the session guard
// entirely — so this check is render's only defense, not a second layer on top of one. A cross-site page
// can make a browser send this application's session cookie, but it cannot make the browser send an
// `authorization` header, so requiring one here is what stands in for the CSRF guard this route cannot
// carry. Checked, and refused, before any upstream call.
const hasBearerAuthorization = (request: FastifyRequest): boolean =>
  BEARER_AUTHORIZATION.test(String(request.headers.authorization ?? ''));

async function proxy(
  request: FastifyRequest,
  reply: FastifyReply,
  fetching: ProxyFetching,
  address: string,
  timeoutMs: number,
  upstreamPath: string,
): Promise<FastifyReply> {
  const controller = new AbortController();
  // Cleared once the real work finishes — which, for a streamed body, is only once that stream itself
  // ends or errors, not as soon as fetching() resolves with headers. A corpus that answers promptly and
  // then stalls mid-body is exactly what this guards against: clearing here as soon as headers arrived
  // would leave the timer inert for the rest of the response, letting a stalled body hang forever.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetching(`${address}${upstreamPath}`, {
      method: request.method,
      headers: forwardableHeaders(request.headers),
      // The one body this proxy ever forwards is render's, and Fastify has already parsed it into a
      // string or an object by the time a handler sees it, never a raw buffer — re-serialized here
      // rather than streamed. A string (the sermon text `server-client.ts` posts as `text/plain`) is
      // forwarded byte-identical to what the client sent; anything else is JSON, re-encoded the same
      // way it was decoded.
      body:
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : typeof request.body === 'string'
            ? request.body
            : JSON.stringify(request.body),
      signal: controller.signal,
    });
    reply.code(response.status);
    response.headers.forEach((value, name) => {
      if (isForwardableResponseHeader(name)) reply.header(name, value);
    });
    if (response.body === null) {
      clearTimeout(timer);
      return reply.send();
    }
    const stream = sizeCapped(request, Readable.fromWeb(response.body as unknown as NodeReadableStream));
    void finished(stream)
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
    return reply.send(stream);
  } catch (error) {
    clearTimeout(timer);
    request.log.error({ err: error }, 'corpus proxy request failed');
    return reply.code(isAbort(error) ? 504 : 502).send();
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

  // { global: false }: opt-in per route below, the same convention apps/corpus's own routes use, so a
  // burst against one proxied path never throttles the others. Registered before, and the routes below
  // registered inside their own nested app.register (rather than directly on `app`), so that Fastify's
  // plugin queue loads rate-limit's onRoute hook first — a route declared directly on `app` in the same
  // synchronous tick as this call would otherwise finalize before that hook exists to see it.
  void app.register(rateLimit, { global: false });

  void app.register(async (scoped) => {
    // The rate-limit plugin throws once its own limit is hit (statusCode 429, and it has already set the
    // retry-after header on the reply). Answered bare, no body, the same as this file's own 400 and 401
    // refusals below — never this application's usual envelope, which this file does not build for
    // anything it answers itself. Anything else thrown here still falls back to the same hidden-500
    // behaviour as the rest of the application.
    scoped.setErrorHandler((error, request, reply) => {
      if ((error as { statusCode?: unknown }).statusCode === 429) return reply.code(429).send();
      request.log.error(error);
      return reply.code(500).send(unexpectedFailure(request.id));
    });

    scoped.get(
      `${PROXY_PREFIX}/health`,
      { config: { need: PUBLIC, rateLimit: PROXY_RATE_LIMIT } },
      (request, reply) => proxy(request, reply, fetching, address, timeoutMs, '/health'),
    );
    scoped.get(
      `${PROXY_PREFIX}/api/v1/translations`,
      { config: { need: PUBLIC, rateLimit: PROXY_RATE_LIMIT } },
      (request, reply) =>
        proxy(request, reply, fetching, address, timeoutMs, `/api/v1/translations${upstreamQuery(request)}`),
    );
    scoped.get<{ Params: { abbr: string } }>(
      `${PROXY_PREFIX}/api/v1/translations/:abbr/canon`,
      { config: { need: PUBLIC, rateLimit: PROXY_RATE_LIMIT } },
      (request, reply) => {
        const { abbr } = request.params;
        if (!isAllowedAbbr(abbr)) return reply.code(400).send();
        // encodeURIComponent is redundant once ABBR_PATTERN has passed — nothing it allows needs escaping
        // — and kept anyway so nothing here depends on that remaining true if the pattern ever widens.
        return proxy(
          request,
          reply,
          fetching,
          address,
          timeoutMs,
          `/api/v1/translations/${encodeURIComponent(abbr)}/canon${upstreamQuery(request)}`,
        );
      },
    );
    scoped.get<{ Params: { abbr: string } }>(
      `${PROXY_PREFIX}/api/v1/translations/:abbr/verses`,
      { config: { need: PUBLIC, rateLimit: PROXY_RATE_LIMIT } },
      (request, reply) => {
        const { abbr } = request.params;
        if (!isAllowedAbbr(abbr)) return reply.code(400).send();
        return proxy(
          request,
          reply,
          fetching,
          address,
          timeoutMs,
          `/api/v1/translations/${encodeURIComponent(abbr)}/verses${upstreamQuery(request)}`,
        );
      },
    );
    scoped.post(
      CORPUS_RENDER_PROXY_PATH,
      { config: { need: PUBLIC, rateLimit: PROXY_RATE_LIMIT } },
      (request, reply) =>
        hasBearerAuthorization(request)
          ? proxy(request, reply, fetching, address, timeoutMs, '/api/v1/render')
          : reply.code(401).send(),
    );
  });
}
