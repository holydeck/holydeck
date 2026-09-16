// Slide Layouts: reusable, versioned arrangements of positioned Text and Media boxes (spec TMPL-01).
//
// This is the first place two already-built mechanisms are composed, and they are composed rather than
// merged because they answer different questions. `@holydeck/contracts/entities` stamps say whether a
// Layout is offered where Layouts are chosen — created, archived, brought back — and nothing about what is
// drawn on it. `./revisions.js` says what is drawn on it over time, and nothing about whether anyone may
// still choose it. So a Slide Layout is one entity stamp and N revisions: archiving one leaves its geometry
// exactly where it was, and versioning one leaves its visibility exactly where it was.
//
// Neither mechanism has an update verb, because no layer under this one does. The stamp is therefore kept
// as a history of its own: one row per change, `sequence` counting from one, and the standing stamp being
// the highest sequence a Layout has. Two writers reaching the same ordinal collide on the key rather than
// on the record, so the loser is told it lost instead of quietly overwriting the winner.
//
// Order of writing matters once and is settled here: the boxes are written before the stamp. A revision no
// stamp names is invisible and costs a row; a stamp no revision answers would be a Layout that cannot be
// drawn, which is a Layout the product would have to special-case forever.

import { randomBytes } from 'node:crypto';

import {
  EntityError,
  archivedStamp,
  createdStamp,
  parseEntityStamp,
  restoredStamp,
  touchedStamp,
} from '@holydeck/contracts/entities';
import { parseSlideLayoutBody, parseSlideLayoutDraft } from '@holydeck/contracts/layouts';

import { requestContext } from './context.js';
import { permissionsFor } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';
import { REVISION_PERMISSIONS, RevisionError, revisionsOn } from './revisions.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { SlideLayoutBody, SlideLayoutDraft } from '@holydeck/contracts/layouts';
import type { RevisionRecord } from '@holydeck/contracts/revisions';

import type { RequestContext } from './context.js';
import type { RepositoryDb } from './repositories.js';
import type { RevisionRefusal } from './revisions.js';

/** The record class the stamps live in. Named once, because the permissions and the index read off it. */
export const LAYOUT_RECORD = 'slideLayouts';

export const LAYOUT_PERMISSIONS = permissionsFor(LAYOUT_RECORD);

/** How a Layout is named in the audit trail: never as a bare identifier that could be anything. */
export const subjectFor = (id: string): string => `slideLayout:${id}`;

export interface LayoutIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// One index, and every read this store makes is served by it: the standing stamp of one Layout. Unique, so
// the rule that a stamp history grows by one is the database's too, and not only this file's.
const DECLARED_INDEXES: readonly LayoutIndex[] = [
  { name: 'slide_layout_stamp', keys: { layoutId: 1, sequence: -1 }, options: { unique: true } },
];

export const LAYOUT_INDEXES = Object.freeze(DECLARED_INDEXES);

export type SlideLayoutRefusal = 'schema' | 'state' | 'conflict' | 'corrupt';

/** Carries why the call was refused, so a caller can tell a bad payload from a race it lost fairly. */
export class SlideLayoutError extends Error {
  readonly kind: SlideLayoutRefusal;

  constructor(kind: SlideLayoutRefusal, message: string) {
    super(message);
    this.name = 'SlideLayoutError';
    this.kind = kind;
  }
}

/** The one context a Slide Layout is administered under: the two stores it spans, and nothing else. */
export function slideLayoutContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [...Object.values(LAYOUT_PERMISSIONS), ...Object.values(REVISION_PERMISSIONS)],
    correlationId,
  });
}

/** A Slide Layout as it is administered: whether it is offered, and what it is called. */
export interface SlideLayoutRecord {
  readonly stamp: EntityStamp;
  readonly name: string;
}

/** The same, plus the one version of its boxes that was asked for. */
export interface SlideLayoutPreview extends SlideLayoutRecord {
  readonly revision: number;
  readonly at: string;
  readonly body: SlideLayoutBody;
}

export interface VersionOutcome {
  /** False when the boxes did not change: the ordinal below is the one that already stood. */
  readonly appended: boolean;
  readonly revision: number;
}

export interface RestoredVersion extends VersionOutcome {
  /** The ordinal the boxes came back from, which stays in history exactly where it was. */
  readonly from: number;
}

export interface SlideLayoutStore {
  create(context: unknown, draft: SlideLayoutDraft): Promise<SlideLayoutPreview>;
  /** The standing boxes, or a named earlier ordinal. Nothing is written either way. */
  preview(context: unknown, id: string, revision?: number): Promise<SlideLayoutPreview | undefined>;
  /** Saves boxes forward. Nothing for an unknown Layout; nothing appended when they did not change. */
  version(context: unknown, id: string, body: SlideLayoutBody): Promise<VersionOutcome | undefined>;
  /** Saves an earlier ordinal's boxes forward — a restore appends rather than rewrites. */
  restoreVersion(context: unknown, id: string, revision: number): Promise<RestoredVersion | undefined>;
  /** Stops offering it where Layouts are chosen. Its boxes and its history are untouched. */
  archive(context: unknown, id: string): Promise<SlideLayoutRecord | undefined>;
  restore(context: unknown, id: string): Promise<SlideLayoutRecord | undefined>;
  history(context: unknown, id: string): Promise<readonly RevisionRecord[]>;
}

export interface SlideLayoutOptions {
  /** Injected, so every instant one store writes comes from one clock and a test does not wait. */
  readonly now: () => string;
  readonly newId?: () => string;
}

const LAYOUT_ID_BYTES = 16;

const STAMP_SEPARATOR = '#';

const readable = (problem: { readonly path: string; readonly message: string }): string =>
  `${problem.path} ${problem.message}`;

// A revision refusal said again in this store's vocabulary. `missing` is the only one that changes name:
// a revision the caller asked for and history does not have is the state it is in, not a bad payload.
const REVISION_REFUSALS: Readonly<Record<RevisionRefusal, SlideLayoutRefusal>> = {
  schema: 'schema',
  missing: 'state',
  conflict: 'conflict',
  corrupt: 'corrupt',
};

/**
 * Every refusal the two composed mechanisms raise, said in this store's own words — so a caller of a Slide
 * Layout never has to know which of them answered. Anything else is passed through untouched: the records
 * layer's own refusals about context and permission are already the clearest statement of what went wrong.
 */
function refusalFor(error: unknown): unknown {
  if (error instanceof EntityError) return new SlideLayoutError('state', error.message);
  if (error instanceof RevisionError) return new SlideLayoutError(REVISION_REFUSALS[error.kind], error.message);
  if (error instanceof RepositoryError && error.kind === 'duplicate') {
    return new SlideLayoutError('conflict', `${error.message}, so another writer stamped this Slide Layout first`);
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

const problems = (list: readonly { readonly path: string; readonly message: string }[]): string =>
  list.map(readable).join('; ');

/** The boxes, graded before they are stored and again before they are served. */
function readBody(value: unknown): SlideLayoutBody {
  const parsed = parseSlideLayoutBody(value);
  if (!parsed.ok) {
    throw new SlideLayoutError(
      'schema',
      `these are not boxes a Slide Layout is built from: ${problems(parsed.problems)}`,
    );
  }
  return parsed.value;
}

/** The name and the boxes together, which is what a new Slide Layout is. */
function readDraft(draft: SlideLayoutDraft): SlideLayoutDraft {
  const parsed = parseSlideLayoutDraft({ name: draft.name, ...draft.body });
  if (!parsed.ok) throw new SlideLayoutError('schema', `this is not a Slide Layout: ${problems(parsed.problems)}`);
  return parsed.value;
}

/** What one stamp row holds, once it has been read back as something this build understands. */
interface StampRow {
  readonly stamp: EntityStamp;
  readonly name: string;
  readonly sequence: number;
}

export function slideLayoutsOn(db: RepositoryDb, options: SlideLayoutOptions): SlideLayoutStore {
  const records = repositoriesOn(db)[LAYOUT_RECORD];
  const revisions = revisionsOn(db, { now: options.now });
  const newId = options.newId ?? ((): string => randomBytes(LAYOUT_ID_BYTES).toString('base64url'));

  const author = (context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> => {
    // Nothing is checked here: every call below has already read through the repository by this point, and
    // that layer refuses a context it cannot read as surely as it refuses an actor who may not append.
    const { actor, correlationId } = context as RequestContext;
    return { actor, correlationId };
  };

  /** The standing stamp of one Layout, or nothing at all when no such Layout was ever created. */
  const standing = async (context: unknown, id: string): Promise<StampRow | undefined> => {
    const [found] = await records.read(context, { layoutId: id }, { sort: { sequence: -1 }, limit: 1 });
    if (found === undefined) return undefined;
    const name = found['name'];
    const sequence = found['sequence'];
    if (typeof name !== 'string' || typeof sequence !== 'number') {
      throw new SlideLayoutError('corrupt', `${id} is stamped with a name or an ordinal this code cannot read`);
    }
    const parsed = parseEntityStamp(found['stamp']);
    if (!parsed.ok) {
      throw new SlideLayoutError('corrupt', `${id} holds a stamp this code cannot read: ${problems(parsed.problems)}`);
    }
    return { stamp: parsed.value, name, sequence };
  };

  const stampOnto = async (
    context: unknown,
    stamp: EntityStamp,
    name: string,
    sequence: number,
  ): Promise<SlideLayoutRecord> => {
    await records.append(context, {
      _id: `${stamp.id}${STAMP_SEPARATOR}${sequence}`,
      layoutId: stamp.id,
      sequence,
      at: stamp.updatedAt,
      name,
      stamp,
      ...author(context),
    });
    return { stamp, name };
  };

  /** The boxes a stored revision holds, graded on the way out for the reason the revision store grades. */
  const bodyOf = (record: RevisionRecord): SlideLayoutBody => {
    const parsed = parseSlideLayoutBody(record.body);
    if (!parsed.ok) {
      throw new SlideLayoutError(
        'corrupt',
        `revision ${record.revision} of ${record.contentId} holds boxes this code cannot read: ${problems(parsed.problems)}`,
      );
    }
    return parsed.value;
  };

  /** A version saved forward, and the stamp touched only when something was actually appended. */
  const saved = async (
    context: unknown,
    row: StampRow,
    save: () => Promise<{ readonly appended: boolean; readonly revision: RevisionRecord }>,
  ): Promise<VersionOutcome> => {
    const at = options.now();
    // Before anything is written: an archived Layout is one nothing changes, and `touchedStamp` says so.
    const touched = touchedStamp(row.stamp, { at, by: author(context).actor });
    const outcome = await save();
    if (!outcome.appended) return { appended: false, revision: outcome.revision.revision };
    await stampOnto(context, touched, row.name, row.sequence + 1);
    return { appended: true, revision: outcome.revision.revision };
  };

  const restamp = async (
    context: unknown,
    id: string,
    change: (row: StampRow, at: string, by: string) => EntityStamp,
  ): Promise<SlideLayoutRecord | undefined> => {
    const row = await standing(context, id);
    if (row === undefined) return undefined;
    const at = options.now();
    return stampOnto(context, change(row, at, author(context).actor), row.name, row.sequence + 1);
  };

  return {
    create: (context, draft) =>
      own(async () => {
        const { name, body } = readDraft(draft);
        const id = newId();
        const at = options.now();
        const outcome = await revisions.save(context, { contentId: id, body, origin: 'manual-checkpoint' });
        const stamp = createdStamp({ id, kind: 'slideLayout', at, by: author(context).actor });
        await stampOnto(context, stamp, name, 1);
        return { stamp, name, revision: outcome.revision.revision, at: outcome.revision.at, body };
      }),

    preview: (context, id, revision) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const record =
          revision === undefined
            ? await revisions.current(context, id)
            : await revisions.read(context, id, revision);
        if (record === undefined) return undefined;
        return { stamp: row.stamp, name: row.name, revision: record.revision, at: record.at, body: bodyOf(record) };
      }),

    version: (context, id, body) =>
      own(async () => {
        const boxes = readBody(body);
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        return saved(context, row, () =>
          revisions.save(context, { contentId: id, body: boxes, origin: 'manual-checkpoint' }),
        );
      }),

    restoreVersion: (context, id, revision) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        // Read first, so an ordinal this Layout never had is an answer of nothing rather than a refusal:
        // it is the same question `preview` asks, and it is answered the same way.
        const target = await revisions.read(context, id, revision);
        if (target === undefined) return undefined;
        const outcome = await saved(context, row, () => revisions.restore(context, { contentId: id, revision }));
        return { ...outcome, from: revision };
      }),

    archive: (context, id) => own(() => restamp(context, id, (row, at, by) => archivedStamp(row.stamp, { at, by }))),

    restore: (context, id) => own(() => restamp(context, id, (row, at, by) => restoredStamp(row.stamp, { at, by }))),

    history: (context, id) => own(() => revisions.history(context, id)),
  };
}
