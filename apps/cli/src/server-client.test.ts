import { describe, expect, it } from 'vitest';
import { HolyDeckError } from '@holydeck/core/messages';
import { ServerClient, type HttpPost } from './server-client.js';
import type { HttpGet } from '@holydeck/core/fetcher';

const noPost: HttpPost = async () => {
  throw new Error('unexpected POST');
};
const noGet: HttpGet = async () => {
  throw new Error('unexpected GET');
};

function getClient(responses: Record<string, { status: number; body: string }>, seen: string[] = []) {
  const httpGet: HttpGet = async (url) => {
    seen.push(url);
    const response = responses[url];
    if (!response) throw new Error(`connect ECONNREFUSED (${url})`);
    return response;
  };
  return new ServerClient('https://holydeck.example.com/', { httpGet, httpPost: noPost });
}

describe('ServerClient URLs and parsing', () => {
  it('normalizes a trailing slash off the base URL', () => {
    expect(getClient({}).baseUrl).toBe('https://holydeck.example.com');
  });

  it('fetches health from outside the API prefix', async () => {
    const client = getClient({
      'https://holydeck.example.com/health': {
        status: 200,
        body: JSON.stringify({ status: 'ok', version: '0.0.0', uptime: 12, store: 'ok' }),
      },
    });
    await expect(client.health()).resolves.toEqual({ status: 'ok', version: '0.0.0', uptime: 12, store: 'ok' });
  });

  it('lists translations', async () => {
    const summary = { abbreviation: 'KJV', id: 1, title: 'King James Version', language: 'English', syncedChapters: 1189, canonChapters: 1189 };
    const client = getClient({
      'https://holydeck.example.com/api/v1/translations': {
        status: 200,
        body: JSON.stringify({ translations: [summary] }),
      },
    });
    await expect(client.getTranslations()).resolves.toEqual([summary]);
  });

  it('fetches a canon', async () => {
    const canon = { books: [{ usfm: 'GEN', canon: 'ot', name: 'Genesis', chapters: [{ id: 'GEN.1', label: '1' }] }] };
    const client = getClient({
      'https://holydeck.example.com/api/v1/translations/KJV/canon': { status: 200, body: JSON.stringify(canon) },
    });
    await expect(client.getCanon('KJV')).resolves.toEqual(canon);
  });

  it('builds the verses query with verse list, refresh and revision', async () => {
    const seen: string[] = [];
    const payload = { verses: { '24': 'This is the day.' }, citation: 'Psalm 118:24', revision: 2, fetchedAt: '2026-09-01T00:00:00.000Z', source: 'cache' };
    const client = getClient(
      {
        'https://holydeck.example.com/api/v1/translations/KJV/verses?book=PSA&chapter=118&verses=24&refresh=true&revision=2': {
          status: 200,
          body: JSON.stringify(payload),
        },
      },
      seen,
    );
    await expect(client.getVerses('KJV', 'PSA', 118, [24], { refresh: true, revision: 2 })).resolves.toEqual(payload);
    expect(seen).toHaveLength(1);
  });

  it('omits refresh and revision params by default', async () => {
    const seen: string[] = [];
    const payload = { verses: { '1': 'a', '2': 'b' }, citation: 'Psalm 117:1-2', revision: 1, fetchedAt: '2026-09-01T00:00:00.000Z', source: 'live' };
    const client = getClient(
      {
        'https://holydeck.example.com/api/v1/translations/KJV/verses?book=PSA&chapter=117&verses=1-2': {
          status: 200,
          body: JSON.stringify(payload),
        },
      },
      seen,
    );
    await expect(client.getVerses('KJV', 'PSA', 117, [1, 2])).resolves.toEqual(payload);
  });

  it('posts sermon text to render and defaults notices', async () => {
    const posts: Array<{ url: string; body: string; contentType: string }> = [];
    const httpPost: HttpPost = async (url, body, headers) => {
      posts.push({ url, body, contentType: headers['content-type'] ?? '' });
      return { status: 200, body: JSON.stringify({ output: 'rendered text\n' }) };
    };
    const client = new ServerClient('https://holydeck.example.com', { httpGet: noGet, httpPost });
    await expect(client.render('translations: [KJV]\n')).resolves.toEqual({ output: 'rendered text\n', notices: [] });
    expect(posts).toEqual([
      {
        url: 'https://holydeck.example.com/api/v1/render',
        body: 'translations: [KJV]\n',
        contentType: 'text/plain; charset=utf-8',
      },
    ]);
  });
});

describe('ServerClient errors', () => {
  it('maps transport failures to server_unreachable', async () => {
    const client = getClient({});
    const error = await client.getTranslations().catch((e: unknown) => e as HolyDeckError);
    expect((error as HolyDeckError).code).toBe('server_unreachable');
    expect((error as HolyDeckError).params['url']).toBe('https://holydeck.example.com/api/v1/translations');
  });

  it('maps an envelope error to server_error with the envelope message', async () => {
    const client = getClient({
      'https://holydeck.example.com/api/v1/translations/XYZ/canon': {
        status: 404,
        body: JSON.stringify({ error: { code: 'unknown_translation', message: 'Unknown translation "XYZ". Known: KJV.' } }),
      },
    });
    const error = await client.getCanon('XYZ').catch((e: unknown) => e as HolyDeckError);
    expect((error as HolyDeckError).code).toBe('server_error');
    expect((error as HolyDeckError).params).toEqual({
      status: 404,
      url: 'https://holydeck.example.com/api/v1/translations/XYZ/canon',
      message: 'Unknown translation "XYZ". Known: KJV.',
    });
  });

  it('falls back to a body snippet when the error body is not an envelope', async () => {
    const client = getClient({
      'https://holydeck.example.com/api/v1/translations': { status: 502, body: '<html>Bad Gateway</html>' },
    });
    const error = await client.getTranslations().catch((e: unknown) => e as HolyDeckError);
    expect((error as HolyDeckError).code).toBe('server_error');
    expect((error as HolyDeckError).params['message']).toBe('<html>Bad Gateway</html>');
  });

  it('maps invalid JSON on a 2xx to server_bad_response', async () => {
    const client = getClient({
      'https://holydeck.example.com/api/v1/translations': { status: 200, body: 'not json' },
    });
    const error = await client.getTranslations().catch((e: unknown) => e as HolyDeckError);
    expect((error as HolyDeckError).code).toBe('server_bad_response');
  });

  it('rejects mis-shaped payloads field by field', async () => {
    const cases: Array<[string, string, (client: ServerClient) => Promise<unknown>]> = [
      ['https://holydeck.example.com/api/v1/translations', JSON.stringify({ translations: [{ abbreviation: 'KJV' }] }), (c) => c.getTranslations()],
      ['https://holydeck.example.com/api/v1/translations', JSON.stringify({}), (c) => c.getTranslations()],
      ['https://holydeck.example.com/api/v1/translations/KJV/canon', JSON.stringify({ books: 'nope' }), (c) => c.getCanon('KJV')],
      ['https://holydeck.example.com/api/v1/translations/KJV/verses?book=PSA&chapter=117&verses=1', JSON.stringify({ verses: {}, citation: 'x', revision: 1, fetchedAt: 'y', source: 'weird' }), (c) => c.getVerses('KJV', 'PSA', 117, [1])],
      ['https://holydeck.example.com/api/v1/translations/KJV/verses?book=PSA&chapter=118&verses=1', JSON.stringify({ verses: 'nope', citation: 'x', revision: 1, fetchedAt: 'y', source: 'cache' }), (c) => c.getVerses('KJV', 'PSA', 118, [1])],
      ['https://holydeck.example.com/health', JSON.stringify({ status: 'ok' }), (c) => c.health()],
    ];
    for (const [url, body, call] of cases) {
      const client = getClient({ [url]: { status: 200, body } });
      const error = await call(client).catch((e: unknown) => e as HolyDeckError);
      expect((error as HolyDeckError).code).toBe('server_bad_response');
    }
  });

  it('rejects a mis-shaped render payload', async () => {
    const httpPost: HttpPost = async () => ({ status: 200, body: JSON.stringify({ output: 42 }) });
    const client = new ServerClient('https://holydeck.example.com', { httpGet: noGet, httpPost });
    const error = await client.render('x').catch((e: unknown) => e as HolyDeckError);
    expect((error as HolyDeckError).code).toBe('server_bad_response');
  });

  it('rejects a render payload with a non-string notice', async () => {
    const httpPost: HttpPost = async () => ({ status: 200, body: JSON.stringify({ output: 'ok', notices: [42] }) });
    const client = new ServerClient('https://holydeck.example.com', { httpGet: noGet, httpPost });
    const error = await client.render('x').catch((e: unknown) => e as HolyDeckError);
    expect((error as HolyDeckError).code).toBe('server_bad_response');
  });

  it('maps a non-Error transport failure to server_unreachable using String(error)', async () => {
    const httpGet: HttpGet = async () => {
      throw 'connection reset';
    };
    const client = new ServerClient('https://holydeck.example.com', { httpGet, httpPost: noPost });
    const error = await client.getTranslations().catch((e: unknown) => e as HolyDeckError);
    expect((error as HolyDeckError).code).toBe('server_unreachable');
    expect((error as HolyDeckError).params['reason']).toBe('connection reset');
  });
});
