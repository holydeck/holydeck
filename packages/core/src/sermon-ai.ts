// Turning the pastor's weekly message into a sermon file, deterministically and offline.
//
// The message arrives as free text — a title line, then one "<book> <chapter>:<verses>" line per
// passage — and everything here reads it with the code this package already has: `resolveBook` for the
// book name in any language it knows, `parseVerseList`/`formatVerseList` for the verse text, and
// `parseSermonFile` as the final check that what was generated is a file this build would accept.
//
// Two rules shape the whole module. Nothing reaches the network or the filesystem: the returned
// `GeneratedSermon` is the preview, and writing it is the caller's decision, made after seeing it. And
// nothing parsed is discarded: a passage whose book name this build cannot place is left out of the
// file and reported in `notices` with the line it came from, so the pastor can add it by hand rather
// than discovering later that a verse went missing.

import { stringify } from 'yaml';
import { resolveBook } from './canon.js';
import { HolyDeckError, formatMessage } from './messages.js';
import { formatVerseList, parseVerseList } from './references.js';
import { parseSermonFile } from './sermon.js';

/** One passage line as the message wrote it, before any book name is resolved. */
export interface ParsedPastorLine {
  rawBook: string;
  chapter: number;
  /** The verse text kept as the pastor grouped it: "13", "4-7", "34,35" — tidied, never regrouped. */
  verseListRaw: string;
}

export interface ParsedPastorMessage {
  title?: string;
  lines: ParsedPastorLine[];
}

export interface BuiltSermon {
  yaml: string;
  notices: string[];
}

export interface GenerateSermonOptions {
  translations: string[];
  now: Date;
}

export interface GeneratedSermon {
  filename: string;
  title?: string;
  yaml: string;
  notices: string[];
}

/** A dash or bullet in front of a passage; no book name starts with one, so it is always decoration. */
const LIST_MARKER = /^[-*•·]\s*/u;

/** Sentence punctuation trailing the verse list, which the verse parser would otherwise refuse. */
const TRAILING_PUNCTUATION = /[.,;:]+$/u;

/**
 * The lead-in in front of a title: "Today's Sermon. GOD BREAK THE YOKE", "Sermon: The Good Shepherd".
 * Greedy, so the last separator wins — a label ends at the last one, and a title carrying a period of
 * its own keeps it, since a separator counts only with text after it.
 */
const TITLE_LEAD_IN = /^.*[.:]\s+(?=\S)/su;

/** Long enough for a real title, short enough that a filename stays a filename. */
const SLUG_LIMIT = 60;

/** Accents on a Latin letter, dropped so "Güte" and "Gute" slug alike; other scripts keep their marks. */
const LATIN_ACCENTS = /(?<=\p{Script=Latin})\p{M}+/gu;

/** Anything a filename is better off without, which is everything that is not a letter or a digit. */
const NOT_SLUGGABLE = /[^\p{L}\p{N}]+/gu;

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Reads the raw message into a title and its passages, in the order they were written, duplicates and
 * all. A line that does not read as "<book> <chapter>:<verses>" is prose: the first one with a letter
 * in it becomes the title, the rest are ignored. Nothing here resolves a book name — the token is kept
 * exactly as written so an unresolvable one can still be reported with the line it came from.
 */
export function parsePastorMessage(text: string): ParsedPastorMessage {
  const lines: ParsedPastorLine[] = [];
  let title: string | undefined;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const passage = parsePassageLine(trimmed);
    if (passage !== undefined) {
      lines.push(passage);
    } else if (title === undefined && /\p{L}/u.test(trimmed)) {
      title = titleFrom(trimmed);
    }
  }
  if (lines.length === 0) {
    throw new HolyDeckError('ai_parse_failed', {
      reason: 'no line in it reads as "<book> <chapter>:<verses>"',
    });
  }
  return title === undefined ? { lines } : { title, lines };
}

function parsePassageLine(line: string): ParsedPastorLine | undefined {
  const cleaned = line.replace(LIST_MARKER, '').trim();
  const colon = cleaned.indexOf(':');
  if (colon === -1) return undefined;
  // Walk back over the chapter digits instead of matching the book name with a pattern: a name is free
  // text, and "<anything> <digits>" backtracks badly on a long run of spaces. Same reading as
  // `parseReference`, so both agree on where a book name ends.
  const head = cleaned.slice(0, colon);
  let digits = head.length;
  while (digits > 0 && head[digits - 1]! >= '0' && head[digits - 1]! <= '9') digits -= 1;
  const chapterText = head.slice(digits);
  const rawBook = head.slice(0, digits).trimEnd();
  if (chapterText === '' || rawBook === '' || digits === rawBook.length) return undefined;
  const chapter = Number(chapterText);
  if (chapter < 1 || chapter > 150) return undefined;
  const verseListRaw = normalizeVerseList(cleaned.slice(colon + 1));
  return verseListRaw === undefined ? undefined : { rawBook, chapter, verseListRaw };
}

/**
 * Tidies each comma-separated part on its own — " 4 - 7 " becomes "4-7", "07" becomes "7" — and joins
 * them back with the pastor's own commas. Formatting the whole list at once would regroup it: "34,35"
 * is one ascending run and would come back as "34-35", which is the same verses written as something
 * the pastor did not write.
 */
function normalizeVerseList(text: string): string | undefined {
  const trimmed = text.replace(TRAILING_PUNCTUATION, '').trim();
  if (trimmed === '') return undefined;
  const parts: string[] = [];
  for (const part of trimmed.split(',')) {
    try {
      parts.push(formatVerseList(parseVerseList(part)));
    } catch {
      return undefined;
    }
  }
  return parts.join(',');
}

function titleFrom(line: string): string {
  const leadIn = TITLE_LEAD_IN.exec(line);
  return (leadIn === null ? line : line.slice(leadIn[0].length)).trim();
}

/** The Sunday the sermon is for, as YYYY-MM-DD: the coming one, or today when today is already it. */
export function upcomingSunday(now: Date): string {
  const days = (7 - now.getUTCDay()) % 7;
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnight + days * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The title as a filename fragment: lower case, accents folded, everything that is not a letter or a
 * digit turned into a single dash. A title made of nothing else slugs to an empty string, which the
 * filename then leaves out altogether.
 */
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(LATIN_ACCENTS, '')
    .normalize('NFC')
    .replace(NOT_SLUGGABLE, '-')
    .replace(/^-+|-+$/gu, '');
  return slug.length <= SLUG_LIMIT ? slug : slug.slice(0, SLUG_LIMIT).replace(/-+[^-]*$/u, '');
}

/**
 * The file to write the sermon to: the coming Sunday, then the title if there is one to slug. Because
 * the slug holds only letters, digits and dashes, no title can steer the name out of its directory.
 */
export function resolveSermonFilename(title: string | undefined, now: Date): string {
  const date = upcomingSunday(now);
  const slug = title === undefined ? '' : slugifyTitle(title);
  return slug === '' ? `${date}.yml` : `${date}-${slug}.yml`;
}

/**
 * Assembles the sermon file: every passage this build can place, in message order, with its verse text
 * as a compact string rather than an exploded list. A passage whose book name cannot be placed is left
 * out and reported instead, so the work of parsing it survives as something the pastor can act on. The
 * result is re-read through `parseSermonFile` before it is returned: a file this build would refuse is
 * never handed back as one to write.
 */
export function buildSermonYaml(message: ParsedPastorMessage, translations: string[]): BuiltSermon {
  const verses: { book: string; chapter: number; verses: string }[] = [];
  const notices: string[] = [];
  for (const line of message.lines) {
    const book = resolveBook(line.rawBook);
    if (book === undefined) {
      notices.push(
        formatMessage('sermon_book_unresolved', {
          line: `${line.rawBook} ${line.chapter}:${line.verseListRaw}`,
        }),
      );
      continue;
    }
    verses.push({ book, chapter: line.chapter, verses: line.verseListRaw });
  }
  if (verses.length === 0) {
    throw new HolyDeckError('ai_parse_failed', {
      reason: `none of the ${message.lines.length} passage(s) in it names a book this build knows`,
    });
  }
  const yaml = stringify({ translations, verses }, { lineWidth: 0 });
  parseSermonFile(yaml);
  return { yaml, notices };
}

/**
 * The whole pipeline, and the one function a command or a server calls. It reaches for nothing outside
 * this package: no network, no filesystem. What comes back is the preview — the file that would be
 * written, its name, and anything the reader needs to know before deciding to write it.
 */
export async function generateSermonFromText(
  rawText: string,
  options: GenerateSermonOptions,
): Promise<GeneratedSermon> {
  const message = parsePastorMessage(rawText);
  const built = buildSermonYaml(message, options.translations);
  const filename = resolveSermonFilename(message.title, options.now);
  return message.title === undefined
    ? { filename, yaml: built.yaml, notices: built.notices }
    : { filename, title: message.title, yaml: built.yaml, notices: built.notices };
}
