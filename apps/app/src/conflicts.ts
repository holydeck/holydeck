// The shelf a losing edit is kept on, and the one way a conflict is settled (spec COLL-01).
//
// `revisions.ts` already refuses a second writer that reaches an ordinal somebody else reached first: it
// raises `RevisionError('conflict')` rather than overwriting what is there, and six content stores map
// that refusal through their own vocabulary today. None of that changes here. What this module adds is
// the half that was missing on the way out of that refusal — the body the loser was carrying, which
// until now existed only in the request that was about to be refused and then nowhere at all.
//
// So `saveWithConflictPreservation` wraps the save rather than replacing it. On a conflict it writes the
// attempted body to its own append-only collection and then rethrows the very error `revisions.ts` made,
// unchanged and un-wrapped, because the four call sites that read `error.kind === 'conflict'` today are
// the contract and not an implementation detail. A caller that adopts the wrapper gets its edit kept; a
// caller that does not gets exactly what it gets today.
//
// Resolution is deliberately not a write path of its own. Whoever decides how the two bodies reconcile
// hands the result to the ordinary `revisions.save()` — the same call every other write in this product
// makes — so the settled body becomes the next revision in the same history, addressed and ordinalled
// like any other, and the ordinary rules about a save that changed nothing still apply to it. Nothing is
// discarded on either side: the winner was already permanent in `content_revisions` the moment it won,
// the loser is permanent here, and the note that says a conflict was settled is a third row appended
// beside the second rather than a flag written over it.
//
// A resolution is saved as `manual-checkpoint`, and no origin of its own was added. The revision store
// takes the same view of a restore — "a restore is what a person did, so it is recorded as the
// checkpoint it is rather than as a kind of its own" — and a resolution is the same act: a person read
// two bodies and decided what the content should say. What makes it a resolution rather than any other
// checkpoint is the `resolved` row that names it, which says far more than an origin could: which
// shelved attempt was settled, by whom, and when.

import { outstandingIn, parseShelfEntry, shelfKey } from '@holydeck/contracts/collaboration';

import { permissionsFor } from './records.js';
import { repositoriesOn } from './repositories.js';
import { RevisionError } from './revisions.js';

import type { ResolvedConflict, ShelfEntry, ShelvedConflict } from '@holydeck/contracts/collaboration';
import type { RevisionBody } from '@holydeck/contracts/revisions';

import type { RequestContext } from './context.js';
import type { Document, RepositoryDb } from './repositories.js';
import type { RevisionStore, SaveInput, SaveOutcome } from './revisions.js';

/** The record class this store owns. Named once, because the permissions and the index read off it. */
export const SHELF_RECORD = 'conflictShelf';

export const SHELF_PERMISSIONS = permissionsFor(SHELF_RECORD);

/** How a resolution is recorded in history. Not an origin of its own — see this file's header for why. */
export const RESOLUTION_ORIGIN = 'manual-checkpoint';

export interface ShelfIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// One index, and every read this store makes is served by it: one content's shelf in order. Unique as
// well, so the rule that a shelf grows by one is the database's a second time over — the first being the
// key each row is stored under.
const DECLARED_INDEXES: readonly ShelfIndex[] = [
  { name: 'conflict_shelf_entry', keys: { contentId: 1, sequence: 1 }, options: { unique: true } },
];

export const SHELF_INDEXES = Object.freeze(DECLARED_INDEXES);

export type ConflictRefusal = 'missing' | 'state' | 'corrupt';

/** Carries why the call was refused, so a caller can tell a defect from an entry somebody already settled. */
export class ConflictError extends Error {
  readonly kind: ConflictRefusal;

  constructor(kind: ConflictRefusal, message: string) {
    super(message);
    this.name = 'ConflictError';
    this.kind = kind;
  }
}

const readable = (problems: readonly { readonly path: string; readonly message: string }[]): string =>
  problems.map((problem) => `${problem.path} ${problem.message}`).join('; ');

const documentOf = (entry: ShelfEntry): Document => ({
  _id: shelfKey(entry.contentId, entry.sequence),
  contentId: entry.contentId,
  sequence: entry.sequence,
  kind: entry.kind,
  at: entry.at,
  actor: entry.actor,
  correlationId: entry.correlationId,
  ...(entry.kind === 'shelved'
    ? { attempted: entry.attempted, origin: entry.origin, body: entry.body }
    : { resolves: entry.resolves, revision: entry.revision }),
});

/**
 * Grades a stored row on the way out. The key is checked against the place on the shelf it claims to be,
 * because that is what a rewritten shelf would have to get right and it is not something this store can
 * get wrong on its own.
 */
function entryFrom(document: Document): ShelfEntry {
  const { _id: key, ...fields } = document;
  const parsed = parseShelfEntry(fields, 'shelfEntry');
  if (!parsed.ok) {
    throw new ConflictError('corrupt', `the conflict shelf holds a row this code cannot read: ${readable(parsed.problems)}`);
  }
  const entry = parsed.value;
  const own = shelfKey(entry.contentId, entry.sequence);
  if (key !== own) throw new ConflictError('corrupt', `the conflict shelf holds row ${own} under the key ${String(key)}`);
  return entry;
}

/**
 * Reads the actor out of a context so an append can record who is appending. Nothing is checked here:
 * by the time this runs the repository has already read with this context, and it refuses a context it
 * cannot read as surely as it refuses an actor who may not append.
 */
function authorOf(context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> {
  const { actor, correlationId } = context as RequestContext;
  return { actor, correlationId };
}

export interface ResolveInput {
  readonly contentId: string;
  /** The shelved row being settled, named by its key — `shelfKey(contentId, sequence)`. */
  readonly shelfEntryId: string;
  /** What the content should say now that somebody has read both sides of the conflict. */
  readonly resolvedBody: RevisionBody;
}

export interface ResolutionOutcome extends SaveOutcome {
  /** The losing attempt this settles. Still on the shelf, now marked resolved, never removed. */
  readonly shelved: ShelvedConflict;
  /** The note that marks it, appended beside it rather than written over it. */
  readonly marker: ResolvedConflict;
  /** The ordinal that stood before the resolution, which stays in history exactly where it was. */
  readonly over: number;
}

export interface ConflictShelf {
  /**
   * The ordinary save, with the losing body kept when it loses. Answers exactly what `revisions.save()`
   * answers, and refuses with exactly the error `revisions.save()` refused with.
   */
  saveWithConflictPreservation(context: unknown, revisions: RevisionStore, input: SaveInput): Promise<SaveOutcome>;
  /** Settles one shelved attempt by appending the body somebody decided on as the next revision. */
  resolveConflict(context: unknown, revisions: RevisionStore, input: ResolveInput): Promise<ResolutionOutcome>;
  /** Every row one content's shelf holds, in the order they were appended. Nothing is ever missing. */
  entries(context: unknown, contentId: string): Promise<readonly ShelfEntry[]>;
  /** Only the shelved attempts no later row settles: what an editor is still being asked to look at. */
  outstanding(context: unknown, contentId: string): Promise<readonly ShelvedConflict[]>;
}

export interface ConflictShelfOptions {
  /** Injected, so every instant one shelf writes comes from one clock and a test does not have to wait. */
  readonly now: () => string;
}

export function conflictShelfOn(db: RepositoryDb, options: ConflictShelfOptions): ConflictShelf {
  const records = repositoriesOn(db)[SHELF_RECORD];

  const rowsFor = async (context: unknown, contentId: string): Promise<readonly ShelfEntry[]> => {
    const found = await records.read(context, { contentId }, { sort: { sequence: 1 } });
    return Object.freeze(found.map(entryFrom));
  };

  /** The next free place on one content's shelf. A second writer reaching it collides on the key. */
  const nextPlace = async (context: unknown, contentId: string): Promise<number> =>
    (await records.count(context, { contentId })) + 1;

  const shelf: ConflictShelf = {
    async saveWithConflictPreservation(context, revisions, input) {
      // Read before the save rather than after it, because after it the ordinal this writer was aiming
      // at is gone: the winner is standing there. This is the same read `save` makes for itself, and
      // when a third writer lands between the two the ordinal recorded is still the one this writer was
      // aiming at, which is what the shelf row is there to say.
      const standing = await revisions.current(context, input.contentId);
      const attempted = (standing?.revision ?? 0) + 1;
      try {
        return await revisions.save(context, input);
      } catch (error) {
        if (!(error instanceof RevisionError) || error.kind !== 'conflict') throw error;
        await records.append(
          context,
          documentOf({
            kind: 'shelved',
            contentId: input.contentId,
            sequence: await nextPlace(context, input.contentId),
            attempted,
            origin: input.origin,
            body: input.body,
            at: options.now(),
            ...authorOf(context),
          }),
        );
        // The very error the revision store made, passed on untouched: every caller that reads
        // `kind === 'conflict'` today reads exactly what it read before this wrapper existed.
        throw error;
      }
    },

    async resolveConflict(context, revisions, { contentId, shelfEntryId, resolvedBody }) {
      const held = await rowsFor(context, contentId);
      const target = held.find((entry) => shelfKey(entry.contentId, entry.sequence) === shelfEntryId);
      if (target === undefined) {
        throw new ConflictError('missing', `${contentId} has no shelved conflict named ${shelfEntryId}`);
      }
      if (target.kind !== 'shelved') {
        throw new ConflictError('state', `${shelfEntryId} is the note that settles a conflict, not a conflict to settle`);
      }
      if (!outstandingIn(held).some((entry) => entry.sequence === target.sequence)) {
        throw new ConflictError('state', `${shelfEntryId} was settled already, and a conflict is settled once`);
      }
      // Something has to have won for anything to have lost, so a shelf row standing over an empty
      // history is a shelf somebody wrote by hand rather than a conflict this product ever had.
      const standing = await revisions.current(context, contentId);
      if (standing === undefined) {
        throw new ConflictError('corrupt', `${contentId} has a shelved conflict and no revision that could have won it`);
      }
      const outcome = await revisions.save(context, { contentId, body: resolvedBody, origin: RESOLUTION_ORIGIN });
      const marker: ResolvedConflict = {
        kind: 'resolved',
        contentId,
        sequence: held.length + 1,
        resolves: target.sequence,
        revision: outcome.revision.revision,
        at: options.now(),
        ...authorOf(context),
      };
      await records.append(context, documentOf(marker));
      return { ...outcome, shelved: target, marker, over: standing.revision };
    },

    entries: (context, contentId) => rowsFor(context, contentId),

    async outstanding(context, contentId) {
      return outstandingIn([...(await rowsFor(context, contentId))]);
    },
  };
  return Object.freeze(shelf);
}
