// Songs (spec SONG-01): one canonical configuration per song, versioned, edited visually or as raw text,
// and carried between installations as bytes. Composed exactly the way `slide-groups.ts` composes, and for
// the same reason: `./library.js` owns whether a song is discoverable and what it is called, `./revisions.js`
// owns what it holds over time, and this store owns neither — it adds no record, collection, or migration.
//
// Stamp first, then the body, for the structural reason `slide-groups.ts`'s header sets out: `library.create`
// mints the `contentId` inside its own closure, so there is no id to save a body under until it has run. A
// stamp whose body never arrived is corrupt, never "not found".
//
// The whole of this store's own subject is that a song has two editing surfaces and one configuration. The
// visual surface hands in a `SongBody`; the raw surface hands in the text of one. Both are graded by
// `parseSongBody` before anything is written, and neither can reach storage another way — so "without
// semantic loss" is not a promise this file keeps by being careful, it is the only shape it has.
//
// Nothing is ever partly saved. Every verb below validates before its first write, and every verb makes at
// most one write, so a refusal is a call after which the song is exactly what it was. Raw editing is where
// that matters most: a person retyping a long song in one box must never be told "line 40 is wrong" by a
// store that has already saved lines 1 to 39.
//
// Determinism is free, from the layer that already has it: identical bodies address identically, so a save
// that changed nothing appends nothing, and an export of an unchanged song is the same bytes it was before.

import { parseSongBody, exportSong, importSong } from '@holydeck/contracts/songs';

import { requestContext } from './context.js';
import { LibraryError, LIBRARY_PERMISSIONS, libraryOn } from './library.js';
import { RevisionError, REVISION_PERMISSIONS, revisionsOn } from './revisions.js';
import { songFromYaml, songToYaml } from './song-yaml.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { Problem } from '@holydeck/contracts/problems';
import type { RevisionRecord } from '@holydeck/contracts/revisions';
import type { SongBody } from '@holydeck/contracts/songs';

import type { RequestContext } from './context.js';
import type { RepositoryDb } from './repositories.js';
import type { RevisionRefusal } from './revisions.js';
import type { LocatedProblem } from './song-yaml.js';

export type SongRefusal = 'schema' | 'state' | 'conflict' | 'corrupt';

/**
 * Carries why the call was refused, and — for a refusal about the configuration itself — every problem
 * that made it one, each where the raw editor should put its marker. The list is empty for a refusal that
 * is not about a payload at all, such as a race this caller lost.
 */
export class SongError extends Error {
  readonly kind: SongRefusal;

  readonly problems: readonly LocatedProblem[];

  constructor(kind: SongRefusal, message: string, problems: readonly LocatedProblem[] = []) {
    super(message);
    this.name = 'SongError';
    this.kind = kind;
    this.problems = problems;
  }
}

/** The one context a song is administered under: the two stores it spans, and nothing else. */
export function songContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [...Object.values(LIBRARY_PERMISSIONS), ...Object.values(REVISION_PERMISSIONS)],
    correlationId,
  });
}

/** One version of one song: how it is discovered, which version this is, and the configuration itself. */
export interface SongRecord {
  readonly stamp: EntityStamp;
  /** What the song is listed under. Its canonical titles are the body's, and are not this. */
  readonly title: string;
  readonly revision: number;
  readonly at: string;
  readonly body: SongBody;
}

export interface SongStore {
  create(context: unknown, title: string, body: SongBody): Promise<SongRecord>;
  /** The standing configuration, or a named earlier version. Nothing is written either way. */
  current(context: unknown, id: string, revision?: number): Promise<SongRecord | undefined>;
  /** Saves a configuration forward from the visual surface. */
  edit(context: unknown, id: string, body: SongBody): Promise<SongRecord | undefined>;
  /** The same configuration as the text the raw surface edits. */
  raw(context: unknown, id: string, revision?: number): Promise<string | undefined>;
  /** Saves what the raw surface typed. Refuses with located problems, having written nothing. */
  editRaw(context: unknown, id: string, text: string): Promise<SongRecord | undefined>;
  /** The bytes this song travels as, identical for a song that did not change. */
  exportPortable(context: unknown, id: string, revision?: number): Promise<string | undefined>;
  /** Reads those bytes back as a new song of this library. The arriving configuration is kept verbatim. */
  importPortable(context: unknown, title: string, text: string): Promise<SongRecord>;
  history(context: unknown, id: string): Promise<readonly SongRecord[]>;
}

export interface SongOptions {
  /** Injected, so every instant one store writes comes from one clock and a test does not wait. */
  readonly now: () => string;
  readonly newId?: () => string;
}

const readable = (problem: Problem): string => `${problem.path} ${problem.message}`;

const problems = (list: readonly Problem[]): string => list.map(readable).join('; ');

// A revision refusal said again in this store's vocabulary. `missing` is the only one that changes name:
// this store never calls `revisions.restore`, so it never arises in practice, but the mapping is kept
// exhaustive for the same reason `slide-groups.ts` keeps its own.
const REVISION_REFUSALS: Readonly<Record<RevisionRefusal, SongRefusal>> = {
  schema: 'schema',
  missing: 'state',
  conflict: 'conflict',
  corrupt: 'corrupt',
};

/**
 * Every refusal the two composed stores raise, said in this store's own words — so a caller of a song
 * never has to know which of them answered. A context or permission refusal from the records layer
 * underneath either one is passed through untouched: it is already the clearest statement of what is wrong.
 */
function refusalFor(error: unknown): unknown {
  if (error instanceof LibraryError) return new SongError(error.kind, error.message);
  if (error instanceof RevisionError) return new SongError(REVISION_REFUSALS[error.kind], error.message);
  return error;
}

const own = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw refusalFor(error);
  }
};

/** The configuration a caller handed in, graded before it is stored. */
function readBody(value: SongBody): SongBody {
  const parsed = parseSongBody(value);
  if (!parsed.ok) {
    throw new SongError('schema', `this is not a song configuration: ${problems(parsed.problems)}`, parsed.problems);
  }
  return parsed.value;
}

/** The configuration a stored revision holds, graded on the way out for the reason the revision store grades. */
function bodyOf(record: RevisionRecord): SongBody {
  const parsed = parseSongBody(record.body);
  if (!parsed.ok) {
    throw new SongError(
      'corrupt',
      `revision ${record.revision} of ${record.contentId} holds a song this code cannot read: ${problems(parsed.problems)}`,
      parsed.problems,
    );
  }
  return parsed.value;
}

export function songsOn(db: RepositoryDb, options: SongOptions): SongStore {
  // Passed through whole: a song needs no identifier of its own beyond the one the library mints for it.
  const library = libraryOn(db, options);
  const revisions = revisionsOn(db, { now: options.now });

  /** The stamp and one version read back together. A stamp with no body at all is corrupt, never absent. */
  const standing = async (context: unknown, id: string, revision?: number): Promise<SongRecord | undefined> => {
    const listed = await library.get(context, id);
    if (listed === undefined) return undefined;
    const held =
      revision === undefined ? await revisions.current(context, id) : await revisions.read(context, id, revision);
    if (held === undefined) {
      // Only ever one of the two: the standing version of a stamped song is a version that must exist,
      // while a version somebody named and history does not have is a question answered with nothing.
      if (revision !== undefined) return undefined;
      throw new SongError('corrupt', `${id} is stamped as a song and holds no configuration at all`);
    }
    return { stamp: listed.stamp, title: listed.title, revision: held.revision, at: held.at, body: bodyOf(held) };
  };

  const save = async (
    context: unknown,
    listed: Pick<SongRecord, 'stamp' | 'title'>,
    id: string,
    body: SongBody,
  ): Promise<SongRecord> => {
    const outcome = await revisions.save(context, { contentId: id, body, origin: 'manual-checkpoint' });
    return {
      stamp: listed.stamp,
      title: listed.title,
      revision: outcome.revision.revision,
      at: outcome.revision.at,
      body,
    };
  };

  /** A song this store did not have a moment ago: stamped first, then given the configuration it holds. */
  const started = async (context: unknown, title: string, body: SongBody): Promise<SongRecord> => {
    const listed = await library.create(context, { kind: 'song', title });
    return save(context, listed, listed.stamp.id, body);
  };

  return {
    create: (context, title, body) => own(() => started(context, title, readBody(body))),

    current: (context, id, revision) => own(() => standing(context, id, revision)),

    edit: (context, id, body) =>
      own(async () => {
        // Graded before the song is even looked up, so a bad configuration is refused identically whether
        // or not the song it was meant for exists.
        const configuration = readBody(body);
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        return save(context, row, id, configuration);
      }),

    raw: (context, id, revision) =>
      own(async () => {
        const row = await standing(context, id, revision);
        return row === undefined ? undefined : songToYaml(row.body);
      }),

    editRaw: (context, id, text) =>
      own(async () => {
        const read = songFromYaml(text);
        if (!read.ok) {
          throw new SongError('schema', `this text is not a song configuration: ${problems(read.problems)}`, read.problems);
        }
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        return save(context, row, id, read.value);
      }),

    exportPortable: (context, id, revision) =>
      own(async () => {
        const row = await standing(context, id, revision);
        return row === undefined ? undefined : exportSong(row.body);
      }),

    importPortable: (context, title, text) =>
      own(async () => {
        const read = importSong(text);
        if (!read.ok) {
          throw new SongError('schema', `these are not the bytes of a song: ${problems(read.problems)}`, read.problems);
        }
        // Kept verbatim, provenance included: a song that says where it came from must still say it after
        // travelling, and re-exporting what was just imported has to be the same bytes that arrived.
        return started(context, title, read.value);
      }),

    history: (context, id) =>
      own(async () => {
        const listed = await library.get(context, id);
        if (listed === undefined) return [];
        const found = await revisions.history(context, id);
        return found.map((held) => ({
          stamp: listed.stamp,
          title: listed.title,
          revision: held.revision,
          at: held.at,
          body: bodyOf(held),
        }));
      }),
  };
}
