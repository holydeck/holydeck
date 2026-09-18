import {
  CORPUS_AUTH_HEADER,
  CORPUS_UNEXPECTED,
  CORPUS_UNEXPECTED_STATUS,
  INTERNAL_BINDINGS,
  corpusAuthorization,
  corpusBoundary,
  corpusFailureMapping,
  parseCorpusCanon,
  parseCorpusFailure,
  parseCorpusSearch,
  parseCorpusTranslations,
  parseCorpusVerses,
} from '@holydeck/contracts/corpus';

import type {
  CorpusBoundaryPacket,
  CorpusCanon,
  CorpusSearch,
  CorpusSearchHit,
  CorpusTranslation,
  CorpusVerses,
} from '@holydeck/contracts/corpus';
import type { TranslationOffsetStore } from './translation-offsets.js';

/**
 * The only way this application talks to the corpus service.
 *
 * Two rules hold everything here together. The corpus is reachable from inside the deployment and
 * nowhere else, so its address is graded against the documented boundary before the application will
 * run. And nothing the corpus says reaches a client: every failure is translated into a code this
 * application publishes, with wording written here, because a corpus message names stores, jobs and
 * upstream sites that a congregation has no business reading and an attacker would like to. A
 * failure with no translation is refused as unexpected rather than forwarded.
 */

export interface CorpusSettings {
  readonly url: string;
  readonly token: string;
}

export interface CorpusRefusal {
  readonly code: string;
  readonly status: number;
  readonly message: string;
}

export type CorpusResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: CorpusRefusal };

export interface CorpusAnswer {
  readonly status: number;
  json(): Promise<unknown>;
}

export type Fetching = (url: string, init: { readonly headers: Readonly<Record<string, string>> }) => Promise<CorpusAnswer>;

/**
 * What a client is told when the library could not answer. Every code the contract publishes under
 * `corpus.` has an entry, checked in both directions, so a new code cannot be served as `undefined`.
 */
export const CORPUS_WORDING = {
  'corpus.reference.malformed': 'That reference could not be read.',
  'corpus.reference.not_found': 'That passage is not in the library yet.',
  'corpus.translation.unknown': 'That translation is not one the library holds.',
  'corpus.revision.not_found': 'That revision of the library is no longer available.',
  'corpus.unavailable': 'The library is not available right now.',
  'corpus.upstream.unavailable': 'The library could not reach the source it needs.',
  'corpus.unexpected_error': 'The library answered in a way this application could not use.',
} as const satisfies Record<string, string>;

type CorpusCode = keyof typeof CORPUS_WORDING;

const refusal = (code: CorpusCode, status: number): CorpusRefusal => ({ code, status, message: CORPUS_WORDING[code] });

export const LIBRARY_UNAVAILABLE = refusal('corpus.unavailable', 503);
export const LIBRARY_UNEXPECTED = refusal(CORPUS_UNEXPECTED, CORPUS_UNEXPECTED_STATUS);
export const LIBRARY_NOT_CONFIGURED: CorpusRefusal = {
  ...LIBRARY_UNAVAILABLE,
  message: 'No scripture library is configured for this deployment.',
};

/** What a reference is refused as when nothing in the canon matches it, without asking the library at all. */
export const REFERENCE_NOT_FOUND = refusal('corpus.reference.not_found', 404);

/** What a verse list this application cannot even read is refused as, before the library is asked. */
export const REFERENCE_MALFORMED = refusal('corpus.reference.malformed', 422);

const TRANSLATIONS_PATH = '/api/v1/translations';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/** Written as arithmetic rather than as a pattern, so no address of anyone's ends up in this file. */
function isPrivateAddress(host: string): boolean {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets as [number, number, number, number];
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

/** The documented binding a host belongs to, or the host itself when it belongs to none. */
export function bindingOf(hostname: string): string {
  if (LOOPBACK.includes(hostname)) return 'loopback';
  // A name with no dots is a name only this deployment's network resolves, which is what a compose
  // service or a cluster service is; anything else is a name the rest of the world can resolve too.
  if (!hostname.includes('.') || isPrivateAddress(hostname)) return 'internal-network';
  return hostname;
}

export function corpusBinding(url: string): string {
  return bindingOf(new URL(url).hostname);
}

/** The boundary packet this deployment presents, for the documented check to grade. */
export function corpusBoundaryFor(settings: CorpusSettings): CorpusBoundaryPacket {
  const binding = corpusBinding(settings.url);
  return corpusBoundary({
    binding,
    publiclyRoutable: !INTERNAL_BINDINGS.some((internal) => internal === binding),
    authenticated: settings.token !== '',
  });
}

const addressOf = (url: string): string => url.replace(/\/+$/u, '');

function translate(body: unknown): CorpusRefusal {
  const failure = parseCorpusFailure(body);
  if (!failure.ok) return LIBRARY_UNEXPECTED;
  const mapping = corpusFailureMapping(failure.value.code);
  if (mapping === undefined) return LIBRARY_UNEXPECTED;
  // Every mapping names a published code, and every published code has wording; both are held by a
  // test on each side of the boundary, which is what makes this lookup a lookup and not a guess.
  return refusal(mapping.code as CorpusCode, mapping.http);
}

const canonPath = (abbr: string): string => `${TRANSLATIONS_PATH}/${encodeURIComponent(abbr)}/canon`;

function versesPath(abbr: string, book: string, chapter: number, verses: readonly number[], revision?: number): string {
  const query = new URLSearchParams({ book, chapter: String(chapter), verses: verses.join(',') });
  if (revision !== undefined) query.set('revision', String(revision));
  return `${TRANSLATIONS_PATH}/${encodeURIComponent(abbr)}/verses?${query.toString()}`;
}

function searchPath(abbr: string, query: string): string {
  return `${TRANSLATIONS_PATH}/${encodeURIComponent(abbr)}/search?${new URLSearchParams({ q: query }).toString()}`;
}

export function corpusClient(settings: CorpusSettings, fetching: Fetching): {
  translations(): Promise<CorpusResult<readonly CorpusTranslation[]>>;
  canon(abbr: string): Promise<CorpusResult<CorpusCanon>>;
  verses(
    abbr: string,
    book: string,
    chapter: number,
    verses: readonly number[],
    revision?: number,
  ): Promise<CorpusResult<CorpusVerses>>;
  search(abbr: string, query: string): Promise<CorpusResult<CorpusSearch>>;
} {
  const address = addressOf(settings.url);

  async function ask(path: string): Promise<CorpusResult<unknown>> {
    if (settings.url === '') return { ok: false, refusal: LIBRARY_NOT_CONFIGURED };
    let answer: CorpusAnswer;
    try {
      answer = await fetching(`${address}${path}`, {
        headers: { [CORPUS_AUTH_HEADER]: corpusAuthorization(settings.token) },
      });
    } catch {
      return { ok: false, refusal: LIBRARY_UNAVAILABLE };
    }
    let body: unknown;
    try {
      body = await answer.json();
    } catch {
      return { ok: false, refusal: LIBRARY_UNEXPECTED };
    }
    if (answer.status >= 200 && answer.status < 300) return { ok: true, value: body };
    return { ok: false, refusal: translate(body) };
  }

  return {
    async translations() {
      const answer = await ask(TRANSLATIONS_PATH);
      if (!answer.ok) return answer;
      const parsed = parseCorpusTranslations(answer.value);
      return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, refusal: LIBRARY_UNEXPECTED };
    },
    async canon(abbr) {
      const answer = await ask(canonPath(abbr));
      if (!answer.ok) return answer;
      const parsed = parseCorpusCanon(answer.value);
      return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, refusal: LIBRARY_UNEXPECTED };
    },
    async verses(abbr, book, chapter, verses, revision) {
      const answer = await ask(versesPath(abbr, book, chapter, verses, revision));
      if (!answer.ok) return answer;
      const parsed = parseCorpusVerses(answer.value);
      return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, refusal: LIBRARY_UNEXPECTED };
    },
    async search(abbr, query) {
      const answer = await ask(searchPath(abbr, query));
      if (!answer.ok) return answer;
      const parsed = parseCorpusSearch(answer.value);
      return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, refusal: LIBRARY_UNEXPECTED };
    },
  };
}

export interface ReferenceSelection {
  readonly abbr: string;
  readonly book: string;
  readonly chapter: number;
  readonly verses: readonly number[];
  readonly revision?: number;
}

/**
 * Selects one validated reference and records the corpus revision it was read at. The book and chapter
 * are checked against the canon here, so a reference nothing in it holds never reaches the library at
 * all; the verse list is not, because the canon this checks against carries no verse count — that is
 * left to the library's own answer, which is where a revision is recorded in the first place.
 */
export async function selectReference(
  client: ReturnType<typeof corpusClient>,
  selection: ReferenceSelection,
): Promise<CorpusResult<CorpusVerses>> {
  const canon = await client.canon(selection.abbr);
  if (!canon.ok) return canon;
  const book = canon.value.books.find((entry) => entry.usfm === selection.book.toUpperCase());
  const chapter = book?.chapters.some((entry) => entry.id === String(selection.chapter)) ?? false;
  if (!chapter) return { ok: false, refusal: REFERENCE_NOT_FOUND };
  return client.verses(selection.abbr, selection.book, selection.chapter, selection.verses, selection.revision);
}

/**
 * The same reference, shifted by a translation's configured offset (spec BIBL-02). Pure, so the shift can
 * be proven without a network: `selectReference` already checks the shifted chapter against the canon
 * before it ever asks for verses, which is what rejects an offset that walks a reference out of canon —
 * for free, and before retrieval, without this needing to know what the canon holds.
 */
export function applyOffset(selection: ReferenceSelection, offset: number): ReferenceSelection {
  return offset === 0 ? selection : { ...selection, chapter: selection.chapter + offset };
}

/**
 * One validated reference per selection stacked, each shifted by its own translation's configured offset,
 * in the exact order the selections were given — never resorted, and never short-circuited: a selection
 * this could not read still leaves its own slot behind a `CorpusResult` that says so, and costs no other
 * slot in the stack. Sequential rather than concurrent, so that order is never left to how fast one
 * translation's library answers relative to another's.
 */
export async function stackReferences(
  client: ReturnType<typeof corpusClient>,
  offsetStore: Pick<TranslationOffsetStore, 'get'>,
  selections: readonly ReferenceSelection[],
): Promise<readonly CorpusResult<CorpusVerses>[]> {
  const results: CorpusResult<CorpusVerses>[] = [];
  for (const selection of selections) {
    const offset = await offsetStore.get(selection.abbr);
    results.push(await selectReference(client, applyOffset(selection, offset)));
  }
  return Object.freeze(results);
}

export interface ScriptureMatch {
  /** The passage the match was found in, as a reference the library can be asked to open. */
  readonly reference: ReferenceSelection;
  readonly text: string;
  readonly phrase: boolean;
  readonly occurrences: number;
  readonly bookOrder: number;
}

/**
 * The reference a hit names. Opening a search result is this and nothing more: the passage it was found
 * in, at the revision it was searched at, so what is read back is what was matched rather than whatever
 * the library holds by then.
 */
export function referenceOf(abbr: string, hit: CorpusSearchHit): ReferenceSelection {
  return { abbr, book: hit.book, chapter: hit.chapter, verses: [hit.verse], revision: hit.revision };
}

/**
 * Relevance first — the phrase itself above the same words scattered through a verse, and more of them
 * above fewer — and then the canon, and then the translation's name. The last three are what make the
 * order a property of the query and the library rather than of whichever translation answered first.
 */
function compareMatches(left: ScriptureMatch, right: ScriptureMatch): number {
  if (left.phrase !== right.phrase) return left.phrase ? -1 : 1;
  if (left.occurrences !== right.occurrences) return right.occurrences - left.occurrences;
  if (left.bookOrder !== right.bookOrder) return left.bookOrder - right.bookOrder;
  if (left.reference.book !== right.reference.book) return left.reference.book < right.reference.book ? -1 : 1;
  if (left.reference.chapter !== right.reference.chapter) return left.reference.chapter - right.reference.chapter;
  const leftVerse = left.reference.verses[0] ?? 0;
  const rightVerse = right.reference.verses[0] ?? 0;
  if (leftVerse !== rightVerse) return leftVerse - rightVerse;
  if (left.reference.abbr === right.reference.abbr) return 0;
  return left.reference.abbr < right.reference.abbr ? -1 : 1;
}

/**
 * Word and phrase search across the translations this deployment already holds (spec BIBL-03). Only a
 * translation the library reports as cached is searched: an unavailable one is left out of the search
 * entirely rather than asked for, because asking for it is what would fetch it.
 *
 * A translation that cannot be searched refuses the whole search. Dropping it instead would answer with
 * fewer matches than the library holds and say nothing about it, which is the one failure a person
 * reading search results cannot see for themselves.
 */
export async function searchScripture(
  client: ReturnType<typeof corpusClient>,
  query: string,
): Promise<CorpusResult<readonly ScriptureMatch[]>> {
  // A query with no words to search for names nothing, so nothing is asked of the library at all.
  if (query.trim() === '') return { ok: true, value: [] };
  const held = await client.translations();
  if (!held.ok) return held;
  const locally = held.value.filter((translation) => translation.cached).map((entry) => entry.abbreviation).toSorted();
  const matches: ScriptureMatch[] = [];
  for (const abbr of locally) {
    const found = await client.search(abbr, query);
    if (!found.ok) return found;
    for (const hit of found.value.hits) {
      matches.push({
        reference: referenceOf(abbr, hit),
        text: hit.text,
        phrase: hit.phrase,
        occurrences: hit.occurrences,
        bookOrder: hit.bookOrder,
      });
    }
  }
  return { ok: true, value: Object.freeze(matches.sort(compareMatches)) };
}

export interface CorpusProbe {
  readonly reached: boolean;
  readonly closed: boolean;
  readonly detail: string;
}

/**
 * Asks a released route with no credential and expects to be refused. A corpus that answers is
 * exposed to anything that can reach it, which is a deployment fault this application will not run
 * through; a corpus that is not up yet is not a fault, because start-up order is not a guarantee.
 */
export async function probeCorpusIsClosed(settings: CorpusSettings, fetching: Fetching): Promise<CorpusProbe> {
  if (settings.url === '') return { reached: false, closed: false, detail: 'no library is configured' };
  const address = addressOf(settings.url);
  try {
    const answer = await fetching(`${address}${TRANSLATIONS_PATH}`, { headers: {} });
    if (answer.status === 401) return { reached: true, closed: true, detail: `${address} refused an unauthenticated request` };
    return {
      reached: true,
      closed: false,
      detail: `${address} answered an unauthenticated request with ${answer.status}; the internal API must require a credential`,
    };
  } catch {
    return { reached: false, closed: false, detail: `${address} could not be reached` };
  }
}

export function corpusProbeProblems(probe: CorpusProbe): readonly string[] {
  return probe.reached && !probe.closed ? [probe.detail] : [];
}
