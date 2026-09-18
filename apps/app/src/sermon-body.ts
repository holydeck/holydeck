// A sermon's canonical configuration (spec SERM-04): the SermonFile core already parses, plus each
// content language's title, speaker and points. `sermons.ts` composes this with the library and revision
// stores to make it a versioned entity; `sermon-yaml.ts` is the raw text a sermon is edited as. Both
// surfaces are graded by `parseSermonBody` alone, so neither can reach storage un-validated and neither
// can say something the other could not have said.
//
// This lives beside `sermons.ts` rather than inside it, and is the one thing both `sermons.ts` and
// `sermon-yaml.ts` import from, rather than either importing from the other: `sermon-yaml.ts` needs the
// schema to grade raw text before `sermons.ts` ever sees it, and `sermons.ts` needs `sermon-yaml.ts`'s
// `sermonToYaml`/`sermonFromYaml` for its own raw-editing verbs. Two files that each needed something only
// the other had would be a cycle; this is the shared ground both stand on instead — the same role
// `@holydeck/contracts/songs`' `parseSongBody` plays for `songs.ts` and `song-yaml.ts`, moved one layer
// down because a `SermonFile` is `@holydeck/core`'s, not the browser-safe contracts' to know about.
//
// `parseSermonBody` reports the first problem it finds, not every one there is: the `SermonFile` reader
// it composes already stops at its first complaint, so collecting further fields past that point would be
// false precision this schema cannot back up.

import { isContentLanguageKey } from '@holydeck/contracts/content-languages';
import { FIELD_CODES, isRecord } from '@holydeck/contracts/problems';
import { parseSermonFile } from '@holydeck/core/sermon';

import type { Parsed, Problem } from '@holydeck/contracts/problems';
import type { SermonFile } from '@holydeck/core/sermon';

/** Where every problem in a sermon body is reported under, and the root a raw editor locates against. */
export const SERMON_PATH = 'sermon';

export type SermonLanguage = {
  readonly translation: string;
  readonly title: string;
  readonly speaker?: string;
  /** When supplied, one point per SermonFile entry, in the same order. */
  readonly points?: readonly string[];
};

export type SermonBody = {
  readonly sermon: SermonFile;
  /** Content-language keys map explicitly to translations; they are not translation abbreviations. */
  readonly languages: Readonly<Record<string, SermonLanguage>>;
};

export const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const LANGUAGE_INVALID = 'sermon.language_invalid';

const SERMON_FILE_INVALID = 'sermon.invalid';

/** Signals a rejection up to `parseSermonBody`'s one catch, carrying the problem rather than a message. */
class SermonBodyProblem extends Error {
  constructor(readonly problem: Problem) {
    super(problem.message);
  }
}

/**
 * The field path a lower-level `SermonFile` parser error names, lifted out of its own prose and rewritten
 * onto this body's shape (`verses` is `entries` here). Falls back to the `SermonFile` mapping itself when
 * the message names nothing quotable — still a location, just a less specific one.
 */
function fileFieldPath(reason: string): string {
  const match = /"([^"]+)"/u.exec(reason);
  if (match === null) return `${SERMON_PATH}.sermon`;
  const field = match[1]!.replace(/\[(\d+)\]/gu, '.$1').replace(/^verses\b/u, 'entries');
  return `${SERMON_PATH}.sermon.${field}`;
}

/** The configuration a caller handed in, graded before it is stored — the first problem it has, if any. */
export function parseSermonBody(value: unknown): Parsed<SermonBody> {
  const reject = (path: string, code: string, message: string): never => {
    throw new SermonBodyProblem({ path, code, message });
  };
  try {
    if (!isRecord(value) || !isRecord(value['sermon']) || !isRecord(value['languages'])) {
      return reject(SERMON_PATH, FIELD_CODES.notAnObject, 'a sermon configuration needs a SermonFile and language content');
    }
    const file = value['sermon'];
    const entries = file['entries'];
    const notices = file['notices'];
    if (!Array.isArray(entries) || !Array.isArray(notices) || !notices.every((notice) => typeof notice === 'string')) {
      return reject(`${SERMON_PATH}.sermon`, FIELD_CODES.notAList, 'a SermonFile needs entries and string notices');
    }
    // Reuse the parser's book, verse, translation and offset rules for its structured output too.
    const verses = entries.map((entry: unknown, index: number) => {
      if (!isRecord(entry) || !Array.isArray(entry['verses']) ||
          !entry['verses'].every((verse: unknown) => typeof verse === 'number' && Number.isInteger(verse)) ||
          !isRecord(entry['offsets'])) {
        return reject(`${SERMON_PATH}.sermon.entries.${index}`, FIELD_CODES.notAnObject,
          'each SermonFile entry needs numeric verses and translation offsets');
      }
      return { ...entry, verses: entry['verses'].join(',') };
    });
    let sermon: SermonFile;
    try {
      sermon = parseSermonFile(JSON.stringify({ translations: file['translations'], template: file['template'], verses }));
    } catch (error) {
      return reject(fileFieldPath(String(error)), SERMON_FILE_INVALID, `invalid SermonFile: ${String(error)}`);
    }
    sermon.notices = [...notices];
    const languages: Record<string, SermonLanguage> = {};
    for (const [key, content] of Object.entries(value['languages'])) {
      if (!isContentLanguageKey(key) || !isRecord(content) || !nonempty(content['title']) ||
          typeof content['translation'] !== 'string' || !sermon.translations.includes(content['translation'])) {
        return reject(`${SERMON_PATH}.languages.${key}`, LANGUAGE_INVALID,
          `${key} needs a registered language, title and a translation selected by the sermon`);
      }
      const speaker = content['speaker'];
      const points = content['points'];
      if (speaker !== undefined && !nonempty(speaker)) {
        return reject(`${SERMON_PATH}.languages.${key}.speaker`, FIELD_CODES.notText, `${key}.speaker must be nonempty text`);
      }
      if (points !== undefined && (!Array.isArray(points) || points.length !== sermon.entries.length || !points.every(nonempty))) {
        return reject(`${SERMON_PATH}.languages.${key}.points`, FIELD_CODES.notAList,
          `${key}.points must contain one nonempty point per sermon entry`);
      }
      languages[key] = {
        title: content['title'], translation: content['translation'],
        ...(speaker === undefined ? {} : { speaker }), ...(points === undefined ? {} : { points }),
      };
    }
    if (Object.keys(languages).length === 0) {
      return reject(`${SERMON_PATH}.languages`, FIELD_CODES.empty, 'a sermon configuration needs at least one content language');
    }
    return { ok: true, value: { sermon, languages } };
  } catch (error) {
    if (error instanceof SermonBodyProblem) return { ok: false, problems: [error.problem] };
    throw error;
  }
}
