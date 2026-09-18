import { bundledCanon } from './canon.js';
import { latestRevision } from './storage.js';
import type { TranslationStoreFile } from './storage.js';

/**
 * Word and phrase search over the text a translation has already been synced with, and over nothing
 * else. It is written here, against the store file itself, because search that had to retrieve what it
 * searches would fetch the very passages a search is not allowed to fetch: what is in the store is what
 * is locally available, and a verse nobody has synced is a verse no search can answer with.
 *
 * Pure and synchronous. Nothing here reads a network, a clock or a file; the same store file and the
 * same query answer with the same hits, in the same order, every time.
 */

export interface ScriptureHit {
  /** The USFM name the book is stored under, such as GEN. */
  readonly book: string;
  /** Where the book falls in the canon, so hits from two translations can be ordered against each other. */
  readonly bookOrder: number;
  readonly chapter: number;
  readonly verse: number;
  readonly text: string;
  /** The chapter revision the text was read at, so the passage can be opened at what was searched. */
  readonly revision: number;
  /** Whether the query's words were found together, in order, rather than scattered through the verse. */
  readonly phrase: boolean;
  readonly occurrences: number;
}

/** Where each book of the canon this build bundles falls, which is the order any two hits are read in. */
const BOOK_ORDER = new Map(bundledCanon().books.map((book, index) => [book.usfm, index]));

/** A book no bundled canon names sorts after every book one does, and by its own name among its like. */
const UNNAMED_BOOK_ORDER = BOOK_ORDER.size;

const NOT_A_WORD = /[^\p{L}\p{N}]+/u;

/** The words a line of scripture is searched as: lower case, and with the punctuation between them gone. */
function wordsOf(text: string): readonly string[] {
  return text.toLowerCase().split(NOT_A_WORD).filter((word) => word !== '');
}

/** A whole number a reference can name, or nothing for a key that names no chapter or verse at all. */
function referenceNumber(key: string): number | undefined {
  return /^\d+$/u.test(key) ? Number(key) : undefined;
}

/** How many times the query's words appear together, in the order they were written. */
function phraseCount(words: readonly string[], query: readonly string[]): number {
  let count = 0;
  for (let start = 0; start + query.length <= words.length; start += 1) {
    if (query.every((word, index) => words[start + index] === word)) count += 1;
  }
  return count;
}

/** How often the query's words appear anywhere in the verse, or none at all when one of them is missing. */
function scatteredCount(words: readonly string[], query: readonly string[]): number {
  let total = 0;
  for (const word of new Set(query)) {
    const found = words.filter((candidate) => candidate === word).length;
    if (found === 0) return 0;
    total += found;
  }
  return total;
}

function matchOf(text: string, query: readonly string[]): { phrase: boolean; occurrences: number } | undefined {
  const words = wordsOf(text);
  const together = phraseCount(words, query);
  if (together > 0) return { phrase: true, occurrences: together };
  const scattered = scatteredCount(words, query);
  return scattered === 0 ? undefined : { phrase: false, occurrences: scattered };
}

/**
 * Relevance first — the phrase itself above the same words scattered, and more of them above fewer — and
 * then the canon, which is what makes the order the same however the store happened to be written.
 */
function compareHits(left: ScriptureHit, right: ScriptureHit): number {
  if (left.phrase !== right.phrase) return left.phrase ? -1 : 1;
  if (left.occurrences !== right.occurrences) return right.occurrences - left.occurrences;
  if (left.bookOrder !== right.bookOrder) return left.bookOrder - right.bookOrder;
  if (left.book !== right.book) return left.book < right.book ? -1 : 1;
  if (left.chapter !== right.chapter) return left.chapter - right.chapter;
  return left.verse - right.verse;
}

/**
 * Every verse of a translation's stored text that answers the query, most relevant first. A chapter or
 * verse whose key names no reference is passed over rather than returned: a hit nothing could be opened
 * at is not a hit anybody can use.
 */
export function searchTranslation(file: TranslationStoreFile, query: string): readonly ScriptureHit[] {
  const words = wordsOf(query);
  if (words.length === 0) return [];
  const hits: ScriptureHit[] = [];
  for (const [book, record] of Object.entries(file.books)) {
    const bookOrder = BOOK_ORDER.get(book.toUpperCase()) ?? UNNAMED_BOOK_ORDER;
    for (const [key, chapterRecord] of Object.entries(record.chapters)) {
      const chapter = referenceNumber(key);
      const revision = latestRevision(chapterRecord);
      if (chapter === undefined || revision === undefined) continue;
      for (const [verseKey, text] of Object.entries(revision.verses)) {
        const verse = referenceNumber(verseKey);
        const match = verse === undefined ? undefined : matchOf(text, words);
        if (verse === undefined || match === undefined) continue;
        hits.push({ book, bookOrder, chapter, verse, text, revision: revision.rev, ...match });
      }
    }
  }
  return hits.sort(compareHits);
}
