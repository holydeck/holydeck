// The command palette (spec SRCH-01): one ranked search across every domain a person already has a
// reason to look something up in — canon-validated Scripture references, Bible text, songs, both slide
// sources, and services — through six stores this task adds no persistence to.
//
// Five sources, six stores, on purpose (T72 ruling 2): "slide" is two distinct stores kept apart by
// audience rather than merged into one — a reusable slide or a named slide group is discoverable
// through `library.ts` to everyone with a session, while a Slide Layout is `slide-layouts.ts`'s own
// store and is Admin's alone (`layouts.manage`). `services.ts` is reached directly; `services` is not
// a `LibraryKind` and is never reachable through `library.ts`.
//
// Authorization is read off the caller's real session permissions (`roles.ts`'s vocabulary), never off
// one of the internal `*Context()` helpers below — those hardcode every permission a store's own verbs
// might ever need and would make an unauthorized source unfailable to test. A source's gate decides
// whether its hit-builder even runs; the `*Context()` helpers are used only after that decision, to
// call the store itself.
//
// Ranking mirrors `corpus.ts`'s own `compareMatches`: a phrase match beats a scattered-words match,
// and more occurrences beat fewer. Across sources, a tie breaks on `PALETTE_SOURCES`'s own fixed order
// (`@holydeck/contracts/palette`) — named once there and reused here as the tiebreak, rather than
// stated twice.
//
// A missing source fails the whole search, mirroring `searchScripture`'s own precedent: `ranked()`
// below is the one place every source's failure is translated into `PaletteError`, so a caller of
// `search` either gets every source's hits or none of them, never a partial answer with no way to know
// what went missing.

import { PALETTE_SOURCES } from '@holydeck/contracts/palette';
import { formatVerseList, parseReference } from '@holydeck/core/references';
import { foldSearchText, NOT_A_WORD, phraseCount, scatteredCount } from '@holydeck/core/search-text';

import { REFERENCE_NOT_FOUND, searchScripture, selectReference } from './corpus.js';
import { libraryContext, libraryOn } from './library.js';
import { LAYOUTS_MANAGE, PRESENTATION_CONTROL } from './roles.js';
import { serviceContext, servicesOn } from './services.js';
import { slideLayoutContext, slideLayoutsOn } from './slide-layouts.js';
import { songContext, songsOn } from './songs.js';

import type { PaletteHit, PaletteSource } from '@holydeck/contracts/palette';

import type { Reference } from '@holydeck/core/references';

import type { corpusClient, ReferenceSelection } from './corpus.js';
import type { LibraryStore } from './library.js';
import type { RepositoryDb } from './repositories.js';

/** The one session shape the palette authorizes against — the operator-facing permission vocabulary a
 *  session is granted at sign-in (`roles.ts`), not `RequestContext`'s own store-permission strings. */
export interface PaletteSession {
  readonly actor: string;
  readonly permissions: readonly string[];
  readonly correlationId: string;
}

/** Every refusal this store raises carries which of the six sources caused it, so a caller of `search`
 *  can say what went missing rather than only that something did. */
export class PaletteError extends Error {
  readonly source: PaletteSource;

  constructor(source: PaletteSource, message: string) {
    super(message);
    this.name = 'PaletteError';
    this.source = source;
  }
}

export interface PaletteStore {
  search(session: PaletteSession, query: string): Promise<readonly PaletteHit[]>;
}

export interface PaletteOptions {
  /** The only way this store reaches Scripture, handed in exactly as `corpus.ts` builds it. */
  readonly corpus: ReturnType<typeof corpusClient>;
  /** Which translation a free-text reference (e.g. "John 3:16") is validated and resolved against.
   *  Distinct from `searchScripture`'s own loop over every locally cached translation: a reference is
   *  one passage, not a text search, so it needs exactly one translation to open against. */
  readonly referenceTranslation: string;
  readonly now: () => string;
  readonly newId?: () => string;
}

const wordsOf = (text: string): readonly string[] =>
  foldSearchText(text)
    .split(NOT_A_WORD)
    .filter((word) => word !== '');

interface TextMatch {
  readonly phrase: boolean;
  readonly occurrences: number;
}

/** The same phrase-vs-scattered shape `packages/core/src/search.ts` already matches Scripture text
 *  with, folded through `foldSearchText` so a Tamil-script or Romanized-Tamil query matches text
 *  stored in that same variant regardless of Unicode representation (T72 ruling 5). */
function matchOf(text: string, query: readonly string[]): TextMatch | undefined {
  const words = wordsOf(text);
  const together = phraseCount(words, query);
  if (together > 0) return { phrase: true, occurrences: together };
  const scattered = scatteredCount(words, query);
  return scattered === 0 ? undefined : { phrase: false, occurrences: scattered };
}

interface SearchableField {
  readonly label: string;
  readonly text: string;
}

/** `candidate` outranks `current` by the same precedence `compareHits` uses across whole hits: a
 *  phrase always beats scattered words, then more occurrences beat fewer. */
function isStronger(candidate: TextMatch, current: TextMatch): boolean {
  if (candidate.phrase !== current.phrase) return candidate.phrase;
  return candidate.occurrences > current.occurrences;
}

/** The strongest match across every candidate field, not merely the first one that matches at
 *  all — a later, lower-priority field's phrase match must still outrank an earlier field's
 *  scattered one, or ruling 4's "phrase beats scattered" would silently stop holding within a
 *  single item. A genuine tie (equal phrase-ness and occurrence count) keeps the earliest field
 *  in the caller's priority order, so the explanation still names one concrete field. */
function bestFieldMatch(
  query: readonly string[],
  fields: readonly SearchableField[],
): { readonly match: TextMatch; readonly explanation: string } | undefined {
  let best: { readonly match: TextMatch; readonly explanation: string } | undefined;
  for (const field of fields) {
    const match = matchOf(field.text, query);
    if (match === undefined) continue;
    if (best !== undefined && !isStronger(match, best.match)) continue;
    const explanation = match.phrase ? `matched the phrase in ${field.label}` : `matched words in ${field.label}`;
    best = { match, explanation };
  }
  return best;
}

/** Every source's failure, translated uniformly into one refusal naming which source raised it — the
 *  single mechanism that makes a missing source fail the whole search (T72 ruling 6). */
async function ranked(
  source: PaletteSource,
  work: () => Promise<readonly PaletteHit[]>,
): Promise<readonly PaletteHit[]> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PaletteError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PaletteError(source, `${source} could not be searched: ${message}`);
  }
}

const referenceId = (
  abbr: string,
  reference: { readonly book: string; readonly chapter: number; readonly verses: readonly number[] },
): string => `${abbr}:${reference.book}:${reference.chapter}:${reference.verses.join(',')}`;

/** A query that reads as a Scripture reference (e.g. "John 3:16"), resolved and canon-checked directly
 *  rather than word-searched. A query that does not parse as a reference contributes no hit at all —
 *  this is not a failure, just a query this source has nothing to say about. A parsed reference the
 *  canon does not hold (`REFERENCE_NOT_FOUND`) is the same: no hit, not a refusal. Any other refusal —
 *  the corpus itself being unreachable or misconfigured — is a real source failure and is thrown. */
async function referenceHits(
  corpus: ReturnType<typeof corpusClient>,
  abbr: string,
  query: string,
): Promise<readonly PaletteHit[]> {
  let reference: Reference;
  try {
    reference = parseReference(query);
  } catch {
    return [];
  }
  const selection: ReferenceSelection = { abbr, book: reference.book, chapter: reference.chapter, verses: reference.verses };
  const answer = await selectReference(corpus, selection);
  if (!answer.ok) {
    if (answer.refusal.code === REFERENCE_NOT_FOUND.code) return [];
    throw new PaletteError('reference', answer.refusal.message);
  }
  const text = reference.verses.map((verse) => answer.value.verses[String(verse)] ?? '').join(' ').trim();
  return [
    {
      source: 'reference',
      id: referenceId(abbr, reference),
      title: `${reference.book} ${reference.chapter}:${formatVerseList(reference.verses)}`,
      explanation: 'matched as a Scripture reference',
      phrase: true,
      occurrences: 1,
      abbr,
      book: reference.book,
      chapter: reference.chapter,
      verses: reference.verses,
      text,
    },
  ];
}

/** Word and phrase search over Bible text the deployment already caches, across every held
 *  translation — `corpus.ts`'s own `searchScripture`, restated as palette hits. */
async function scriptureHits(corpus: ReturnType<typeof corpusClient>, query: string): Promise<readonly PaletteHit[]> {
  const matches = await searchScripture(corpus, query);
  if (!matches.ok) throw new PaletteError('scripture', matches.refusal.message);
  return matches.value.map((match) => ({
    source: 'scripture',
    id: referenceId(match.reference.abbr, match.reference),
    title: `${match.reference.book} ${match.reference.chapter}:${formatVerseList([...match.reference.verses])}`,
    explanation: match.phrase ? 'matched the phrase in the verse text' : 'matched words in the verse text',
    phrase: match.phrase,
    occurrences: match.occurrences,
    abbr: match.reference.abbr,
    book: match.reference.book,
    chapter: match.reference.chapter,
    verses: match.reference.verses,
    text: match.text,
  }));
}

/** Every song, matched on its Tamil title, its romanized title, and its lyric section text, in that
 *  order (T72 ruling 2). Reached through `library.list` for discoverability and `songs.current` for
 *  the body, since a song's searchable text lives on the body alone. */
async function songHits(
  library: LibraryStore,
  libraryCtx: unknown,
  songs: ReturnType<typeof songsOn>,
  songCtx: unknown,
  words: readonly string[],
): Promise<readonly PaletteHit[]> {
  const items = await library.list(libraryCtx, { kind: 'song' });
  const hits: PaletteHit[] = [];
  for (const item of items) {
    const current = await songs.current(songCtx, item.stamp.id);
    if (current === undefined) continue;
    const fields: SearchableField[] = [
      { label: 'the Tamil title', text: current.body.titles.tamil },
      { label: 'the romanized title', text: current.body.titles.romanized },
      ...current.body.sections.flatMap((section) =>
        section.text.map((entry) => ({ label: `the ${section.label} lyrics`, text: entry.text })),
      ),
    ];
    const found = bestFieldMatch(words, fields);
    if (found === undefined) continue;
    hits.push({
      source: 'song',
      id: item.stamp.id,
      title: current.title,
      explanation: found.explanation,
      phrase: found.match.phrase,
      occurrences: found.match.occurrences,
      songId: item.stamp.id,
    });
  }
  return hits;
}

const LIBRARY_SLIDE_KINDS = ['reusableSlide', 'slideGroup'] as const;

/** A reusable slide or a named slide group, matched on its library title alone — the only searchable
 *  field `library.list` itself gives without an unbounded per-item revision read (a disclosed scope
 *  narrowing: ruling 2 names no body field to search here, unlike songs' explicit lyric text). */
async function slideHits(library: LibraryStore, libraryCtx: unknown, words: readonly string[]): Promise<readonly PaletteHit[]> {
  const hits: PaletteHit[] = [];
  for (const kind of LIBRARY_SLIDE_KINDS) {
    const items = await library.list(libraryCtx, { kind });
    for (const item of items) {
      const found = bestFieldMatch(words, [{ label: 'the title', text: item.title }]);
      if (found === undefined) continue;
      hits.push({
        source: 'slide',
        id: item.stamp.id,
        title: item.title,
        explanation: found.explanation,
        phrase: found.match.phrase,
        occurrences: found.match.occurrences,
        contentId: item.stamp.id,
        kind,
      });
    }
  }
  return hits;
}

/** Admin's Slide Layouts, matched on their name alone. The palette's one gated source (T72 ruling 3) —
 *  the caller only ever reaches this when `search` has already checked `layouts.manage`. */
async function slideLayoutHits(
  layouts: ReturnType<typeof slideLayoutsOn>,
  layoutCtx: unknown,
  words: readonly string[],
): Promise<readonly PaletteHit[]> {
  const items = await layouts.list(layoutCtx);
  const hits: PaletteHit[] = [];
  for (const item of items) {
    const found = bestFieldMatch(words, [{ label: 'the name', text: item.name }]);
    if (found === undefined) continue;
    hits.push({
      source: 'slideLayout',
      id: item.stamp.id,
      title: item.name,
      explanation: found.explanation,
      phrase: found.match.phrase,
      occurrences: found.match.occurrences,
      layoutId: item.stamp.id,
    });
  }
  return hits;
}

/** Every Service, matched on its title, then its date, then its site (T72 ruling 2). */
async function serviceHits(
  services: ReturnType<typeof servicesOn>,
  serviceCtx: unknown,
  words: readonly string[],
): Promise<readonly PaletteHit[]> {
  const items = await services.list(serviceCtx);
  const hits: PaletteHit[] = [];
  for (const item of items) {
    const found = bestFieldMatch(words, [
      { label: 'the title', text: item.title },
      { label: 'the date', text: item.date },
      { label: 'the site', text: item.site },
    ]);
    if (found === undefined) continue;
    hits.push({
      source: 'service',
      id: item.stamp.id,
      title: item.title,
      explanation: found.explanation,
      phrase: found.match.phrase,
      occurrences: found.match.occurrences,
      serviceId: item.stamp.id,
      date: item.date,
      site: item.site,
    });
  }
  return hits;
}

/** Relevance first, exactly as `corpus.ts`'s own `compareMatches` orders hits within one translation —
 *  a phrase above scattered words, and more occurrences above fewer — and only then `PALETTE_SOURCES`'s
 *  own fixed order, so the same query against the same data always returns the same sequence. */
function compareHits(left: PaletteHit, right: PaletteHit): number {
  if (left.phrase !== right.phrase) return left.phrase ? -1 : 1;
  if (left.occurrences !== right.occurrences) return right.occurrences - left.occurrences;
  const leftOrder = PALETTE_SOURCES.indexOf(left.source);
  const rightOrder = PALETTE_SOURCES.indexOf(right.source);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

export function paletteOn(db: RepositoryDb, options: PaletteOptions): PaletteStore {
  const storeOptions = { now: options.now, newId: options.newId };
  const library = libraryOn(db, storeOptions);
  const songs = songsOn(db, storeOptions);
  const slideLayouts = slideLayoutsOn(db, storeOptions);
  const services = servicesOn(db, storeOptions);

  return {
    search: async (session, query) => {
      const words = wordsOf(query);
      const libraryCtx = libraryContext(session.actor, session.correlationId);
      const tasks: Promise<readonly PaletteHit[]>[] = [];

      if (session.permissions.includes(PRESENTATION_CONTROL)) {
        tasks.push(ranked('reference', () => referenceHits(options.corpus, options.referenceTranslation, query)));
        tasks.push(ranked('scripture', () => scriptureHits(options.corpus, query)));
      }

      tasks.push(
        ranked('song', () => songHits(library, libraryCtx, songs, songContext(session.actor, session.correlationId), words)),
      );
      tasks.push(ranked('slide', () => slideHits(library, libraryCtx, words)));

      if (session.permissions.includes(LAYOUTS_MANAGE)) {
        tasks.push(
          ranked('slideLayout', () =>
            slideLayoutHits(slideLayouts, slideLayoutContext(session.actor, session.correlationId), words),
          ),
        );
      }

      tasks.push(
        ranked('service', () => serviceHits(services, serviceContext(session.actor, session.correlationId), words)),
      );

      const results = await Promise.all(tasks);
      return Object.freeze(results.flat().sort(compareHits));
    },
  };
}
