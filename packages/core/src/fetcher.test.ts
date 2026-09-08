import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_HEADERS, Fetcher } from './fetcher.js';
import type { HttpGet } from './fetcher.js';

const psa117 = readFileSync(new URL('../test/fixtures/kjv-psa117.html', import.meta.url), 'utf8');
const versionJson = readFileSync(new URL('../test/fixtures/version-1-kjv.json', import.meta.url), 'utf8');
const noSleep = (): Promise<void> => Promise.resolve();

function fetcherWith(responses: Array<{ status: number; body: string } | Error>): { fetcher: Fetcher; httpGet: ReturnType<typeof vi.fn> } {
  const httpGet = vi.fn<HttpGet>();
  for (const response of responses) {
    if (response instanceof Error) httpGet.mockRejectedValueOnce(response);
    else httpGet.mockResolvedValueOnce(response);
  }
  return { fetcher: new Fetcher({ httpGet, sleep: noSleep, backoffMs: 1 }), httpGet };
}

describe('Fetcher.get', () => {
  it('returns the body on 200 and sends browser-like headers', async () => {
    const { fetcher, httpGet } = fetcherWith([{ status: 200, body: 'ok' }]);
    expect(await fetcher.get('https://x')).toBe('ok');
    const headers = httpGet.mock.calls[0]?.[1] as Record<string, string>;
    expect(headers['user-agent']).toContain('Mozilla');
    expect(headers['accept-language']).toBeDefined();
  });

  it('throws scrape_blocked on a challenge page without retrying', async () => {
    const { fetcher, httpGet } = fetcherWith([{ status: 200, body: '<title>Client Challenge</title>' }]);
    await expect(fetcher.get('https://x')).rejects.toMatchObject({ code: 'scrape_blocked' });
    expect(httpGet).toHaveBeenCalledTimes(1);
  });

  it('detects the challenge even on an error status', async () => {
    const { fetcher } = fetcherWith([{ status: 403, body: '<script src="/_fs-ch-1/x.js"></script>' }]);
    await expect(fetcher.get('https://x')).rejects.toMatchObject({ code: 'scrape_blocked' });
  });

  it('fails fast on 404 without retrying', async () => {
    const { fetcher, httpGet } = fetcherWith([{ status: 404, body: 'nope' }]);
    await expect(fetcher.get('https://x')).rejects.toMatchObject({ code: 'scrape_http_error', params: { status: 404, url: 'https://x' } });
    expect(httpGet).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx with backoff then succeeds', async () => {
    const { fetcher, httpGet } = fetcherWith([{ status: 503, body: '' }, { status: 200, body: 'late ok' }]);
    expect(await fetcher.get('https://x')).toBe('late ok');
    expect(httpGet).toHaveBeenCalledTimes(2);
  });

  it('gives up on persistent 5xx after retries', async () => {
    const { fetcher, httpGet } = fetcherWith([{ status: 500, body: '' }, { status: 500, body: '' }, { status: 500, body: '' }]);
    await expect(fetcher.get('https://x')).rejects.toMatchObject({ code: 'scrape_http_error', params: { status: 500, url: 'https://x' } });
    expect(httpGet).toHaveBeenCalledTimes(3);
  });

  it('retries network errors then reports scrape_network_error', async () => {
    const { fetcher, httpGet } = fetcherWith([new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET')]);
    await expect(fetcher.get('https://x')).rejects.toMatchObject({ code: 'scrape_network_error' });
    expect(httpGet).toHaveBeenCalledTimes(3);
  });

  it('uses a real timer-based sleep by default when retrying', async () => {
    const httpGet = vi
      .fn<HttpGet>()
      .mockResolvedValueOnce({ status: 503, body: '' })
      .mockResolvedValueOnce({ status: 200, body: 'ok after real sleep' });
    const fetcher = new Fetcher({ httpGet, backoffMs: 1 });
    await expect(fetcher.get('https://x')).resolves.toBe('ok after real sleep');
  });

  it('defaults to the global fetch as the transport, following redirects with browser headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, text: () => Promise.resolve('via fetch') });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const fetcher = new Fetcher();
      await expect(fetcher.get('https://x')).resolves.toBe('via fetch');
      expect(fetchMock).toHaveBeenCalledWith('https://x', { headers: BROWSER_HEADERS, redirect: 'follow' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('fetchChapter / fetchVersionMeta', () => {
  it('fetches and parses a chapter', async () => {
    const { fetcher, httpGet } = fetcherWith([{ status: 200, body: psa117 }]);
    const { verses, canonVerseCount } = await fetcher.fetchChapter(1, 'KJV', 'PSA', '117');
    expect(canonVerseCount).toBe(2);
    expect(verses['1']).toContain('O praise');
    expect(httpGet.mock.calls[0]?.[0]).toBe('https://www.bible.com/bible/1/PSA.117.KJV');
  });

  it('fetches and parses version metadata', async () => {
    const { fetcher, httpGet } = fetcherWith([{ status: 200, body: versionJson }]);
    const { meta, canon } = await fetcher.fetchVersionMeta(1);
    expect(meta.abbreviation).toBe('KJV');
    expect(canon.books).toHaveLength(66);
    expect(httpGet.mock.calls[0]?.[0]).toBe('https://www.bible.com/api/bible/version/1');
  });

  it('reports non-JSON version responses as version_meta_invalid', async () => {
    const { fetcher } = fetcherWith([{ status: 200, body: '<html>not json</html>' }]);
    await expect(fetcher.fetchVersionMeta(1)).rejects.toMatchObject({ code: 'version_meta_invalid' });
  });
});
