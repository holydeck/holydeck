import { HolyDeckError } from '@holydeck/core/messages';
import { formatVerseList } from '@holydeck/core/references';
import type { HttpGet } from '@holydeck/core/fetcher';
import type { Canon } from '@holydeck/core/canon';
import type { VerseMap } from '@holydeck/core/storage';

export type HttpPost = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ status: number; body: string }>;

export type AccessTokenProvider = (forceRefresh?: boolean) => Promise<string | undefined>;

export interface ServerTranslationSummary {
  abbreviation: string;
  id: number;
  title: string;
  language: string;
  syncedChapters: number;
  canonChapters: number;
}

export interface ServerVersesResponse {
  verses: VerseMap;
  citation: string;
  revision: number;
  fetchedAt: string;
  source: 'cache' | 'live';
}

export interface ServerHealth {
  status: string;
  version: string;
  uptime: number;
  store: string;
}

const ACCEPT = { accept: 'application/json' };

function bad(url: string, reason: string): never {
  throw new HolyDeckError('server_bad_response', { url, reason });
}

function asRecord(value: unknown, url: string, reason: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) bad(url, reason);
  return value as Record<string, unknown>;
}

function asString(value: unknown, url: string, field: string): string {
  if (typeof value !== 'string') bad(url, `field "${field}" is not a string`);
  return value;
}

function asNumber(value: unknown, url: string, field: string): number {
  if (typeof value !== 'number') bad(url, `field "${field}" is not a number`);
  return value;
}

export class ServerClient {
  readonly baseUrl: string;
  private readonly httpGet: HttpGet;
  private readonly httpPost: HttpPost;
  private readonly accessToken?: AccessTokenProvider;

  constructor(serverUrl: string, options: { httpGet: HttpGet; httpPost: HttpPost; accessToken?: AccessTokenProvider }) {
    this.baseUrl = serverUrl.replace(/\/+$/, '');
    this.httpGet = options.httpGet;
    this.httpPost = options.httpPost;
    this.accessToken = options.accessToken;
  }

  private async send(url: string, post: string | undefined, token: string | undefined): Promise<{ status: number; body: string }> {
    const headers: Record<string, string> = { ...ACCEPT };
    if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
    return post === undefined
      ? await this.httpGet(url, headers)
      : await this.httpPost(url, post, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
  }

  private async request(url: string, post?: string): Promise<unknown> {
    let response: { status: number; body: string };
    try {
      const token = await this.accessToken?.();
      response = await this.send(url, post, token);
      if (response.status === 401 && token !== undefined && this.accessToken !== undefined) {
        response = await this.send(url, post, await this.accessToken(true));
      }
    } catch (error) {
      if (error instanceof HolyDeckError) throw error;
      throw new HolyDeckError('server_unreachable', {
        reason: error instanceof Error ? error.message : String(error),
        url,
      });
    }
    if (response.status >= 400) {
      let message = response.body.slice(0, 200);
      try {
        const parsed = JSON.parse(response.body) as { error?: { message?: unknown } };
        if (typeof parsed.error?.message === 'string') message = parsed.error.message;
      } catch {
        // keep the body snippet
      }
      throw new HolyDeckError('server_error', { status: response.status, url, message });
    }
    try {
      return JSON.parse(response.body);
    } catch {
      bad(url, 'not valid JSON');
    }
  }

  async health(): Promise<ServerHealth> {
    const url = `${this.baseUrl}/health`;
    const data = asRecord(await this.request(url), url, 'not an object');
    return {
      status: asString(data['status'], url, 'status'),
      version: asString(data['version'], url, 'version'),
      uptime: asNumber(data['uptime'], url, 'uptime'),
      store: asString(data['store'], url, 'store'),
    };
  }

  async getTranslations(): Promise<ServerTranslationSummary[]> {
    const url = `${this.baseUrl}/api/v1/translations`;
    const data = asRecord(await this.request(url), url, 'not an object');
    if (!Array.isArray(data['translations'])) bad(url, 'field "translations" is not an array');
    return data['translations'].map((item) => {
      const entry = asRecord(item, url, 'translation entry is not an object');
      return {
        abbreviation: asString(entry['abbreviation'], url, 'abbreviation'),
        id: asNumber(entry['id'], url, 'id'),
        title: asString(entry['title'], url, 'title'),
        language: asString(entry['language'], url, 'language'),
        syncedChapters: asNumber(entry['syncedChapters'], url, 'syncedChapters'),
        canonChapters: asNumber(entry['canonChapters'], url, 'canonChapters'),
      };
    });
  }

  async getCanon(abbr: string): Promise<Canon> {
    const url = `${this.baseUrl}/api/v1/translations/${encodeURIComponent(abbr)}/canon`;
    const data = asRecord(await this.request(url), url, 'not an object');
    if (!Array.isArray(data['books'])) bad(url, 'field "books" is not an array');
    return data as unknown as Canon;
  }

  async getVerses(
    abbr: string,
    book: string,
    chapter: number,
    verses: number[],
    options: { refresh?: boolean; revision?: number; fetchMissing?: boolean } = {},
  ): Promise<ServerVersesResponse> {
    const params = new URLSearchParams({ book, chapter: String(chapter), verses: formatVerseList(verses) });
    if (options.refresh) params.set('refresh', 'true');
    // The server fetches a missing chapter by default, so only the opt-out needs saying.
    if (options.fetchMissing === false) params.set('fetchMissing', 'false');
    if (options.revision !== undefined) params.set('revision', String(options.revision));
    const url = `${this.baseUrl}/api/v1/translations/${encodeURIComponent(abbr)}/verses?${params.toString()}`;
    const data = asRecord(await this.request(url), url, 'not an object');
    const source = asString(data['source'], url, 'source');
    if (source !== 'cache' && source !== 'live') bad(url, 'field "source" is not "cache" or "live"');
    return {
      verses: asRecord(data['verses'], url, 'field "verses" is not an object') as VerseMap,
      citation: asString(data['citation'], url, 'citation'),
      revision: asNumber(data['revision'], url, 'revision'),
      fetchedAt: asString(data['fetchedAt'], url, 'fetchedAt'),
      source,
    };
  }

  async render(sermonText: string): Promise<{ output: string; notices: string[] }> {
    const url = `${this.baseUrl}/api/v1/render`;
    const data = asRecord(await this.request(url, sermonText), url, 'not an object');
    const notices = Array.isArray(data['notices']) ? data['notices'].map((n) => asString(n, url, 'notices[]')) : [];
    return { output: asString(data['output'], url, 'output'), notices };
  }
}
