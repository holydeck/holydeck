import { describe, expect, it } from 'vitest';

import { RECORDS } from './records.js';
import { ContentLanguageError, contentLanguageContext, contentLanguagesOn } from './content-languages.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { Document } from './repositories.js';
import type { ContentLanguageStore } from './content-languages.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-17T09:30:00.000Z');

const ADMINISTRATOR = `account:${'D'.repeat(22)}`;

const ADMIN = contentLanguageContext(ADMINISTRATOR, 'req-c0ffee01');

const LANGUAGES = RECORDS.contentLanguages.collection;

const store = (): { db: FakeDb; languages: ContentLanguageStore } => {
  const db = fakeDb();
  let tick = 0;
  return {
    db,
    languages: contentLanguagesOn(db, { now: () => new Date(START + (tick += 1) * 1000 - 1000).toISOString() }),
  };
};

const rows = (db: FakeDb): Document[] => db.rows.get(LANGUAGES) ?? [];

const refused = async (call: Promise<unknown>): Promise<ContentLanguageError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof ContentLanguageError) return error;
    throw error;
  }
  throw new Error('the call was allowed');
};

const keys = (catalogue: readonly { readonly stamp: { readonly id: string } }[]): string[] =>
  catalogue.map((entry) => entry.stamp.id);

describe('managing the persisted content-language registry', () => {
  it('creates entries under a caller-chosen key, and offers every one of them', async () => {
    const { db, languages } = store();
    const tamil = await languages.create(ADMIN, 'ta', { displayName: 'Tamil', script: 'Tamil', fallbackFont: 'Latha' });
    expect(tamil.stamp.kind).toBe('contentLanguage');
    expect(tamil.stamp.id).toBe('ta');
    expect(tamil.displayName).toBe('Tamil');

    const romanized = await languages.create(ADMIN, 'ta-Latn', {
      displayName: 'Romanized Tamil',
      script: 'Latin',
      fallbackFont: 'sans-serif',
    });
    expect(romanized.stamp.id).toBe('ta-Latn');

    expect(keys(await languages.catalogue(ADMIN))).toEqual(['ta', 'ta-Latn']);
    expect(await languages.get(ADMIN, 'ta')).toEqual(tamil);
    expect(rows(db)).toHaveLength(2);
  });

  it('re-saves an entry’s display name, script or font, one append each time', async () => {
    const { db, languages } = store();
    await languages.create(ADMIN, 'ta', { displayName: 'Tamil', script: 'Tamil', fallbackFont: 'Latha' });

    const edited = await languages.edit(ADMIN, 'ta', { displayName: 'Tamil (spoken)', script: 'Tamil', fallbackFont: 'Latha' });
    expect(edited).toMatchObject({ displayName: 'Tamil (spoken)' });

    expect(rows(db)).toHaveLength(2);
    expect(rows(db).map((row) => row['sequence'])).toEqual([1, 2]);
    expect((await languages.get(ADMIN, 'ta'))?.stamp.updatedBy).toBe(ADMINISTRATOR);
  });

  it('archives an entry, stopping it being offered, but still lists it', async () => {
    const { languages } = store();
    await languages.create(ADMIN, 'ta', { displayName: 'Tamil', script: 'Tamil', fallbackFont: 'Latha' });

    const archived = await languages.archive(ADMIN, 'ta');
    expect(archived?.stamp.archivedAt).toBeDefined();
    expect(archived?.displayName).toBe('Tamil');
    expect(await languages.catalogue(ADMIN)).toEqual([]);
    expect(keys(await languages.list(ADMIN))).toEqual(['ta']);
  });

  it('offers an archived entry again', async () => {
    const { languages } = store();
    await languages.create(ADMIN, 'ta', { displayName: 'Tamil', script: 'Tamil', fallbackFont: 'Latha' });
    await languages.archive(ADMIN, 'ta');
    expect((await languages.unarchive(ADMIN, 'ta'))?.stamp.archivedAt).toBeUndefined();
    expect(keys(await languages.catalogue(ADMIN))).toEqual(['ta']);
  });

  it('answers with nothing for a key never created', async () => {
    const { languages } = store();
    expect(await languages.get(ADMIN, 'fr')).toBeUndefined();
    expect(await languages.edit(ADMIN, 'fr', { displayName: 'French', script: 'Latin', fallbackFont: 'sans-serif' })).toBeUndefined();
    expect(await languages.archive(ADMIN, 'fr')).toBeUndefined();
    expect(await languages.unarchive(ADMIN, 'fr')).toBeUndefined();
    expect(await languages.list(ADMIN)).toEqual([]);
  });

  it('refuses to change an archived entry, because archiving is what stops one changing', async () => {
    const { db, languages } = store();
    await languages.create(ADMIN, 'ta', { displayName: 'Tamil', script: 'Tamil', fallbackFont: 'Latha' });
    await languages.archive(ADMIN, 'ta');
    const before = rows(db).length;
    const error = await refused(
      languages.edit(ADMIN, 'ta', { displayName: 'Tamil (spoken)', script: 'Tamil', fallbackFont: 'Latha' }),
    );
    expect(error.kind).toBe('state');
    expect(rows(db)).toHaveLength(before);
  });
});

describe('a key already claimed is refused, and nothing is written', () => {
  it('refuses a second create under a key another writer already stamped', async () => {
    const { db, languages } = store();
    await languages.create(ADMIN, 'ta', { displayName: 'Tamil', script: 'Tamil', fallbackFont: 'Latha' });
    const error = await refused(
      languages.create(ADMIN, 'ta', { displayName: 'Tamil again', script: 'Tamil', fallbackFont: 'Latha' }),
    );
    expect(error).toBeInstanceOf(ContentLanguageError);
    expect(error.name).toBe('ContentLanguageError');
    expect(error.kind).toBe('conflict');
    expect(error.message).toContain('ta is a content language another writer named first');
    expect(rows(db)).toHaveLength(1);
  });

  it('refuses a draft missing a required field, writing nothing', async () => {
    const { db, languages } = store();
    const error = await refused(
      languages.create(ADMIN, 'ta', { displayName: 'Tamil', script: '' } as never),
    );
    expect(error.kind).toBe('schema');
    expect(rows(db)).toEqual([]);
  });

  it('refuses an empty key, before it ever reads the draft', async () => {
    const { db, languages } = store();
    const error = await refused(
      languages.create(ADMIN, '', { displayName: 'Tamil', script: 'Tamil', fallbackFont: 'Latha' }),
    );
    expect(error.kind).toBe('schema');
    expect(rows(db)).toEqual([]);
  });

  it('says a stamp the database refused as a duplicate was another writer’s, not a bad claim', async () => {
    const { db, languages } = store();
    await languages.create(ADMIN, 'ta', { displayName: 'Tamil', script: 'Tamil', fallbackFont: 'Latha' });
    db.failOn = (): Error => Object.assign(new Error('E11000 duplicate key: ta#2'), { code: 11_000 });

    const error = await refused(
      languages.edit(ADMIN, 'ta', { displayName: 'Tamil (spoken)', script: 'Tamil', fallbackFont: 'Latha' }),
    );
    expect(error.kind).toBe('conflict');
    expect(rows(db)).toHaveLength(1);
  });
});

describe('a stored entry this build cannot read is corrupt, not absent', () => {
  it('refuses a row stamped with a field this code cannot read', async () => {
    const { db, languages } = store();
    await languages.create(ADMIN, 'ta', { displayName: 'Tamil', script: 'Tamil', fallbackFont: 'Latha' });
    const [row] = rows(db);
    db.rows.set(LANGUAGES, [{ ...row, displayName: 7 }]);
    expect((await refused(languages.get(ADMIN, 'ta'))).kind).toBe('corrupt');
  });

  it('refuses a row holding a stamp it cannot read', async () => {
    const { db, languages } = store();
    await languages.create(ADMIN, 'ta', { displayName: 'Tamil', script: 'Tamil', fallbackFont: 'Latha' });
    const [row] = rows(db);
    db.rows.set(LANGUAGES, [{ ...row, stamp: { id: 'ta' } }]);
    const error = await refused(languages.catalogue(ADMIN));
    expect(error.kind).toBe('corrupt');
  });

  it('refuses a row that is missing the key a catalogue is grouped by', async () => {
    const { db, languages } = store();
    await languages.create(ADMIN, 'ta', { displayName: 'Tamil', script: 'Tamil', fallbackFont: 'Latha' });
    const [row] = rows(db);
    db.rows.set(LANGUAGES, [{ ...row, languageKey: 7 }]);
    expect((await refused(languages.list(ADMIN))).kind).toBe('corrupt');
  });
});
