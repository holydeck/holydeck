// The global slide-label catalogue as it is administered (spec LABL-01).
//
// Composed the way `slide-layouts.ts` composes, minus the half it does not need: a label has no
// separately versioned body, so there are no revisions here at all. What is left is the stamp history
// — one row per change, `sequence` counting from one, the standing stamp being the highest sequence a
// label has — with the name and the live shortcut written inline on the same row. Two writers reaching
// the same ordinal collide on the key rather than on the record, so the loser is told it lost.
//
// The catalogue's two rules are catalogue-wide, not per-record, which decides the order of every verb
// below: read what is currently offered, grade the claim against it with `conflictsWith`, and only then
// append. A refused save is a save after which the catalogue is exactly what it was — the promise
// "conflicting global label shortcuts block saving" is only worth anything if nothing was written on
// the way to the refusal, and every path here makes at most one write, after every check.
//
// Archiving frees a key. That is what `slideLabel`'s `archive: 'hidden'` policy means here: an archived
// label stops being offered, so nothing conflicts with the shortcut it used to hold, while every slide
// already labelled with it keeps reading. Bringing one back is therefore graded like a new claim,
// because the key it wants may have been given away while it was gone.

import { randomBytes } from 'node:crypto';

import { EntityError, archivedStamp, createdStamp, parseEntityStamp, restoredStamp, touchedStamp } from '@holydeck/contracts/entities';
import {
  SLIDE_LABEL_KIND,
  conflictsWith,
  parseSlideLabelDraft,
  readAssignedLabel,
  readableConflict,
} from '@holydeck/contracts/slide-labels';

import { requestContext } from './context.js';
import { permissionsFor } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { CatalogueConflict, ShortcutKey, SlideLabelDraft, SlideLabelEntry } from '@holydeck/contracts/slide-labels';

import type { RequestContext } from './context.js';
import type { Document, RepositoryDb } from './repositories.js';

/** The record class the stamps live in. Named once, because the permissions and the index read off it. */
export const SLIDE_LABEL_RECORD = 'slideLabels';

export const SLIDE_LABEL_PERMISSIONS = permissionsFor(SLIDE_LABEL_RECORD);

/** How a label is named in the audit trail: never as a bare identifier that could be anything. */
export const subjectFor = (id: string): string => `slideLabel:${id}`;

export interface SlideLabelIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// One index, and it serves the only two reads this store makes: the standing stamp of one label, and
// the standing stamp of every label. Unique, so a stamp history growing by one is the database's rule too.
const DECLARED_INDEXES: readonly SlideLabelIndex[] = [
  { name: 'slide_label_stamp', keys: { labelId: 1, sequence: -1 }, options: { unique: true } },
];

export const SLIDE_LABEL_INDEXES = Object.freeze(DECLARED_INDEXES);

export type SlideLabelRefusal = 'schema' | 'state' | 'conflict' | 'corrupt';

/**
 * Carries why the call was refused and, for a `conflict` about the catalogue's own rules, exactly which
 * claims collided and which label already holds each one. A caller told "that shortcut is taken" and not
 * told by what cannot act on it, so the conflicts travel on the error rather than inside its message.
 */
export class SlideLabelError extends Error {
  readonly kind: SlideLabelRefusal;

  readonly conflicts: readonly CatalogueConflict[];

  constructor(kind: SlideLabelRefusal, message: string, conflicts: readonly CatalogueConflict[] = []) {
    super(message);
    this.name = 'SlideLabelError';
    this.kind = kind;
    this.conflicts = conflicts;
  }
}

/** The one context the catalogue is administered under: this store's own record class, and nothing else. */
export function slideLabelContext(actor: string, correlationId: string): RequestContext {
  return requestContext({ actor, permissions: Object.values(SLIDE_LABEL_PERMISSIONS), correlationId });
}

/** One catalogue entry as it is administered: whether it is offered, what it is called, what jumps to it. */
export interface SlideLabelRecord {
  readonly stamp: EntityStamp;
  readonly name: string;
  readonly shortcut?: ShortcutKey;
}

export interface SlideLabelStore {
  create(context: unknown, draft: SlideLabelDraft): Promise<SlideLabelRecord>;
  get(context: unknown, id: string): Promise<SlideLabelRecord | undefined>;
  /** Renames a label, reassigns its shortcut, or takes its shortcut away. One call, one claim, one write. */
  edit(context: unknown, id: string, draft: SlideLabelDraft): Promise<SlideLabelRecord | undefined>;
  /** Stops offering it, and frees the key it held. Slides already labelled with it keep reading. */
  archive(context: unknown, id: string): Promise<SlideLabelRecord | undefined>;
  /** Offers it again, graded like a new claim, because its key may have been given away meanwhile. */
  unarchive(context: unknown, id: string): Promise<SlideLabelRecord | undefined>;
  /** Every label, archived ones included, for the screen the catalogue is managed on. */
  list(context: unknown): Promise<readonly SlideLabelRecord[]>;
  /** Only the labels that are still offered: what an Editor chooses from and what a live shortcut binds. */
  catalogue(context: unknown): Promise<readonly SlideLabelEntry[]>;
  /** The label an Editor chose, refusing one they typed instead. */
  assign(context: unknown, label: unknown): Promise<SlideLabelEntry>;
}

export interface SlideLabelOptions {
  /** Injected, so every instant this store writes comes from one clock and a test does not wait. */
  readonly now: () => string;
  readonly newId?: () => string;
}

const LABEL_ID_BYTES = 16;

const STAMP_SEPARATOR = '#';

const readable = (problem: { readonly path: string; readonly message: string }): string =>
  `${problem.path} ${problem.message}`;

const problems = (list: readonly { readonly path: string; readonly message: string }[]): string =>
  list.map(readable).join('; ');

/**
 * The refusals the layer underneath raises, said in this store's own words. An `EntityError` is a
 * lifecycle rule — editing something archived, archiving it twice — which is the state it is in rather
 * than a bad payload. Anything else passes through: the records layer's own refusals about context and
 * permission are already the clearest statement of what went wrong.
 */
function refusalFor(error: unknown): unknown {
  if (error instanceof EntityError) return new SlideLabelError('state', error.message);
  if (error instanceof RepositoryError && error.kind === 'duplicate') {
    return new SlideLabelError('conflict', `${error.message}, so another writer stamped this label first`);
  }
  return error;
}

const own = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw refusalFor(error);
  }
};

/** What one stamp row holds, once it has been read back as something this build understands. */
interface StampRow extends SlideLabelRecord {
  readonly sequence: number;
}

/** The name and the key on their own, which is what a claim is made of and what a stamp is not. */
const draftOf = (row: SlideLabelRecord): SlideLabelDraft => ({
  name: row.name,
  ...(row.shortcut === undefined ? {} : { shortcut: row.shortcut }),
});

const recordOf = (stamp: EntityStamp, draft: SlideLabelDraft): SlideLabelRecord => ({ stamp, ...draft });

const entryOf = (row: SlideLabelRecord): SlideLabelEntry => ({ id: row.stamp.id, ...draftOf(row) });

export function slideLabelsOn(db: RepositoryDb, options: SlideLabelOptions): SlideLabelStore {
  const records = repositoriesOn(db)[SLIDE_LABEL_RECORD];
  const newId = options.newId ?? ((): string => randomBytes(LABEL_ID_BYTES).toString('base64url'));

  const author = (context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> => {
    // Nothing is checked here: every call below has already read through the repository by this point,
    // and that layer refuses a context it cannot read as surely as it refuses an actor who may not append.
    const { actor, correlationId } = context as RequestContext;
    return { actor, correlationId };
  };

  const rowFrom = (found: Document): StampRow => {
    const name = found['name'];
    const sequence = found['sequence'];
    const shortcut = found['shortcut'];
    if (typeof name !== 'string' || typeof sequence !== 'number') {
      throw new SlideLabelError('corrupt', 'a slide label is stamped with a name or an ordinal this code cannot read');
    }
    const parsed = parseEntityStamp(found['stamp']);
    if (!parsed.ok) {
      throw new SlideLabelError('corrupt', `a slide label holds a stamp this code cannot read: ${problems(parsed.problems)}`);
    }
    return {
      stamp: parsed.value,
      name,
      sequence,
      ...(shortcut === undefined ? {} : { shortcut: shortcut as ShortcutKey }),
    };
  };

  /** The standing stamp of one label, or nothing at all when no such label was ever created. */
  const standing = async (context: unknown, id: string): Promise<StampRow | undefined> => {
    const [found] = await records.read(context, { labelId: id }, { sort: { sequence: -1 }, limit: 1 });
    return found === undefined ? undefined : rowFrom(found);
  };

  /** The standing stamp of every label there is, which is the only shape a catalogue-wide rule reads. */
  const everything = async (context: unknown): Promise<readonly StampRow[]> => {
    const found = await records.read(context, {});
    const byId = new Map<string, StampRow>();
    for (const document of found) {
      const labelId = document['labelId'];
      if (typeof labelId !== 'string') throw new SlideLabelError('corrupt', 'a slide label is missing its identifier');
      const row = rowFrom(document);
      const current = byId.get(labelId);
      if (current === undefined || current.sequence < row.sequence) byId.set(labelId, row);
    }
    return [...byId.values()];
  };

  const offered = async (context: unknown): Promise<readonly SlideLabelEntry[]> =>
    (await everything(context)).filter((row) => row.stamp.archivedAt === undefined).map(entryOf);

  /**
   * The claim, graded against the catalogue as it currently stands, before anything at all is written.
   * A label never conflicts with itself, so the identifier it will be stamped under is part of the claim
   * even on the path that is about to mint it.
   */
  const graded = async (context: unknown, id: string, claim: SlideLabelDraft): Promise<void> => {
    const conflicts = conflictsWith(await offered(context), { ...claim, id });
    if (conflicts.length > 0) {
      throw new SlideLabelError(
        'conflict',
        `this label cannot be saved: ${conflicts.map(readableConflict).join('; ')}`,
        conflicts,
      );
    }
  };

  /** The draft a caller handed in, graded before the catalogue is even read. */
  const readDraft = (draft: SlideLabelDraft): SlideLabelDraft => {
    const parsed = parseSlideLabelDraft(draft, 'slideLabel');
    if (!parsed.ok) throw new SlideLabelError('schema', `this is not a slide label: ${problems(parsed.problems)}`);
    return parsed.value;
  };

  const stampOnto = async (
    context: unknown,
    stamp: EntityStamp,
    draft: SlideLabelDraft,
    sequence: number,
  ): Promise<SlideLabelRecord> => {
    await records.append(context, {
      _id: `${stamp.id}${STAMP_SEPARATOR}${sequence}`,
      labelId: stamp.id,
      sequence,
      at: stamp.updatedAt,
      name: draft.name,
      ...(draft.shortcut === undefined ? {} : { shortcut: draft.shortcut }),
      stamp,
      ...author(context),
    });
    return recordOf(stamp, draft);
  };

  /**
   * A change to a label that already exists: the standing row, the claim it leaves the catalogue holding
   * graded against everything else that is offered, and then one append. `change` is what decides whether
   * the new stamp is a touch, an archival or a restoration, and it is applied last so a lifecycle refusal
   * and a conflict refusal both happen before the write rather than around it.
   */
  const restamp = async (
    context: unknown,
    id: string,
    claimOf: (row: StampRow) => SlideLabelDraft | undefined,
    change: (row: StampRow, at: string, by: string) => EntityStamp,
  ): Promise<SlideLabelRecord | undefined> => {
    const row = await standing(context, id);
    if (row === undefined) return undefined;
    const claim = claimOf(row);
    if (claim !== undefined) await graded(context, id, claim);
    const at = options.now();
    return stampOnto(context, change(row, at, author(context).actor), claim ?? draftOf(row), row.sequence + 1);
  };

  return {
    create: (context, draft) =>
      own(async () => {
        const claim = readDraft(draft);
        const id = newId();
        if ((await standing(context, id)) !== undefined) {
          throw new SlideLabelError('conflict', `${id} is a slide label another writer named first`);
        }
        await graded(context, id, claim);
        const stamp = createdStamp({ id, kind: SLIDE_LABEL_KIND, at: options.now(), by: author(context).actor });
        return stampOnto(context, stamp, claim, 1);
      }),

    get: (context, id) =>
      own(async () => {
        const row = await standing(context, id);
        return row === undefined ? undefined : recordOf(row.stamp, draftOf(row));
      }),

    edit: (context, id, draft) =>
      own(async () => {
        // Graded before the label is even looked up, so a bad draft is refused identically whether or not
        // the label it was meant for exists.
        const claim = readDraft(draft);
        return restamp(context, id, () => claim, (row, at, by) => touchedStamp(row.stamp, { at, by }));
      }),

    // An archival claims nothing, so it is never refused for a conflict: the key it held is what it gives up.
    archive: (context, id) =>
      own(() => restamp(context, id, () => undefined, (row, at, by) => archivedStamp(row.stamp, { at, by }))),

    unarchive: (context, id) =>
      own(() =>
        restamp(
          context,
          id,
          draftOf,
          (row, at, by) => restoredStamp(row.stamp, { at, by }),
        ),
      ),

    list: (context) => own(async () => (await everything(context)).map((row) => recordOf(row.stamp, draftOf(row)))),

    catalogue: (context) => own(() => offered(context)),

    assign: (context, label) =>
      own(async () => {
        const parsed = readAssignedLabel(await offered(context), label);
        if (!parsed.ok) {
          throw new SlideLabelError('schema', `this is not a label of the catalogue: ${problems(parsed.problems)}`);
        }
        return parsed.value;
      }),
  };
}
