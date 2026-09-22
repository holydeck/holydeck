import { describe, expect, it } from 'vitest';

import { RECORDS } from './records.js';
import { SongSingerChordsError, songSingerChordsContext, songSingerChordsOn, subjectFor } from './song-singer-chords.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { Document } from './repositories.js';
import type { SongSingerChordsStore } from './song-singer-chords.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-23T09:30:00.000Z');
const ACTOR = `account:${'D'.repeat(22)}`;
const CONTEXT = songSingerChordsContext(ACTOR, 'req-7a31c04e');
const CHORDS = RECORDS.songSingerChords.collection;

const store = (): { db: FakeDb; chords: SongSingerChordsStore } => {
  const db = fakeDb();
  let tick = 0;
  return {
    db,
    chords: songSingerChordsOn(db, { now: () => new Date(START + (tick += 1) * 1000 - 1000).toISOString() }),
  };
};

const rows = (db: FakeDb): Document[] => db.rows.get(CHORDS) ?? [];

const refused = async (call: Promise<unknown>): Promise<SongSingerChordsError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof SongSingerChordsError) return error;
    throw error;
  }
  throw new Error('the call was allowed');
};

describe('song-singer chords', () => {
  it('names the relationship for its audit trail', () => {
    expect(subjectFor('song-1', 'singer-1')).toBe('songSingerChords:song-1:singer-1');
  });

  it('creates, gets, and edits one singer’s chord data as a stamp history', async () => {
    const { db, chords } = store();
    const created = await chords.create(CONTEXT, 'song-1', 'singer-1', { chords: 'Am  F  C  G' });
    expect(created).toMatchObject({ songId: 'song-1', singerId: 'singer-1', chords: 'Am  F  C  G' });
    expect(created.stamp).toMatchObject({ id: 'song-1:singer-1', kind: 'songSingerChords' });
    expect(await chords.get(CONTEXT, 'song-1', 'singer-1')).toEqual(created);
    expect(await chords.get(CONTEXT, 'song-1', 'singer-2')).toBeUndefined();

    const edited = await chords.edit(CONTEXT, 'song-1', 'singer-1', { chords: 'Dm  G  C' });
    expect(edited).toMatchObject({ chords: 'Dm  G  C' });
    expect(await chords.edit(CONTEXT, 'song-1', 'singer-2', { chords: 'Em' })).toBeUndefined();
    expect(rows(db).map((row) => row['sequence'])).toEqual([1, 2]);
  });

  it('refuses a second standing row for the same song and singer', async () => {
    const { db, chords } = store();
    await chords.create(CONTEXT, 'song-1', 'singer-1', { chords: 'Am' });
    const error = await refused(chords.create(CONTEXT, 'song-1', 'singer-1', { chords: 'Dm' }));
    expect(error.kind).toBe('conflict');
    expect(rows(db)).toHaveLength(1);
  });

  it('refuses a stored row it cannot read as corrupt', async () => {
    const { db, chords } = store();
    await chords.create(CONTEXT, 'song-1', 'singer-1', { chords: 'Am' });
    const [row] = rows(db);
    db.rows.set(CHORDS, [{ ...row, chords: 7 }]);
    expect((await refused(chords.get(CONTEXT, 'song-1', 'singer-1'))).kind).toBe('corrupt');
  });

  it('refuses a row holding a stamp it cannot read', async () => {
    const { db, chords } = store();
    await chords.create(CONTEXT, 'song-1', 'singer-1', { chords: 'Am' });
    const [row] = rows(db);
    db.rows.set(CHORDS, [{ ...row, stamp: { id: 'song-1:singer-1' } }]);
    expect((await refused(chords.get(CONTEXT, 'song-1', 'singer-1'))).kind).toBe('corrupt');
  });
});
