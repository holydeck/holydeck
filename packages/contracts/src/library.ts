// What a new item in the durable global content library carries before it exists (spec CONT-01).
// Deliberately body-less: a Reading, Sermon, Slide group, or Reusable slide's actual content — what
// it says, what slides it holds — is a later requirement's shape (LANG-01, SLID-01, SONG-01, and the
// sermon pipeline). This module only says which of those kinds an item is, and what it is called.

import { type EntityKind } from './entities.js';
import { type ParseFn, parseObject } from './problems.js';

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
