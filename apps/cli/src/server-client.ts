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

export interface ServerSyncJobReport {
  planned: number;
  fetched: number;
  unchanged: number;
  newRevisions: number;
  failed: Array<{ book: string; chapter: string; code: string }>;
  metadataBuildChanged?: { from: number; to: number };
}

export interface ServerSyncJobStatus {
  translation: string;
  state: 'running' | 'completed' | 'failed';
  refresh: boolean;
  startedAt: string;
  finishedAt?: string;
  progress: { done: number; total: number };
  report?: ServerSyncJobReport;
  error?: { code: string; message: string };
}

export interface ServerStatsResponse {
  translations: Array<{
    abbr: string;
    chapters: { stored: number; total: number };
    revisions: number;
    updatedAt: string;
  }>;
  totals: { translations: number; chapters: number; revisions: number };
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

function parseSyncJobReport(value: Record<string, unknown>, url: string): ServerSyncJobReport {
  if (!Array.isArray(value['failed'])) bad(url, 'field "report.failed" is not an array');
  const report: ServerSyncJobReport = {
    planned: asNumber(value['planned'], url, 'report.planned'),
    fetched: asNumber(value['fetched'], url, 'report.fetched'),
    unchanged: asNumber(value['unchanged'], url, 'report.unchanged'),
    newRevisions: asNumber(value['newRevisions'], url, 'report.newRevisions'),
    failed: value['failed'].map((item) => {
      const entry = asRecord(item, url, 'report.failed[] entry is not an object');
      return {
        book: asString(entry['book'], url, 'report.failed[].book'),
        chapter: asString(entry['chapter'], url, 'report.failed[].chapter'),
        code: asString(entry['code'], url, 'report.failed[].code'),
      };
    }),
  };
  if (value['metadataBuildChanged'] !== undefined) {
    const changed = asRecord(value['metadataBuildChanged'], url, 'field "report.metadataBuildChanged" is not an object');
    report.metadataBuildChanged = {
      from: asNumber(changed['from'], url, 'report.metadataBuildChanged.from'),
      to: asNumber(changed['to'], url, 'report.metadataBuildChanged.to'),
    };
  }
  return report;
}

function parseSyncJobStatus(value: Record<string, unknown>, url: string): ServerSyncJobStatus {
  const state = asString(value['state'], url, 'state');
  if (state !== 'running' && state !== 'completed' && state !== 'failed') {
    bad(url, 'field "state" is not "running", "completed" or "failed"');
  }
  const progress = asRecord(value['progress'], url, 'field "progress" is not an object');
  const status: ServerSyncJobStatus = {
    translation: asString(value['translation'], url, 'translation'),
    state,
    refresh: value['refresh'] === true,
    startedAt: asString(value['startedAt'], url, 'startedAt'),
    progress: {
      done: asNumber(progress['done'], url, 'progress.done'),
      total: asNumber(progress['total'], url, 'progress.total'),
    },
  };
  if (typeof value['finishedAt'] === 'string') status.finishedAt = value['finishedAt'];
  if (value['report'] !== undefined) {
    status.report = parseSyncJobReport(asRecord(value['report'], url, 'field "report" is not an object'), url);
  }
  if (value['error'] !== undefined) {
    const error = asRecord(value['error'], url, 'field "error" is not an object');
    status.error = { code: asString(error['code'], url, 'error.code'), message: asString(error['message'], url, 'error.message') };
  }
  return status;
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

  private async send(
    url: string,
    post: string | undefined,
    token: string | undefined,
    contentType: string,
  ): Promise<{ status: number; body: string }> {
    const headers: Record<string, string> = { ...ACCEPT };
    if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
    return post === undefined
      ? await this.httpGet(url, headers)
      : await this.httpPost(url, post, { ...headers, 'content-type': contentType });
  }

  private async request(url: string, post?: string, contentType = 'text/plain; charset=utf-8'): Promise<unknown> {
    let response: { status: number; body: string };
    try {
      const token = await this.accessToken?.();
      response = await this.send(url, post, token, contentType);
      if (response.status === 401 && token !== undefined && this.accessToken !== undefined) {
        response = await this.send(url, post, await this.accessToken(true), contentType);
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      bad(url, 'not valid JSON');
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && 'data' in parsed && 'meta' in parsed) {
      bad(
        url,
        'received an app API envelope, not a corpus response -- point --server-url at the corpus API (e.g. https://host/corpus)',
      );
    }
    return parsed;
  }

  /** Wraps {@link request} for the admin-only routes, remapping a 401/403 to a distinct error so the
   *  caller can tell "wrong token" apart from every other request failure. */
  private async requestAdmin(url: string, post?: string, contentType?: string): Promise<unknown> {
    try {
      return await this.request(url, post, contentType);
    } catch (error) {
      if (error instanceof HolyDeckError && error.code === 'server_error') {
        const status = error.params['status'];
        if (status === 401 || status === 403) throw new HolyDeckError('server_admin_token_required', { url });
      }
      throw error;
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

  async sync(abbr: string, options: { refresh?: boolean } = {}): Promise<ServerSyncJobStatus> {
    const url = `${this.baseUrl}/api/v1/translations/${encodeURIComponent(abbr)}/sync`;
    const body = JSON.stringify({ refresh: options.refresh === true });
    const data = asRecord(await this.requestAdmin(url, body, 'application/json'), url, 'not an object');
    return parseSyncJobStatus(data, url);
  }

  async syncStatus(abbr: string): Promise<ServerSyncJobStatus | undefined> {
    const url = `${this.baseUrl}/api/v1/translations/${encodeURIComponent(abbr)}/sync`;
    try {
      return parseSyncJobStatus(asRecord(await this.requestAdmin(url), url, 'not an object'), url);
    } catch (error) {
      if (error instanceof HolyDeckError && error.code === 'server_error' && error.params['status'] === 404) return undefined;
      throw error;
    }
  }

  async stats(): Promise<ServerStatsResponse> {
    const url = `${this.baseUrl}/api/v1/stats`;
    const data = asRecord(await this.requestAdmin(url), url, 'not an object');
    if (!Array.isArray(data['translations'])) bad(url, 'field "translations" is not an array');
    const translations = data['translations'].map((item) => {
      const entry = asRecord(item, url, 'translation entry is not an object');
      const chapters = asRecord(entry['chapters'], url, 'field "chapters" is not an object');
      return {
        abbr: asString(entry['abbr'], url, 'abbr'),
        chapters: {
          stored: asNumber(chapters['stored'], url, 'chapters.stored'),
          total: asNumber(chapters['total'], url, 'chapters.total'),
        },
        revisions: asNumber(entry['revisions'], url, 'revisions'),
        updatedAt: asString(entry['updatedAt'], url, 'updatedAt'),
      };
    });
    const totals = asRecord(data['totals'], url, 'field "totals" is not an object');
    return {
      translations,
      totals: {
        translations: asNumber(totals['translations'], url, 'totals.translations'),
        chapters: asNumber(totals['chapters'], url, 'totals.chapters'),
        revisions: asNumber(totals['revisions'], url, 'totals.revisions'),
      },
    };
  }
}
