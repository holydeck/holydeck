// The durable global content library (spec CONT-01): every Reading, Reusable slide, Sermon, Slide
// group, and Song is discoverable here from the instant it is created, before any Service references
// it or any body/revision is ever written for it. This store only answers "does it exist, of what
// kind, called what" — the same split `slide-layouts.ts` draws between an entity stamp and the
// content drawn on it, except this task never writes the content side. A later task (T47, T51, T64)
// saves bodies against the exact `contentId` this store mints, through the already-generic
// `revisionsOn()` store — this file never calls it.
//
// No promotion step exists, and none is added later without changing this file: CONT-01 says library
// views filter rather than promote, so `list`'s only per-kind behaviour is a filter — nothing here moves
// an item from one visibility to another.
//
// Archiving (DELT-01) is not promotion: `archive` and `restore` append one more stamp row over the
// standing one, exactly as `create` appends the first, so the item's whole history stays readable and
// `list` already hides an archived item unless asked. The body and its revisions are never touched;
// whether anything still uses the item is the `/dependents` route's question, answered before a person
// confirms, not a refusal here.

import { randomBytes } from 'node:crypto';

import { EntityError, archivedStamp, createdStamp, parseEntityStamp, restoredStamp } from '@holydeck/contracts/entities';
import { parseLibraryDraft } from '@holydeck/contracts/library';

import { requestContext } from './context.js';
import { permissionsFor } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { LibraryDraft, LibraryKind } from '@holydeck/contracts/library';

import type { RequestContext } from './context.js';
import type { RepositoryDb } from './repositories.js';

export const LIBRARY_RECORD = 'contentLibrary';

export const LIBRARY_PERMISSIONS = permissionsFor(LIBRARY_RECORD);

/** How a library item is named in the audit trail, once some later task records one. */
export const subjectFor = (id: string): string => `library:${id}`;

export interface LibraryIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

const DECLARED_INDEXES: readonly LibraryIndex[] = [
  { name: 'content_library_stamp', keys: { contentId: 1, sequence: -1 }, options: { unique: true } },
];

export const LIBRARY_INDEXES = Object.freeze(DECLARED_INDEXES);

export type LibraryRefusal = 'schema' | 'conflict' | 'corrupt' | 'state';

export class LibraryError extends Error {
  readonly kind: LibraryRefusal;

  constructor(kind: LibraryRefusal, message: string) {
    super(message);
    this.name = 'LibraryError';
    this.kind = kind;
  }
}

export function libraryContext(actor: string, correlationId: string): RequestContext {
  return requestContext({ actor, permissions: Object.values(LIBRARY_PERMISSIONS), correlationId });
}

export interface LibraryRecord {
  readonly stamp: EntityStamp;
  readonly title: string;
}

export interface LibraryFilter {
  readonly kind?: LibraryKind;
  readonly q?: string;
  readonly archived?: boolean;
}

export interface LibraryStore {
  create(context: unknown, draft: LibraryDraft): Promise<LibraryRecord>;
  get(context: unknown, id: string): Promise<LibraryRecord | undefined>;
  list(context: unknown, filter?: LibraryFilter): Promise<readonly LibraryRecord[]>;
  /** Nothing when no such item exists; a `state` refusal when it is already archived. */
  archive(context: unknown, id: string): Promise<LibraryRecord | undefined>;
  /** Nothing when no such item exists; a `state` refusal when it is not archived. */
  restore(context: unknown, id: string): Promise<LibraryRecord | undefined>;
}

export interface LibraryOptions {
  readonly now: () => string;
  readonly newId?: () => string;
}

const LIBRARY_ID_BYTES = 16;
const STAMP_SEPARATOR = '#';

const readable = (problem: { readonly path: string; readonly message: string }): string =>
  `${problem.path} ${problem.message}`;
const problems = (list: readonly { readonly path: string; readonly message: string }[]): string =>
  list.map(readable).join('; ');

const own = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RepositoryError && error.kind === 'duplicate') {
      throw new LibraryError('conflict', `${error.message}, so another writer stamped this item first`);
    }
    throw error;
  }
};

interface StampRow {
  readonly stamp: EntityStamp;
  readonly title: string;
  readonly sequence: number;
}

export function libraryOn(db: RepositoryDb, options: LibraryOptions): LibraryStore {
  const records = repositoriesOn(db)[LIBRARY_RECORD];
  const newId = options.newId ?? ((): string => randomBytes(LIBRARY_ID_BYTES).toString('base64url'));

  const author = (context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> => {
    const { actor, correlationId } = context as RequestContext;
    return { actor, correlationId };
  };

  const rowFrom = (found: Record<string, unknown>): StampRow => {
    const title = found['title'];
    const sequence = found['sequence'];
    if (typeof title !== 'string' || typeof sequence !== 'number') {
      throw new LibraryError('corrupt', 'a library row is stamped with a title or an ordinal this code cannot read');
    }
    const parsed = parseEntityStamp(found['stamp']);
    if (!parsed.ok) {
      throw new LibraryError('corrupt', `a library row holds a stamp this code cannot read: ${problems(parsed.problems)}`);
    }
    return { stamp: parsed.value, title, sequence };
  };

  /** The standing stamp of one item, or nothing when no such item was ever created. */
  const standing = async (context: unknown, id: string): Promise<StampRow | undefined> => {
    const [found] = await records.read(context, { contentId: id }, { sort: { sequence: -1 }, limit: 1 });
    return found === undefined ? undefined : rowFrom(found);
  };

  const stampOnto = async (context: unknown, stamp: EntityStamp, title: string, sequence: number): Promise<LibraryRecord> => {
    await records.append(context, {
      _id: `${stamp.id}${STAMP_SEPARATOR}${sequence}`,
      contentId: stamp.id,
      sequence,
      at: stamp.updatedAt,
      title,
      stamp,
      ...author(context),
    });
    return { stamp, title };
  };

  /** One more stamp over the standing one, or nothing when there is no standing one to change. */
  const restamp = async (
    context: unknown,
    id: string,
    change: typeof archivedStamp | typeof restoredStamp,
  ): Promise<LibraryRecord | undefined> => {
    const row = await standing(context, id);
    if (row === undefined) return undefined;
    let stamp: EntityStamp;
    try {
      stamp = change(row.stamp, { at: options.now(), by: author(context).actor });
    } catch (error) {
      if (error instanceof EntityError) throw new LibraryError('state', error.message);
      throw error;
    }
    return stampOnto(context, stamp, row.title, row.sequence + 1);
  };

  return {
    archive: (context, id) => own(() => restamp(context, id, archivedStamp)),

    restore: (context, id) => own(() => restamp(context, id, restoredStamp)),

    create: (context, draft) =>
      own(async () => {
        const parsed = parseLibraryDraft(draft, 'library');
        if (!parsed.ok) throw new LibraryError('schema', `this is not a library item: ${problems(parsed.problems)}`);
        const id = newId();
        if ((await standing(context, id)) !== undefined) {
          throw new LibraryError('conflict', `${id} is a library item another writer named first`);
        }
        const at = options.now();
        const stamp = createdStamp({ id, kind: parsed.value.kind, at, by: author(context).actor });
        return stampOnto(context, stamp, parsed.value.title, 1);
      }),

    get: (context, id) =>
      own(async () => {
        const row = await standing(context, id);
        return row === undefined ? undefined : { stamp: row.stamp, title: row.title };
      }),

    list: (context, filter) =>
      own(async () => {
        const rows = await records.read(context, {});
        const byId = new Map<string, StampRow>();
        for (const found of rows) {
          const contentId = found['contentId'];
          if (typeof contentId !== 'string') {
            throw new LibraryError('corrupt', 'a library row is missing its identifier');
          }
          const row = rowFrom(found);
          const current = byId.get(contentId);
          if (current === undefined || current.sequence < row.sequence) byId.set(contentId, row);
        }
        const standing = [...byId.values()].map((row) => ({ stamp: row.stamp, title: row.title }));
        return standing.filter((row) => {
          if (filter?.kind !== undefined && row.stamp.kind !== filter.kind) return false;
          if (filter?.archived !== true && row.stamp.archivedAt !== undefined) return false;
          if (filter?.q !== undefined && !row.title.toLowerCase().includes(filter.q.toLowerCase())) return false;
          return true;
        });
      }),
  };
}
