import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Serving the built web client from the application's own origin.
 *
 * The whole build is read into memory once, at start-up, and a request path is only ever a key in
 * that map. Nothing a client sends is ever joined onto a filesystem path, so there is no traversal
 * to defend against: a path that is not a key is simply not an asset. The same pass refuses a build
 * this server cannot serve honestly — a file it has no content type for, or one that would send the
 * browser to another origin — because the time to find that out is at start-up, not in front of a
 * congregation.
 */

const SHELL_PATH = '/index.html';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/vnd.microsoft.icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/**
 * The policy the client is served under. It names every kind of load the client makes, so that a
 * later change which needs something new has to be argued for here rather than discovered as a
 * console error and fixed by widening the policy. There is deliberately no permissions policy:
 * presenting to a second screen needs fullscreen, wake lock and window management, and a blanket
 * denial written now would be found later as a bug and removed wholesale.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
  ].join('; '),
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export interface WebAsset {
  readonly path: string;
  readonly body: Buffer;
  readonly type: string;
  readonly etag: string;
}

export class WebBuildError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join('; '));
    this.name = 'WebBuildError';
    this.problems = problems;
  }
}

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//iu;
const HTML_REFERENCE = /(?:src|href|action|poster|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;
const CSS_REFERENCE = /(?:url\(\s*|@import\s+(?!url\())(?:"([^"]*)"|'([^']*)'|([^)\s;]+))/giu;
const JSON_REFERENCE = /"((?:[a-z][a-z0-9+.-]*:)?\/\/[^"]*)"/giu;

const REFERENCE_PATTERNS: Readonly<Record<string, RegExp>> = {
  '.css': CSS_REFERENCE,
  '.html': HTML_REFERENCE,
  '.webmanifest': JSON_REFERENCE,
};

/**
 * The references in a built file that would make the browser ask another origin for something.
 *
 * Only the files that declare loads are read — markup, stylesheets and the manifest. A bundle is
 * left to the content security policy at run time: a string inside minified code is not a request,
 * and failing a build over one would only teach somebody to weaken the rule.
 */
export function crossOriginReferences(path: string, text: string): readonly string[] {
  const pattern = REFERENCE_PATTERNS[extname(path)];
  if (pattern === undefined) return [];
  const found: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const [, quoted, single, bare] = match;
    // Read as tokens rather than as one value, because a source set is a list and each entry is a load.
    for (const candidate of `${quoted ?? ''}${single ?? ''}${bare ?? ''}`.split(/[,\s]+/u)) {
      if (ABSOLUTE.test(candidate)) found.push(`${path}: ${candidate}`);
    }
  }
  return found;
}

function assetPaths(directory: string): readonly string[] {
  try {
    return readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `/${relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/')}`)
      .sort();
  } catch {
    throw new WebBuildError([`${directory}: the web client has not been built here`]);
  }
}

/** Reads a built web client into memory, keyed by the path a browser asks for each file at. */
export function readWebBuild(directory: string): ReadonlyMap<string, WebAsset> {
  const assets = new Map<string, WebAsset>();
  const problems: string[] = [];
  for (const path of assetPaths(directory)) {
    const type = CONTENT_TYPES[extname(path)];
    if (type === undefined) {
      problems.push(`${path}: no content type is known for this kind of file`);
      continue;
    }
    const body = readFileSync(join(directory, path));
    problems.push(...crossOriginReferences(path, body.toString('utf8')));
    assets.set(path, { path, body, type, etag: `"${createHash('sha256').update(body).digest('base64url')}"` });
  }
  if (!assets.has(SHELL_PATH)) problems.push(`${directory}: the build has no ${SHELL_PATH} to serve`);
  if (problems.length > 0) throw new WebBuildError(problems);
  return assets;
}

function answer(request: FastifyRequest, reply: FastifyReply, asset: WebAsset): FastifyReply {
  reply.header('etag', asset.etag).header('cache-control', 'no-cache').type(asset.type);
  // Nothing in the build is named after its contents yet, so every answer is revalidated. When the
  // build names its assets by content hash, those assets can be held for far longer than one visit.
  if (request.headers['if-none-match'] === asset.etag) return reply.code(304).send();
  return reply.send(asset.body);
}

/**
 * Puts the policy on every answer, not only on the client: an API answer read by a browser is subject
 * to the same sniffing and framing tricks as a document, and one place to change is one place to read.
 */
export function withSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request, reply, payload: unknown) => {
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) reply.header(header, value);
    return payload;
  });
}

/** Registers one route per built file, plus the root for the shell. */
export function serveWebClient(app: FastifyInstance, assets: ReadonlyMap<string, WebAsset>): void {
  for (const [path, asset] of assets) {
    for (const route of path === SHELL_PATH ? ['/', path] : [path]) {
      app.get(route, (request, reply) => answer(request, reply, asset));
    }
  }
}
