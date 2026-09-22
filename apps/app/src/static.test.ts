import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SECURITY_HEADERS,
  WebBuildError,
  crossOriginReferences,
  isShellNavigation,
  readWebBuild,
  serveWebClient,
  shellFallback,
  withSecurityHeaders,
} from './static.js';

import type { FastifyInstance } from 'fastify';

const shell = [
  '<!doctype html>',
  '<html lang="en"><head><link rel="manifest" href="/manifest.webmanifest" /></head>',
  '<body><script type="module" src="/main.js"></script></body></html>',
].join('\n');

function buildDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'holydeck-web-build-'));
  const written = { 'index.html': shell, 'main.js': 'export const ok = 1;\n', ...files };
  for (const [name, body] of Object.entries(written)) {
    const target = join(dir, name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, body);
  }
  return dir;
}

describe('reading the built web client', () => {
  it('reads every file in the build, keyed by the path a browser asks for it at', () => {
    const dir = buildDir({ 'icons/icon-192.png': 'not really a png', 'manifest.webmanifest': '{"name":"HolyDeck"}' });
    const assets = readWebBuild(dir);
    expect([...assets.keys()].sort()).toEqual(['/icons/icon-192.png', '/index.html', '/main.js', '/manifest.webmanifest']);
    expect(assets.get('/main.js')?.type).toBe('text/javascript; charset=utf-8');
    expect(assets.get('/icons/icon-192.png')?.type).toBe('image/png');
    expect(assets.get('/manifest.webmanifest')?.type).toBe('application/manifest+json; charset=utf-8');
    expect(assets.get('/index.html')?.body.toString('utf8')).toBe(shell);
    rmSync(dir, { recursive: true });
  });

  it('gives each asset an entity tag of its own contents, so a client can be told it has it already', () => {
    const dir = buildDir({ 'same.js': 'export const ok = 1;\n' });
    const assets = readWebBuild(dir);
    expect(assets.get('/main.js')?.etag).toMatch(/^"[\w-]{43}"$/u);
    expect(assets.get('/same.js')?.etag).toBe(assets.get('/main.js')?.etag);
    expect(assets.get('/index.html')?.etag).not.toBe(assets.get('/main.js')?.etag);
    rmSync(dir, { recursive: true });
  });

  it('refuses a build directory that is not there, naming it', () => {
    const missing = join(tmpdir(), 'holydeck-web-build-that-was-never-built');
    expect(() => readWebBuild(missing)).toThrow(WebBuildError);
    expect(() => readWebBuild(missing)).toThrow(missing);
  });

  it('refuses a build with no shell to serve', () => {
    const dir = mkdtempSync(join(tmpdir(), 'holydeck-web-empty-'));
    writeFileSync(join(dir, 'main.js'), 'export const ok = 1;\n');
    expect(() => readWebBuild(dir)).toThrow(/index\.html/u);
    rmSync(dir, { recursive: true });
  });

  it('refuses a file it has no content type for, rather than guessing one a browser might act on', () => {
    const dir = buildDir({ 'unexpected.bin': 'binary' });
    expect(() => readWebBuild(dir)).toThrow(/unexpected\.bin/u);
    rmSync(dir, { recursive: true });
  });

  it('refuses a build that would make the browser fetch from somewhere else', () => {
    const dir = buildDir({
      'index.html': shell.replace('/main.js', 'https://cdn.example.com/main.js'),
    });
    expect(() => readWebBuild(dir)).toThrow(/cdn\.example\.com/u);
    rmSync(dir, { recursive: true });
  });
});

describe('finding cross-origin references', () => {
  it('reads the declarations a browser would act on, wherever they are declared', () => {
    expect(crossOriginReferences('/index.html', '<img src="http://tracker.example/p.gif">'))
      .toEqual(['/index.html: http://tracker.example/p.gif']);
    expect(crossOriginReferences('/app.css', '@import url(//fonts.example/face.css);'))
      .toEqual(['/app.css: //fonts.example/face.css']);
    expect(crossOriginReferences('/manifest.webmanifest', '{"start_url":"https://elsewhere.example/"}'))
      .toEqual(['/manifest.webmanifest: https://elsewhere.example/']);
    expect(crossOriginReferences('/index.html', "<img src='//cdn.example/p.gif'>"))
      .toEqual(['/index.html: //cdn.example/p.gif']);
    expect(crossOriginReferences('/app.css', "@import 'https://fonts.example/face.css';"))
      .toEqual(['/app.css: https://fonts.example/face.css']);
  });

  it('reads every entry of a source set, because each one is a load of its own', () => {
    expect(crossOriginReferences('/index.html', '<img srcset="/small.png 1x, https://cdn.example/big.png 2x">'))
      .toEqual(['/index.html: https://cdn.example/big.png']);
  });

  it('reads nothing into a build that only ever names its own origin', () => {
    expect(crossOriginReferences('/index.html', shell)).toEqual([]);
    expect(crossOriginReferences('/app.css', 'body { background: url(/icons/icon-192.png); }')).toEqual([]);
  });

  // A bundle is checked by the content security policy at run time instead: a string in minified code is
  // not a request, and a build that fails on one would only teach somebody to weaken the rule.
  it('reads nothing out of the bundles and source maps it does not grade', () => {
    expect(crossOriginReferences('/main.js', 'const docs = "https://example.com/docs";')).toEqual([]);
    expect(crossOriginReferences('/main.js.map', '{"sourcesContent":["// see https://example.com"]}')).toEqual([]);
  });
});

describe('serving the built web client', () => {
  let app: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    dir = buildDir({ 'icons/icon-192.png': 'not really a png' });
    app = Fastify();
    withSecurityHeaders(app);
    serveWebClient(app, readWebBuild(dir));
    app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: { code: 'resource.not_found' } }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true });
  });

  it('answers the root with the shell', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toBe(shell);
  });

  it('answers each asset with its own body, type and entity tag', async () => {
    const response = await app.inject({ method: 'GET', url: '/icons/icon-192.png' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['etag']).toMatch(/^"[\w-]{43}"$/u);
    // Nothing in this build is named after its contents, so every answer is revalidated rather than
    // reused blindly; a build that names its assets by content hash can be cached for longer.
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('tells a client that already has an asset that nothing has changed', async () => {
    const first = await app.inject({ method: 'GET', url: '/main.js' });
    const again = await app.inject({
      method: 'GET',
      url: '/main.js',
      headers: { 'if-none-match': String(first.headers['etag']) },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers['etag']).toBe(first.headers['etag']);
  });

  it('serves an asset again when the entity tag it was given belongs to something else', async () => {
    const response = await app.inject({ method: 'GET', url: '/main.js', headers: { 'if-none-match': '"stale"' } });
    expect(response.statusCode).toBe(200);
  });

  it('serves nothing the build does not contain, however the path is written', async () => {
    for (const url of ['/nothing.js', '/../package.json', '/..%2fpackage.json', '/icons/../../package.json',
      '/icons%2F..%2F..%2Fpackage.json', '//etc/passwd']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it('carries the headers that keep the client on its own origin on every answer', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers[header], header).toBe(value);
    }
  });
});

describe('falling back to the web shell', () => {
  let app: FastifyInstance;
  let dir: string;
  let assets: ReadonlyMap<string, import('./static.js').WebAsset>;

  beforeAll(async () => {
    dir = buildDir({ 'icons/icon-192.png': 'not really a png' });
    assets = readWebBuild(dir);
    const shell = shellFallback(assets);
    app = Fastify();
    withSecurityHeaders(app);
    serveWebClient(app, assets);
    app.setNotFoundHandler((request, reply) => shell(request, reply) ?? reply.code(404).send({ error: { code: 'resource.not_found' } }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true });
  });

  it.each([
    ['GET', '/', true],
    ['GET', '/sign-in?next=/services/x', true],
    ['GET', '/api/v1/nope', false],
    ['GET', '/api', false],
    ['GET', '/health', false],
    ['GET', '/health/ready', false],
    ['GET', '/healthy', true],
    ['GET', '/missing.js', false],
    ['GET', '/a.b/c', true],
    ['POST', '/services/x', false],
    ['HEAD', '/admin/users', true],
  ])('recognizes %s %s as a shell navigation: %s', (method, url, expected) => {
    expect(isShellNavigation(method, url)).toBe(expected);
  });

  it('answers client routes with the shell and its document policy', async () => {
    const response = await app.inject({ method: 'GET', url: '/services/abc' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toBe(shell);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers['content-security-policy']).toBe(SECURITY_HEADERS['content-security-policy']);
  });

  it('answers HEAD navigations without a body', async () => {
    const response = await app.inject({ method: 'HEAD', url: '/admin/users' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('');
  });

  it('keeps the query on a client route out of the asset lookup', async () => {
    const response = await app.inject({ method: 'GET', url: '/sign-in?next=%2Fservices%2Fx' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(shell);
  });

  it.each(['/api/v1/nope', '/health/x', '/missing.js'])('keeps %s as a JSON not-found', async (url) => {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'resource.not_found' } });
  });

  it('does not turn a mutating client-route request into a document', async () => {
    const response = await app.inject({ method: 'POST', url: '/services/x' });
    expect(response.statusCode).toBe(404);
  });

  it('revalidates the shell the same way as a directly requested asset', async () => {
    const first = await app.inject({ method: 'GET', url: '/services/abc' });
    const again = await app.inject({
      method: 'GET',
      url: '/services/abc',
      headers: { 'if-none-match': String(first.headers.etag) },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });
});

describe('the content security policy', () => {
  const policy = SECURITY_HEADERS['content-security-policy'] ?? '';

  it('allows this origin and nothing else, with nothing inline and nothing evaluated', () => {
    expect(policy).toContain("default-src 'self'");
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toMatch(/https?:/u);
    expect(policy).not.toContain('*');
  });

  it('leaves nothing for a frame or a base tag to reach out through', () => {
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
  });

  it('says what the client actually needs, so nothing has to be widened later to make it work', () => {
    for (const directive of ['script-src', 'style-src', 'img-src', 'font-src', 'connect-src', 'media-src',
      'worker-src', 'manifest-src']) {
      expect(policy, directive).toContain(`${directive} `);
    }
    // Icons are data URIs while the shell is still a placeholder, and a data image cannot script.
    expect(policy).toContain("img-src 'self' data:");
  });

  it('keeps the rest of the headers a same-origin client needs', () => {
    expect(SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
    expect(SECURITY_HEADERS['referrer-policy']).toBe('no-referrer');
    expect(SECURITY_HEADERS['cross-origin-opener-policy']).toBe('same-origin');
    expect(SECURITY_HEADERS['cross-origin-resource-policy']).toBe('same-origin');
  });
});

describe('the shell this repository actually ships', () => {
  // Read from the web workspace rather than from a build, so the assertion holds without a build step:
  // the shell is the file that could name another origin, and a bundle is the policy's job at run time.
  const real = new URL('../../web/src/static/index.html', import.meta.url);

  it('names nothing but its own origin', async () => {
    const { readFile } = await import('node:fs/promises');
    const html = await readFile(real, 'utf8');
    expect(crossOriginReferences('/index.html', html)).toEqual([]);
  });

  it('keeps its styles in a file, so the policy needs no inline exception', async () => {
    const { readFile } = await import('node:fs/promises');
    const html = await readFile(real, 'utf8');
    expect(html).not.toMatch(/<style/u);
    expect(html).not.toMatch(/\son[a-z]+=/u);
    expect(html).toContain('rel="stylesheet"');
  });
});
