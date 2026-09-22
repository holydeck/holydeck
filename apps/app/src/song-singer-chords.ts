// The chord data one singer carries for one song (spec CRT-13).
//
// A singer's chords are a relationship, not part of the song's body: one row per change makes the
// relationship's standing value the highest `sequence` its song/singer pair has. The pair is the natural
// identifier, so it is stamped directly rather than minted; different singers therefore never compete.

import { EntityError, createdStamp, parseEntityStamp, touchedStamp } from '@holydeck/contracts/entities';
import { parseSongSingerChordsDraft } from '@holydeck/contracts/songs';

import { requestContext } from './context.js';
import { permissionsFor } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { SongSingerChordsDraft } from '@holydeck/contracts/songs';
import type { RequestContext } from './context.js';
import type { Document, RepositoryDb } from './repositories.js';

export const SONG_SINGER_CHORDS_RECORD = 'songSingerChords';

export const SONG_SINGER_CHORDS_PERMISSIONS = permissionsFor(SONG_SINGER_CHORDS_RECORD);

export const subjectFor = (songId: string, singerId: string): string => `songSingerChords:${songId}:${singerId}`;

export interface SongSingerChordsIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

const DECLARED_INDEXES: readonly SongSingerChordsIndex[] = [
  { name: 'song_singer_chords_stamp', keys: { songId: 1, singerId: 1, sequence: -1 }, options: { unique: true } },
];

export const SONG_SINGER_CHORDS_INDEXES = Object.freeze(DECLARED_INDEXES);

export type SongSingerChordsRefusal = 'schema' | 'state' | 'conflict' | 'corrupt';

export class SongSingerChordsError extends Error {
  readonly kind: SongSingerChordsRefusal;

  constructor(kind: SongSingerChordsRefusal, message: string) {
    super(message);
    this.name = 'SongSingerChordsError';
    this.kind = kind;
  }
}

export function songSingerChordsContext(actor: string, correlationId: string): RequestContext {
  return requestContext({ actor, permissions: Object.values(SONG_SINGER_CHORDS_PERMISSIONS), correlationId });
}

export interface SongSingerChordsRecord {
  readonly stamp: EntityStamp;
  readonly songId: string;
  readonly singerId: string;
  readonly chords: string;
}

export interface SongSingerChordsStore {
  create(context: unknown, songId: string, singerId: string, draft: SongSingerChordsDraft): Promise<SongSingerChordsRecord>;
  get(context: unknown, songId: string, singerId: string): Promise<SongSingerChordsRecord | undefined>;
  edit(context: unknown, songId: string, singerId: string, draft: SongSingerChordsDraft): Promise<SongSingerChordsRecord | undefined>;
}

export interface SongSingerChordsOptions {
  readonly now: () => string;
}

const STAMP_SEPARATOR = '#';

const readable = (problem: { readonly path: string; readonly message: string }): string => `${problem.path} ${problem.message}`;

const problems = (list: readonly { readonly path: string; readonly message: string }[]): string => list.map(readable).join('; ');

function refusalFor(error: unknown): unknown {
  if (error instanceof EntityError) return new SongSingerChordsError('state', error.message);
  if (error instanceof RepositoryError && error.kind === 'duplicate') {
    return new SongSingerChordsError('conflict', `${error.message}, so another writer stamped these chords first`);
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

interface StampRow extends SongSingerChordsRecord {
  readonly sequence: number;
}

const recordOf = (row: StampRow): SongSingerChordsRecord => ({
  stamp: row.stamp,
  songId: row.songId,
  singerId: row.singerId,
  chords: row.chords,
});

export function songSingerChordsOn(db: RepositoryDb, options: SongSingerChordsOptions): SongSingerChordsStore {
  const records = repositoriesOn(db)[SONG_SINGER_CHORDS_RECORD];

  const author = (context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> => {
    const { actor, correlationId } = context as RequestContext;
    return { actor, correlationId };
  };

  const rowFrom = (found: Document): StampRow => {
    const songId = found['songId'];
    const singerId = found['singerId'];
    const sequence = found['sequence'];
    const at = found['at'];
    const chords = found['chords'];
    if (typeof songId !== 'string' || typeof singerId !== 'string' || typeof sequence !== 'number' ||
        typeof at !== 'string' || typeof chords !== 'string') {
      throw new SongSingerChordsError('corrupt', 'song-singer chords are stamped with fields this code cannot read');
    }
    const parsed = parseEntityStamp(found['stamp']);
    if (!parsed.ok) {
      throw new SongSingerChordsError('corrupt', `song-singer chords hold a stamp this code cannot read: ${problems(parsed.problems)}`);
    }
    return { stamp: parsed.value, songId, singerId, sequence, chords };
  };

  const idFor = (songId: string, singerId: string): string => `${songId}:${singerId}`;

  const standing = async (context: unknown, songId: string, singerId: string): Promise<StampRow | undefined> => {
    const [found] = await records.read(context, { songId, singerId }, { sort: { sequence: -1 }, limit: 1 });
    return found === undefined ? undefined : rowFrom(found);
  };

  const readDraft = (draft: SongSingerChordsDraft): SongSingerChordsDraft => {
    const parsed = parseSongSingerChordsDraft(draft, 'songSingerChords');
    if (!parsed.ok) throw new SongSingerChordsError('schema', `these are not song-singer chords: ${problems(parsed.problems)}`);
    return parsed.value;
  };

  const stampOnto = async (
    context: unknown,
    stamp: EntityStamp,
    songId: string,
    singerId: string,
    chords: string,
    sequence: number,
  ): Promise<SongSingerChordsRecord> => {
    await records.append(context, {
      _id: `${stamp.id}${STAMP_SEPARATOR}${sequence}`,
      songId,
      singerId,
      sequence,
      at: stamp.updatedAt,
      chords,
      stamp,
      ...author(context),
    });
    return { stamp, songId, singerId, chords };
  };

  const restamp = async (
    context: unknown,
    songId: string,
    singerId: string,
    draft: SongSingerChordsDraft,
  ): Promise<SongSingerChordsRecord | undefined> => {
    const row = await standing(context, songId, singerId);
    if (row === undefined) return undefined;
    const at = options.now();
    return stampOnto(context, touchedStamp(row.stamp, { at, by: author(context).actor }), songId, singerId, draft.chords, row.sequence + 1);
  };

  return {
    create: (context, songId, singerId, draft) =>
      own(async () => {
        const value = readDraft(draft);
        if ((await standing(context, songId, singerId)) !== undefined) {
          throw new SongSingerChordsError('conflict', `${songId}:${singerId} already has song-singer chords`);
        }
        const stamp = createdStamp({ id: idFor(songId, singerId), kind: 'songSingerChords', at: options.now(), by: author(context).actor });
        return stampOnto(context, stamp, songId, singerId, value.chords, 1);
      }),

    get: (context, songId, singerId) => own(async () => {
      const row = await standing(context, songId, singerId);
      return row === undefined ? undefined : recordOf(row);
    }),

    edit: (context, songId, singerId, draft) =>
      own(async () => restamp(context, songId, singerId, readDraft(draft))),
  };
}
