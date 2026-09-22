// The shelf a losing edit is kept on, and the note that says somebody settled it (spec COLL-01).
//
// Two writers reaching the same ordinal is a race one of them loses, and the revision store already says
// so — it refuses the second append rather than overwriting the first. What it cannot do is keep what the
// loser was trying to write: by the time the refusal is raised, that body exists nowhere. A shelf row is
// that body, written down before the refusal is passed on, so "both revisions are preserved" is a thing a
// reader can check rather than a thing the product says about itself.
//
// One collection holds two kinds of row, and neither is ever rewritten. A `shelved` row is the losing
// attempt itself: the ordinal it was aiming at, the body it carried, and who was writing it. A `resolved`
// row is a later note naming the shelved row it settles and the revision that settled it. Marking a
// conflict resolved is therefore an append like everything else here — the losing body stays exactly as
// it arrived, forever, and a resolution can be read as the event it was rather than as a flag somebody
// flipped and nobody can date.

import { FIELD_CODES, type Parsed, type ParseFn, isRecord, parseObject } from './problems.js';
import { REVISION_ORIGINS, type RevisionBody, type RevisionOrigin } from './revisions.js';

/** What a row on the shelf is: the losing attempt, or the note that says it was settled. */
export const SHELF_ENTRY_KINDS = ['shelved', 'resolved'] as const;

export type ShelfEntryKind = (typeof SHELF_ENTRY_KINDS)[number];

/** What separates the content from the ordinal in a shelf row's key, and so cannot be in the content. */
export const SHELF_KEY_SEPARATOR = '#';

/** What every row carries, whichever kind it is: which content, where in the shelf, and who wrote it. */
export interface ShelfStamp {
  readonly contentId: string;
  /** This row's place on the content's shelf, counting from one. Two writers reaching it collide. */
  readonly sequence: number;
  readonly at: string;
  readonly actor: string;
  readonly correlationId: string;
}

/** A losing edit, kept whole: the ordinal it wanted, and the body it would have written there. */
export interface ShelvedConflict extends ShelfStamp {
  readonly kind: 'shelved';
  /** The revision ordinal this writer was aiming at, which another writer reached first. */
  readonly attempted: number;
  readonly origin: RevisionOrigin;
  readonly body: RevisionBody;
}

/** The note that settles one shelved edit. It carries no body: the bodies are both already permanent. */
export interface ResolvedConflict extends ShelfStamp {
  readonly kind: 'resolved';
  /** The `sequence` of the shelved row this settles. */
  readonly resolves: number;
  /** The revision the resolution appended, which is where the settled body actually lives. */
  readonly revision: number;
}

export type ShelfEntry = ShelvedConflict | ResolvedConflict;

/** The identity of a row as the database stores it, so a second row at one place is a duplicate key. */
export const shelfKey = (contentId: string, sequence: number): string =>
  `${contentId}${SHELF_KEY_SEPARATOR}${sequence}`;

export const isShelved = (entry: ShelfEntry): entry is ShelvedConflict => entry.kind === 'shelved';

export const isResolved = (entry: ShelfEntry): entry is ResolvedConflict => entry.kind === 'resolved';

/**
 * Every shelved row on one content's shelf that no later row settles. Read as a whole, because whether a
 * conflict is outstanding is a fact about the shelf rather than about any one row on it.
 */
export function outstandingIn(entries: readonly ShelfEntry[]): readonly ShelvedConflict[] {
  const settled = new Set(entries.filter(isResolved).map((entry) => entry.resolves));
  return Object.freeze(entries.filter(isShelved).filter((entry) => !settled.has(entry.sequence)));
}

export const parseShelfEntry: ParseFn<ShelfEntry> = (value, path) =>
  parseObject(value, path, (reader) => {
    const contentId = reader.text('contentId');
    if (contentId.includes(SHELF_KEY_SEPARATOR)) {
      reader.reject(
        'contentId',
        FIELD_CODES.notAllowed,
        `must not contain ${SHELF_KEY_SEPARATOR}, which separates it from the ordinal in a shelf row's key`,
      );
    }
    const stamp: ShelfStamp = {
      contentId,
      sequence: reader.wholeNumber('sequence', 1),
      at: reader.time('at'),
      actor: reader.text('actor'),
      correlationId: reader.text('correlationId'),
    };
    const kind = reader.choice('kind', SHELF_ENTRY_KINDS);
    if (kind === 'resolved') {
      reader.absent('body', FIELD_CODES.notAllowed, 'is not carried by the note that settles a conflict');
      return { ...stamp, kind, resolves: reader.wholeNumber('resolves', 1), revision: reader.wholeNumber('revision', 1) };
    }
    const raw = reader.present('body');
    if (raw !== undefined && !isRecord(raw)) reader.reject('body', FIELD_CODES.notAnObject, 'must be an object');
    return {
      ...stamp,
      kind,
      attempted: reader.wholeNumber('attempted', 1),
      origin: reader.choice('origin', REVISION_ORIGINS),
      body: isRecord(raw) ? raw : {},
    };
  });

/** The ways an editor can settle a shelved body without making the losing revision disappear. */
export const CONFLICT_RESOLUTION_STRATEGIES = ['keep-mine', 'keep-theirs', 'combine'] as const;

/** One choice for a conflict, constrained so only a deliberate combination carries a replacement body. */
export type ConflictResolutionStrategy = (typeof CONFLICT_RESOLUTION_STRATEGIES)[number];

/** What a resolution request says: where its body comes from, or the body it made for the combined case. */
export interface ConflictResolutionInput {
  readonly strategy: ConflictResolutionStrategy;
  readonly resolvedBody?: Record<string, unknown>;
}

/** Reads a resolution request so the body exists exactly where the chosen settlement needs one. */
export const parseConflictResolution: ParseFn<ConflictResolutionInput> & ((value: unknown) => Parsed<ConflictResolutionInput>) = (value, path: string = 'body') =>
  parseObject(value, path, (reader) => {
    const strategy = reader.choice('strategy', CONFLICT_RESOLUTION_STRATEGIES);
    if (strategy === 'combine') {
      const raw = reader.present('resolvedBody');
      if (!isRecord(raw)) {
        reader.reject('resolvedBody', FIELD_CODES.notAnObject, 'is required when strategy is combine');
        return { strategy, resolvedBody: {} };
      }
      return { strategy, resolvedBody: raw };
    }
    reader.absent(
      'resolvedBody',
      FIELD_CODES.notAllowed,
      `is not read for ${strategy}, which resolves from the shelf or the current revision instead`,
    );
    return { strategy };
  });
