// The raw side of editing a sermon (SERM-04). A sermon is one configuration; this is the text an editor
// may type it in directly, and `sermons.ts` is where either surface saves. The two surfaces are the same
// configuration seen twice, never two stores: every path in and out of this file goes through
// `parseSermonBody`, so nothing can be said in YAML that the visual editor could not have said, and
// nothing can be typed there that would reach storage ungraded. This mirrors `song-yaml.ts` field for
// field, the one earlier task (T51) this task's brief names as the shape to match.
//
// A refusal is located. Somebody who mistypes one verse of a long sermon is told where it is, and that is
// true of both ways the text can be wrong: YAML the parser cannot read at all, and YAML that parses into
// something that is not a sermon. The first comes from the parser's own position; the second is found by
// walking the field path `parseSermonBody` reported back down the document that was just parsed.

import { LineCounter, isNode, parseDocument, stringify } from 'yaml';

import { SERMON_PATH, parseSermonBody } from './sermon-body.js';

import type { Problem } from '@holydeck/contracts/problems';
import type { Document } from 'yaml';

import type { SermonBody } from './sermon-body.js';

/** The code every problem carries that is about the text itself rather than about the sermon in it. */
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

export type ReadSermon =
  | { readonly ok: true; readonly value: SermonBody }
  | { readonly ok: false; readonly problems: readonly LocatedProblem[] };

/** A sermon point or notice is never folded: a width limit would invent line breaks nobody wrote. */
const WRITTEN = { lineWidth: 0 } as const;

/** The sermon as text somebody edits. */
export function sermonToYaml(body: SermonBody): string {
  return stringify(body, WRITTEN);
}

/** `sermon.sermon.entries.1.book` as the document path `['sermon', 'entries', 1 as the index, 'book']`. */
const segmentsOf = (path: string): readonly (string | number)[] => {
  const parts = path.split('.');
  const named = parts[0] === SERMON_PATH ? parts.slice(1) : parts;
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

/** Reads the text as a sermon, or the reason it is not one, located where it is. */
export function sermonFromYaml(text: string): ReadSermon {
  // A fresh counter per call: a `LineCounter` accumulates the line starts of everything parsed through
  // it, and one shared between two documents would place the second document's problems in the first.
  const lines = new LineCounter();
  const document = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  if (document.errors.length > 0) {
    return {
      ok: false,
      problems: document.errors.map((error) => ({
        path: SERMON_PATH,
        code: YAML_SYNTAX,
        message: error.message,
        at: located(lines, error.pos[0]),
      })),
    };
  }
  const value: unknown = document.toJS();
  const parsed = parseSermonBody(value);
  if (parsed.ok) return parsed;
  return {
    ok: false,
    problems: parsed.problems.map((problem) => {
      const at = positionOf(nodeAt(document, segmentsOf(problem.path)), lines);
      return at === undefined ? problem : { ...problem, at };
    }),
  };
}
