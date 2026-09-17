// The boundary the application reaches the corpus service across. Three things are settled here rather
// than inside either shell, because both ends have to agree on them: the bearer credential the internal
// corpus port accepts, the shape of a corpus failure, and the translation of every corpus error into a
// released application code. An error with no translation is refused rather than forwarded — forwarding
// an internal service's wording is how internal wording quietly becomes a public promise — and the
// mapping below therefore records both what is translated and what deliberately is not.

import { FIELD_CODES, type Parsed, type ParseFn, type Problem, isRecord, parseObject } from './problems.js';

export const CORPUS_AUTH_HEADER = 'authorization';
export const CORPUS_AUTH_SCHEME = 'Bearer';

/** Short enough to type, long enough that reaching the port is not the same as guessing the token. */
export const MINIMUM_CORPUS_TOKEN_LENGTH = 24;

export function corpusAuthorization(token: string): string {
  return `${CORPUS_AUTH_SCHEME} ${token}`;
}

/** Reads the presented token, or nothing at all when the header is not one bearer credential. */
export function presentedCorpusToken(header: unknown): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return undefined;
  const [scheme = '', ...rest] = value.trim().split(' ');
  if (scheme.toLowerCase() !== CORPUS_AUTH_SCHEME.toLowerCase()) return undefined;
  const token = rest.join(' ').trim();
  // A token with a space in it was never one credential: two presented headers arrive joined.
  return token === '' || token.includes(' ') ? undefined : token;
}

/**
 * Compares a presented token with the configured one in work that does not depend on where the two
 * first differ, so the token cannot be learned one character at a time from how long an answer takes.
 * A corpus with no token configured matches nothing: an internal port with no credential is closed.
 */
export function corpusTokenMatches(presented: string | undefined, expected: string): boolean {
  if (expected === '' || presented === undefined) return false;
  const encoder = new TextEncoder();
  const left = encoder.encode(presented);
  const right = encoder.encode(expected);
  let difference = left.length ^ right.length;
  for (const [index, byte] of right.entries()) difference |= byte ^ (left[index] ?? 0);
  return difference === 0;
}

export type CorpusFailure = { readonly code: string; readonly message: string };

/** Reads the `{ error: { code, message } }` body the corpus answers a refusal with. */
export function parseCorpusFailure(value: unknown, path = 'corpusFailure'): Parsed<CorpusFailure> {
  return parseObject(value, path, (reader) =>
    reader.parsed(
      'error',
      (raw, at) => parseObject(raw, at, (body) => ({ code: body.text('code'), message: body.text('message') })),
      { code: '', message: '' },
    ),
  );
}

export type CorpusTranslation = {
  readonly abbreviation: string;
  readonly id: number;
  readonly title: string;
  readonly language: string;
  readonly syncedChapters: number;
  readonly canonChapters: number;
  readonly cached: boolean;
};

const parseCorpusTranslation: ParseFn<CorpusTranslation> = (value, path) =>
  parseObject(value, path, (reader) => ({
    abbreviation: reader.text('abbreviation'),
    id: reader.wholeNumber('id'),
    title: reader.text('title'),
    // Blank until something is cached, so the corpus sends it empty rather than not at all.
    language: reader.optionalText('language') ?? '',
    syncedChapters: reader.wholeNumber('syncedChapters'),
    canonChapters: reader.wholeNumber('canonChapters'),
    cached: reader.flag('cached'),
  }));

export function parseCorpusTranslations(
  value: unknown,
  path = 'corpusTranslations',
): Parsed<readonly CorpusTranslation[]> {
  return parseObject(value, path, (reader) => reader.parsedList('translations', parseCorpusTranslation));
}

export type CorpusCanonChapter = { readonly id: string; readonly label: string };

export type CorpusCanonBook = {
  readonly usfm: string;
  readonly canon: string;
  readonly name: string;
  readonly longName?: string;
  readonly abbreviation?: string;
  readonly chapters: readonly CorpusCanonChapter[];
};

export type CorpusCanon = {
  readonly translation: string;
  readonly source: 'bundled' | 'synced';
  readonly books: readonly CorpusCanonBook[];
};

const CORPUS_CANON_SOURCES = ['bundled', 'synced'] as const;

const parseCorpusCanonChapter: ParseFn<CorpusCanonChapter> = (value, path) =>
  parseObject(value, path, (reader) => ({ id: reader.text('id'), label: reader.text('label') }));

const parseCorpusCanonBook: ParseFn<CorpusCanonBook> = (value, path) =>
  parseObject(value, path, (reader) => {
    const longName = reader.optionalText('longName');
    const abbreviation = reader.optionalText('abbreviation');
    return {
      usfm: reader.text('usfm'),
      canon: reader.text('canon'),
      name: reader.text('name'),
      ...(longName === undefined ? {} : { longName }),
      ...(abbreviation === undefined ? {} : { abbreviation }),
      chapters: reader.parsedList('chapters', parseCorpusCanonChapter),
    };
  });

export function parseCorpusCanon(value: unknown, path = 'corpusCanon'): Parsed<CorpusCanon> {
  return parseObject(value, path, (reader) => ({
    translation: reader.text('translation'),
    source: reader.choice('source', CORPUS_CANON_SOURCES),
    books: reader.parsedList('books', parseCorpusCanonBook),
  }));
}

export type CorpusVerses = {
  readonly verses: Readonly<Record<string, string>>;
  readonly citation: string;
  readonly revision: number;
  readonly fetchedAt: string;
  readonly source: 'cache' | 'live';
};

const CORPUS_VERSE_SOURCES = ['cache', 'live'] as const;

/** No reader helper reads a map keyed by an arbitrary verse number, so this reads it by hand. */
function parseVerseTexts(raw: unknown, path: string): Parsed<Readonly<Record<string, string>>> {
  if (!isRecord(raw)) return { ok: false, problems: [{ path, code: FIELD_CODES.notAnObject, message: 'must be an object' }] };
  const problems: Problem[] = [];
  const verses: Record<string, string> = {};
  for (const [verse, text] of Object.entries(raw)) {
    if (typeof text === 'string') verses[verse] = text;
    else problems.push({ path: `${path}.${verse}`, code: FIELD_CODES.notText, message: 'must be text' });
  }
  return problems.length === 0 ? { ok: true, value: verses } : { ok: false, problems };
}

export function parseCorpusVerses(value: unknown, path = 'corpusVerses'): Parsed<CorpusVerses> {
  return parseObject(value, path, (reader) => ({
    verses: reader.parsed('verses', parseVerseTexts, {}),
    citation: reader.text('citation'),
    revision: reader.wholeNumber('revision', 1),
    fetchedAt: reader.time('fetchedAt'),
    source: reader.choice('source', CORPUS_VERSE_SOURCES),
  }));
}

export type CorpusErrorMapping = { readonly corpus: string; readonly http: number; readonly code: string };
export type CorpusRefusal = { readonly corpus: string; readonly reason: string };
export type CorpusPort = {
  readonly binding: string;
  readonly publiclyRoutable: boolean;
  readonly authenticated: boolean;
};
export type CorpusClientFacts = {
  readonly typed: boolean;
  readonly generatedFrom: string;
  readonly language: string;
};
export type CorpusRoute = { readonly route: string; readonly preserved: boolean; readonly since: string };
export type CorpusBoundaryPacket = {
  readonly client: CorpusClientFacts;
  readonly port: CorpusPort;
  readonly errorMapping: readonly CorpusErrorMapping[];
  readonly releasedRoutes: readonly CorpusRoute[];
};

export const INTERNAL_BINDINGS = ['loopback', 'internal-network'] as const;

export const CORPUS_CLIENT: CorpusClientFacts = {
  typed: true,
  generatedFrom: 'contracts/corpus-boundary.md',
  language: 'TypeScript',
};

/** The corpus routes the application depends on. A route it does not name here, it must not call. */
export const CORPUS_ROUTES: readonly CorpusRoute[] = [
  { route: 'GET /health', preserved: true, since: '2026-09-13' },
  { route: 'GET /api/v1/translations', preserved: true, since: '2026-09-13' },
  { route: 'GET /api/v1/translations/:abbr/canon', preserved: true, since: '2026-09-13' },
  { route: 'GET /api/v1/translations/:abbr/verses', preserved: true, since: '2026-09-13' },
];

export const CORPUS_UNEXPECTED = 'corpus.unexpected_error';

// The released status for that code, written out rather than looked up so a refusal cannot fall back to
// a guessed status when the lookup finds nothing; `corpus.test.ts` holds it against the registry.
export const CORPUS_UNEXPECTED_STATUS = 500;

/**
 * Every corpus error the application translates, with the released code and status it becomes. The
 * corpus side of this table is checked against the statuses the corpus can actually answer with, so a
 * corpus error nobody has decided about cannot reach a client wearing a code that was not chosen for it.
 */
export const CORPUS_ERROR_MAPPING: readonly CorpusErrorMapping[] = [
  { corpus: 'invalid_verse_list', http: 422, code: 'corpus.reference.malformed' },
  { corpus: 'invalid_reference', http: 422, code: 'corpus.reference.malformed' },
  { corpus: 'unknown_translation', http: 404, code: 'corpus.translation.unknown' },
  { corpus: 'chapter_not_in_store', http: 404, code: 'corpus.reference.not_found' },
  { corpus: 'verse_not_in_store', http: 404, code: 'corpus.reference.not_found' },
  { corpus: 'revision_not_found', http: 404, code: 'corpus.revision.not_found' },
  { corpus: 'store_locked', http: 503, code: 'corpus.unavailable' },
  { corpus: 'rate_limit_exceeded', http: 503, code: 'corpus.unavailable' },
  { corpus: 'internal_error', http: 503, code: 'corpus.unavailable' },
  { corpus: 'scrape_blocked', http: 502, code: 'corpus.upstream.unavailable' },
  { corpus: 'scrape_http_error', http: 502, code: 'corpus.upstream.unavailable' },
  { corpus: 'scrape_network_error', http: 502, code: 'corpus.upstream.unavailable' },
  { corpus: 'scrape_parse_failed', http: 502, code: 'corpus.upstream.unavailable' },
  { corpus: 'version_meta_invalid', http: 502, code: 'corpus.upstream.unavailable' },
];

/**
 * The corpus errors the application deliberately does not translate. Each of these reaches a client as
 * `corpus.unexpected_error` with the corpus's own wording dropped, because each one means the fault is
 * the application's or the deployment's rather than the client's.
 */
export const CORPUS_ERRORS_NOT_FORWARDED: readonly CorpusRefusal[] = [
  { corpus: 'request_invalid', reason: 'the application built the request, so a refusal is its own fault' },
  { corpus: 'route_not_found', reason: 'the application asked for a route the corpus does not serve' },
  { corpus: 'auth_failed', reason: 'the corpus credential is a deployment setting, not a client input' },
  { corpus: 'sermon_invalid', reason: 'the render route, which the application does not use' },
  { corpus: 'config_invalid_value', reason: 'the render route, which the application does not use' },
  { corpus: 'config_file_unreadable', reason: 'the render route, which the application does not use' },
  { corpus: 'template_invalid', reason: 'the render route, which the application does not use' },
  { corpus: 'template_index_out_of_range', reason: 'the render route, which the application does not use' },
  { corpus: 'sync_already_running', reason: 'the application does not start corpus syncs yet' },
  { corpus: 'sync_job_not_found', reason: 'the application does not follow corpus syncs yet' },
];

export function corpusFailureMapping(code: string): CorpusErrorMapping | undefined {
  return CORPUS_ERROR_MAPPING.find((entry) => entry.corpus === code);
}

/** The boundary this build presents, given what the deployment did with the corpus port. */
export function corpusBoundary(port: CorpusPort): CorpusBoundaryPacket {
  return { client: CORPUS_CLIENT, port, errorMapping: CORPUS_ERROR_MAPPING, releasedRoutes: CORPUS_ROUTES };
}

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const blank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';
const STABLE_CODE = /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/u;

/**
 * Grades a boundary recording — the client, the port the corpus listens on, the error mapping, and the
 * corpus routes the application depends on — in the words the contract's own acceptance criterion uses.
 */
export function corpusBoundaryProblems(packet: unknown): readonly string[] {
  if (!isRecord(packet)) return ['corpus boundary: must be an object'];
  const problems: string[] = [];

  const client = record(packet['client']);
  if (client['typed'] !== true) problems.push('corpus client: is not typed');
  if (blank(client['generatedFrom'])) problems.push('corpus client: names no schema it is generated from');

  const port = record(packet['port']);
  if (port['publiclyRoutable'] !== false) problems.push('corpus port: is publicly routable');
  const binding = port['binding'];
  if (!INTERNAL_BINDINGS.some((allowed) => allowed === binding)) {
    problems.push(`corpus port: binding ${String(binding)} is not internal`);
  }
  if (port['authenticated'] !== true) problems.push('corpus port: is unauthenticated');

  const mapping = listOf(packet['errorMapping']);
  if (mapping.length === 0) problems.push('corpus boundary: no error mapping');
  for (const item of mapping) {
    const entry = record(item);
    const corpus = entry['corpus'];
    const http = entry['http'];
    const code = entry['code'];
    const label = `error mapping ${String(corpus ?? '?')}`;
    if (blank(corpus)) problems.push('error mapping: names no corpus error');
    const status = typeof http === 'number' && Number.isInteger(http) ? http : 0;
    if (status < 400 || status > 599) {
      problems.push(`${label}: maps to ${String(http)}, which is not a client or server status`);
    }
    if (!STABLE_CODE.test(typeof code === 'string' ? code : '')) {
      problems.push(`${label}: ${String(code)} is not a stable message code`);
    }
  }

  const routes = listOf(packet['releasedRoutes']);
  if (routes.length === 0) problems.push('corpus boundary: no released routes recorded');
  for (const item of routes) {
    const route = record(item);
    if (route['preserved'] !== true) problems.push(`released route ${String(route['route'])}: was not preserved`);
  }
  return problems;
}
