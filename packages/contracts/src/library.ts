// What a new item in the durable global content library carries before it exists (spec CONT-01).
// Deliberately body-less: a Reading, Sermon, Slide group, or Reusable slide's actual content — what
// it says, what slides it holds — is a later requirement's shape (LANG-01, SLID-01, SONG-01, and the
// sermon pipeline). This module only says which of those kinds an item is, and what it is called.

import { type EntityKind } from './entities.js';
import { FIELD_CODES, isRecord, type Parsed, type Problem, type ParseFn, parseObject } from './problems.js';

export const LIBRARY_PATH = '/api/v1/library';

/** The subset of `EntityKind` CONT-01 names as reusable content, in `ENTITY_KINDS`'s own order. */
export const LIBRARY_KINDS = [
  'reading',
  'reusableSlide',
  'sermon',
  'slideGroup',
  'song',
] as const satisfies readonly EntityKind[];

export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export type LibraryDraft = {
  readonly kind: LibraryKind;
  readonly title: string;
};

export const parseLibraryDraft: ParseFn<LibraryDraft> = (value, path) =>
  parseObject(value, path, (reader) => ({
    kind: reader.choice('kind', LIBRARY_KINDS),
    title: reader.text('title'),
  }));

export type LibraryFilter = {
  readonly kind?: LibraryKind;
  readonly q?: string;
  readonly archived?: boolean;
};

/**
 * Reads `?kind=&q=&archived=` off a query string rather than a JSON body: every value arrives as
 * text or is simply absent, never as the boolean/array a JSON body would carry, so this reads the
 * three fields by hand instead of through FieldReader, in the same Problem/FIELD_CODES vocabulary
 * every parser in this package answers with.
 */
export function parseLibraryFilter(query: unknown, path = 'library'): Parsed<LibraryFilter> {
  const source = isRecord(query) ? query : {};
  const problems: Problem[] = [];
  const rawKind = source['kind'];
  let kind: LibraryKind | undefined;
  if (typeof rawKind === 'string' && rawKind !== '') {
    if (!LIBRARY_KINDS.includes(rawKind as LibraryKind)) {
      problems.push({
        path: `${path}.kind`,
        code: FIELD_CODES.notAllowed,
        message: `must be one of ${LIBRARY_KINDS.join(', ')}`,
      });
    } else {
      kind = rawKind as LibraryKind;
    }
  }
  const rawQ = source['q'];
  const q = typeof rawQ === 'string' && rawQ !== '' ? rawQ : undefined;
  const archived = source['archived'] === 'true';
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { ...(kind === undefined ? {} : { kind }), ...(q === undefined ? {} : { q }), archived } };
}
