import { parseVersionMeta } from './canon.js';
import { HolyDeckError } from './messages.js';
import { chapterUrl, isChallengePage, parseChapterHtml, versionUrl } from './scraper.js';
import type { Canon, TranslationMeta } from './canon.js';
import type { ParsedChapter } from './scraper.js';

export type HttpGet = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;

export interface FetcherOptions {
  httpGet?: HttpGet;
  retries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const BROWSER_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

const defaultHttpGet: HttpGet = async (url, headers) => {
  const response = await fetch(url, { headers, redirect: 'follow' });
  return { status: response.status, body: await response.text() };
};

export class Fetcher {
  private readonly httpGet: HttpGet;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: FetcherOptions = {}) {
    this.httpGet = options.httpGet ?? defaultHttpGet;
    this.retries = options.retries ?? 2;
    this.backoffMs = options.backoffMs ?? 1500;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async get(url: string): Promise<string> {
    let lastStatus = 0;
    let lastNetworkReason: string | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) await this.sleep(this.backoffMs * 2 ** (attempt - 1));
      let status: number;
      let body: string;
      try {
        ({ status, body } = await this.httpGet(url, BROWSER_HEADERS));
      } catch (error) {
        lastNetworkReason = (error as Error).message;
        continue;
      }
      if (isChallengePage(body)) throw new HolyDeckError('scrape_blocked');
      if (status >= 200 && status < 300) return body;
      lastStatus = status;
      lastNetworkReason = undefined;
      if (status < 500) break;
    }
    if (lastNetworkReason !== undefined) {
      throw new HolyDeckError('scrape_network_error', { reason: lastNetworkReason, url });
    }
    throw new HolyDeckError('scrape_http_error', { status: lastStatus, url });
  }

  async fetchChapter(translationId: number, abbr: string, book: string, chapter: string): Promise<ParsedChapter> {
    const url = chapterUrl(translationId, abbr, book, chapter);
    return parseChapterHtml(await this.get(url), book, chapter, url);
  }

  async fetchVersionMeta(translationId: number): Promise<{ meta: TranslationMeta; canon: Canon }> {
    const url = versionUrl(translationId);
    const body = await this.get(url);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new HolyDeckError('version_meta_invalid', { reason: `response from ${url} is not JSON` });
    }
    return parseVersionMeta(payload);
  }
}
