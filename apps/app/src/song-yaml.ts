// The raw side of editing a song (SONG-01). A song is one configuration; this is the text an editor may
// type it in directly, and `songs.ts` is where either surface saves. The two surfaces are the same
// configuration seen twice, never two stores: every path in and out of this file goes through
// `parseSongBody`, so nothing can be said in YAML that the visual editor could not have said, and nothing
// can be typed there that would reach storage ungraded.
//
// Why YAML rather than JSON: what a person edits by hand here is mostly lyric text, and YAML's block
// scalars hold a verse's line breaks as line breaks. Why this file is in the application rather than in
// the contracts: the contracts are browser-safe and take no dependency a browser cannot have, and the
// YAML reader is the application's dependency. The contracts own what a song *is*; this owns one way of
// writing it down.
//
// The written form is `canonical()`'s — the same ordering the export bytes and the revision address are
// taken over, rather than a second ordering invented here. So a song that did not change is the same text
// every time it is opened, and re-reading text this file wrote yields the configuration it was written
// from, byte for byte.
//
// A refusal is located. Somebody who mistypes line 40 of a long song is told where line 40 is, and that is
// true of both ways the text can be wrong: YAML the parser cannot read at all, and YAML that parses into
// something that is not a song. The first comes from the parser's own position; the second is found by
// walking the field path the contracts reported back down the document that was just parsed.

import { canonical } from '@holydeck/contracts/canonical';
import { SONG_PATH, parseSongBody } from '@holydeck/contracts/songs';
import { LineCounter, isNode, parseDocument, stringify } from 'yaml';

import type { Problem } from '@holydeck/contracts/problems';
import type { SongBody } from '@holydeck/contracts/songs';
import type { Document } from 'yaml';

/** The code every problem carries that is about the text itself rather than about the song in it. */
export const YAML_SYNTAX = 'yaml.syntax';

/** Where in the text the problem is, counted the way an editor counts: from one. */
export interface TextPosition {
  readonly line: number;
  readonly column: number;
}

/**
 * A problem with a place in the raw text, where there is one to give. It is absent rather than guessed
 * when the text holds nothing to point at — an empty document, or a field whose absence is the problem
 * and whose parent is missing too.
 */
export interface LocatedProblem extends Problem {
  readonly at?: TextPosition;
}

export type ReadSong =
  | { readonly ok: true; readonly value: SongBody }
  | { readonly ok: false; readonly problems: readonly LocatedProblem[] };

/** Lyrics are never folded: a line break in a verse is the writer's, and a width limit would invent more. */
const WRITTEN = { lineWidth: 0 } as const;

/** The song as text somebody edits. */
export function songToYaml(body: SongBody): string {
  return stringify(canonical(body), WRITTEN);
}

/** `song.sections.0.text.1.languageKey` as the document path `['sections', 1 as the index, …]`. */
const segmentsOf = (path: string): readonly (string | number)[] => {
  const parts = path.split('.');
  const named = parts[0] === SONG_PATH ? parts.slice(1) : parts;
  return named.map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
};

/**
 * The node a field path names, or the nearest ancestor the document actually has. A required field that
 * is missing has no node of its own, and the honest place to point at is the mapping it is missing from.
 */
const nodeAt = (document: Document, segments: readonly (string | number)[]): unknown => {
  for (let depth = segments.length; depth > 0; depth -= 1) {
    const node: unknown = document.getIn(segments.slice(0, depth), true);
    if (isNode(node)) return node;
  }
  return document.contents;
};

const located = (lines: LineCounter, offset: number): TextPosition => {
  const { line, col } = lines.linePos(offset);
  return { line, column: col };
};

const positionOf = (node: unknown, lines: LineCounter): TextPosition | undefined => {
  const start = isNode(node) ? node.range?.[0] : undefined;
  return start === undefined ? undefined : located(lines, start);
};

/** Reads the text as a song, or every reason it is not one, each where it is. */
export function songFromYaml(text: string): ReadSong {
  // A fresh counter per call: a `LineCounter` accumulates the line starts of everything parsed through it,
  // and one shared between two documents would place the second document's problems in the first.
  const lines = new LineCounter();
  const document = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  if (document.errors.length > 0) {
    return {
      ok: false,
      problems: document.errors.map((error) => ({
        path: SONG_PATH,
        code: YAML_SYNTAX,
        message: error.message,
        at: located(lines, error.pos[0]),
      })),
    };
  }
  const value: unknown = document.toJS();
  const parsed = parseSongBody(value);
  if (parsed.ok) return parsed;
  return {
    ok: false,
    problems: parsed.problems.map((problem) => {
      const at = positionOf(nodeAt(document, segmentsOf(problem.path)), lines);
      return at === undefined ? problem : { ...problem, at };
    }),
  };
}
