import { describe, expect, it, vi } from 'vitest';
import { BrowserHttpClient } from './browser-fetch.js';
import type { BrowserPage, BrowserSession } from './browser-fetch.js';

/**
 * Stands in for a puppeteer page: `evaluate` runs the caller's function against a lookup
 * table instead of a real network, so the transport's own behaviour is what gets tested.
 */
function fakeSession(responses: Record<string, { status: number; body: string }>): {
  session: BrowserSession;
  page: BrowserPage;
  goto: ReturnType<typeof vi.fn>;
  setUserAgent: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  newPage: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
} {
  const goto = vi.fn().mockResolvedValue(undefined);
  const setUserAgent = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  // Runs the callback the client hands to the page, with a stub `fetch` in place of the
  // browser's, so the code that actually executes in-page is covered too.
  const evaluate = vi.fn(async (fn: (url: string) => Promise<unknown>, url: string) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (target: string) => {
      const response = responses[String(target)];
      if (response === undefined) throw new Error(`unexpected url ${String(target)}`);
      return { status: response.status, text: async () => response.body };
    }) as unknown as typeof globalThis.fetch;
    try {
      return await fn(url);
    } finally {
      globalThis.fetch = original;
    }
  });
  const page = { goto, setUserAgent, evaluate } as unknown as BrowserPage;
  const newPage = vi.fn().mockResolvedValue(page);
  const session = { newPage, close } as unknown as BrowserSession;
  return { session, page, goto, setUserAgent, close, newPage, evaluate };
}

describe('BrowserHttpClient', () => {
  it('warms up once and reuses the page across requests', async () => {
    const { session, goto, newPage } = fakeSession({
      'https://x/a': { status: 200, body: 'a' },
      'https://x/b': { status: 200, body: 'b' },
    });
    const client = new BrowserHttpClient({ launch: async () => session });

    expect(await client.httpGet('https://x/a', {})).toEqual({ status: 200, body: 'a' });
    expect(await client.httpGet('https://x/b', {})).toEqual({ status: 200, body: 'b' });

    expect(newPage).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it('launches the browser only once when requests start concurrently', async () => {
    const { session, newPage } = fakeSession({ 'https://x/a': { status: 200, body: 'a' } });
    const launch = vi.fn(async () => session);
    const client = new BrowserHttpClient({ launch });

    await Promise.all([client.httpGet('https://x/a', {}), client.httpGet('https://x/a', {})]);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(newPage).toHaveBeenCalledTimes(1);
  });

  it('warms up on the configured url with the configured user agent', async () => {
    const { session, goto, setUserAgent } = fakeSession({ 'https://x/a': { status: 200, body: 'a' } });
    const client = new BrowserHttpClient({
      launch: async () => session,
      warmUpUrl: 'https://warm.example/page',
      userAgent: 'TestAgent/1.0',
      navigationTimeoutMs: 1234,
    });

    await client.httpGet('https://x/a', {});

    expect(setUserAgent).toHaveBeenCalledWith('TestAgent/1.0');
    expect(goto).toHaveBeenCalledWith('https://warm.example/page', { waitUntil: 'domcontentloaded', timeout: 1234 });
  });

  it('reports browser_unavailable when the browser cannot start', async () => {
    const client = new BrowserHttpClient({
      launch: () => Promise.reject(new Error('chrome missing')),
    });
    await expect(client.httpGet('https://x/a', {})).rejects.toMatchObject({
      code: 'browser_unavailable',
      params: { reason: 'chrome missing' },
    });
  });

  it('closes the session and reports browser_unavailable when warm-up fails', async () => {
    const { session, close } = fakeSession({});
    (session.newPage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('navigation timeout'));
    const client = new BrowserHttpClient({ launch: async () => session });

    await expect(client.httpGet('https://x/a', {})).rejects.toMatchObject({
      code: 'browser_unavailable',
      params: { reason: 'navigation timeout' },
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('still reports the warm-up failure when closing the broken session also fails', async () => {
    const { session, close } = fakeSession({});
    (session.newPage as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('navigation timeout'));
    close.mockRejectedValue(new Error('close failed'));
    const client = new BrowserHttpClient({ launch: async () => session });

    await expect(client.httpGet('https://x/a', {})).rejects.toMatchObject({
      code: 'browser_unavailable',
      params: { reason: 'navigation timeout' },
    });
  });

  it('retries the launch after an earlier failure', async () => {
    const { session } = fakeSession({ 'https://x/a': { status: 200, body: 'a' } });
    const launch = vi
      .fn<() => Promise<BrowserSession>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(session);
    const client = new BrowserHttpClient({ launch });

    await expect(client.httpGet('https://x/a', {})).rejects.toMatchObject({ code: 'browser_unavailable' });
    expect(await client.httpGet('https://x/a', {})).toEqual({ status: 200, body: 'a' });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('closes the underlying session and starts a new one on the next request', async () => {
    const { session, close, newPage } = fakeSession({ 'https://x/a': { status: 200, body: 'a' } });
    const client = new BrowserHttpClient({ launch: async () => session });

    await client.httpGet('https://x/a', {});
    await client.close();
    expect(close).toHaveBeenCalledTimes(1);

    await client.httpGet('https://x/a', {});
    expect(newPage).toHaveBeenCalledTimes(2);
  });

  it('close is a no-op when the browser never started', async () => {
    const { session, close } = fakeSession({});
    const client = new BrowserHttpClient({ launch: async () => session });
    await expect(client.close()).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
  });
});
