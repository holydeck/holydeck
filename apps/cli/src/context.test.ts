import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { computeIsTTY, defaultContext, errLine, fetchHttpGet, fetchHttpPost, outLine } from './context.js';

describe('computeIsTTY', () => {
  it('is true only when both stdio ends are TTYs', () => {
    expect(computeIsTTY(true, true)).toBe(true);
    expect(computeIsTTY(true, undefined)).toBe(false);
    expect(computeIsTTY(undefined, true)).toBe(false);
    expect(computeIsTTY(false, false)).toBe(false);
  });
});

describe('line helpers', () => {
  it('append a newline through the raw writers', () => {
    const chunks: string[] = [];
    const ctx = { ...defaultContext(), out: (t: string) => chunks.push(t), err: (t: string) => chunks.push(t) };
    outLine(ctx, 'a');
    errLine(ctx, 'b');
    expect(chunks).toEqual(['a\n', 'b\n']);
  });
});

describe('fetch transports (local http server)', () => {
  it('performs GET and POST against a real server', async () => {
    const requests: Array<{ method: string; url: string; body: string; accept: string }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        requests.push({ method: req.method ?? '', url: req.url ?? '', body, accept: req.headers.accept ?? '' });
        res.statusCode = req.url === '/missing' ? 404 : 200;
        res.end('pong');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await expect(fetchHttpGet(`${base}/x`, { accept: 'application/json' })).resolves.toEqual({ status: 200, body: 'pong' });
      await expect(fetchHttpGet(`${base}/missing`, {})).resolves.toEqual({ status: 404, body: 'pong' });
      await expect(fetchHttpPost(`${base}/y`, 'payload', { 'content-type': 'text/plain' })).resolves.toEqual({ status: 200, body: 'pong' });
      // Node's global fetch adds `Accept: */*` per the Fetch spec whenever the caller omits it.
      expect(requests).toEqual([
        { method: 'GET', url: '/x', body: '', accept: 'application/json' },
        { method: 'GET', url: '/missing', body: '', accept: '*/*' },
        { method: 'POST', url: '/y', body: 'payload', accept: '*/*' },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('defaultContext', () => {
  it('reflects the real process environment', () => {
    const ctx = defaultContext();
    expect(ctx.platform.platform).toBe(process.platform);
    expect(ctx.platform.homeDir.length).toBeGreaterThan(0);
    expect(ctx.cwd).toBe(process.cwd());
    expect(typeof ctx.isTTY).toBe('boolean');
    expect(ctx.now()).toBeInstanceOf(Date);
    // exercise the writer closures (vitest captures stdio)
    ctx.out('');
    ctx.err('');
  });
});
