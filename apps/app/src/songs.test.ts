import { describe, expect, it } from 'vitest';

import { CONTENT_LANGUAGES } from '@holydeck/contracts/content-languages';
import { exportSong } from '@holydeck/contracts/songs';

import { libraryOn } from './library.js';
import { RECORDS } from './records.js';
import { addressOf, revisionsOn } from './revisions.js';
import { slideGroupsOn } from './slide-groups.js';
import { slideLayoutContext, slideLayoutsOn } from './slide-layouts.js';
import { songFromYaml, songToYaml } from './song-yaml.js';
import { SongError, songContext, songsOn, subjectFor } from './songs.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { BoxBinding, SlideLayoutBody, TextLayoutBox } from '@holydeck/contracts/layouts';
import type { LyricSection, SongBody } from '@holydeck/contracts/songs';

import type { Document } from './repositories.js';
import type { SongGeneration, SongStore } from './songs.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-17T09:30:00.000Z');

describe('subjectFor', () => {
  it('names a song for the audit trail', () => {
    expect(subjectFor('song-1')).toBe('song:song-1');
  });
});

const ADMINISTRATOR = `account:${'C'.repeat(22)}`;

const ADMIN = songContext(ADMINISTRATOR, 'req-5f2c81ab');

const STAMPS = RECORDS.contentLibrary.collection;

const REVISIONS = RECORDS.contentRevisions.collection;

const [TAMIL, ROMANIZED_TAMIL] = CONTENT_LANGUAGES;

const TA = TAMIL!.key;

const TA_LATN = ROMANIZED_TAMIL!.key;

const SONG: SongBody = {
  titles: { tamil: 'பாடல்', romanized: 'Paadal' },
  languages: [TA, TA_LATN],
  sections: [
    {
      id: 'verse-1',
      label: 'Verse 1',
      text: [
        { languageKey: TA, text: 'முதல் வரி' },
        { languageKey: TA_LATN, text: 'Muthal vari' },
      ],
    },
  ],
  provenance: { source: 'manual' },
};

const IMPORTED: SongBody = {
  ...SONG,
  provenance: { source: 'import', importer: 'powerpoint', importedAt: '2026-09-14T08:00:00Z', reference: 'set.pptx' },
};

const withChorus = (body: SongBody): SongBody => ({
  ...body,
  sections: [...body.sections, { id: 'chorus', label: 'Chorus', repeat: { count: 2 }, text: [] }],
});

const store = (): { db: FakeDb; songs: SongStore } => {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  return {
    db,
    songs: songsOn(db, {
      now: () => new Date(START + (tick += 1) * 1000 - 1000).toISOString(),
      newId: () => `id-${(serial += 1)}`,
    }),
  };
};

const LAYOUT_ADMIN = slideLayoutContext(ADMINISTRATOR, 'req-song-layout');

const box = (id: string, binding: BoxBinding): TextLayoutBox => ({
  id, kind: 'text', importance: 'required',
  frame: { x: 0, y: 0, width: 1, height: 1 }, binding,
  style: { fontFamily: 'Inter', fontWeight: 400, sizeRatio: 0.05, lineHeight: 1, align: 'start', verticalAlign: 'start' },
});
const keyed = (id: string, contentKey: string, languageKey = TA): TextLayoutBox =>
  box(id, { mode: 'keyed', contentKind: 'song', contentKey, languageKey });
const LAYOUT: SlideLayoutBody = { boxes: [
  keyed('title', 'title'), keyed('title-latn', 'title', TA_LATN),
  keyed('lyric', 'lyricLine'), keyed('lyric-latn', 'lyricLine', TA_LATN),
  keyed('author', 'author'), keyed('copyright', 'copyright'),
  box('static', { mode: 'static', text: 'Sunday' }),
  { id: 'media', kind: 'media', importance: 'decoration', frame: { x: 0, y: 0, width: 1, height: 1 }, style: { fit: 'cover', opacity: 1 } },
] };

const SONG_WITH_META: SongBody = { ...SONG, metadata: { author: 'Author Name', copyright: '© 2026 Author' } };

const CHORUS_SECTION: LyricSection = {
  id: 'chorus',
  label: 'Chorus',
  repeat: { count: 2 },
  text: [
    { languageKey: TA, text: 'குரல் கூட்டணி' },
    { languageKey: TA_LATN, text: 'Kural koottani' },
  ],
};

const withSungChorus = (body: SongBody): SongBody => ({ ...body, sections: [...body.sections, CHORUS_SECTION] });

const stores = () => {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  const now = () => new Date(START + (tick += 1) * 1000 - 1000).toISOString();
  const options = { now, newId: () => `id-${(serial += 1)}` };
  return {
    db,
    songs: songsOn(db, options),
    library: libraryOn(db, options),
    revisions: revisionsOn(db, options),
    groups: slideGroupsOn(db, options),
    layouts: slideLayoutsOn(db, { now, newId: () => `layout-${(serial += 1)}` }),
  };
};

async function generation(layout: SlideLayoutBody = LAYOUT, body: SongBody = SONG_WITH_META) {
  const composed = stores();
  const source = await composed.songs.create(ADMIN, 'Paadal', body);
  const selected = await composed.layouts.create(LAYOUT_ADMIN, { name: 'Song', body: layout });
  const input: SongGeneration = {
    songRevision: source.revision, slideLayoutId: selected.stamp.id, slideLayoutRevision: selected.revision,
  };
  return { ...composed, source, selected, input };
}

const rows = (db: FakeDb, collection: string): Document[] => db.rows.get(collection) ?? [];

const refused = async (call: Promise<unknown>): Promise<SongError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof SongError) return error;
    throw error;
  }
  throw new Error('the call was allowed');
};

describe('the life of one song', () => {
  it('creates a song, versions it, and keeps every version it had', async () => {
    const { db, songs } = store();
    const created = await songs.create(ADMIN, 'Paadal', SONG);
    expect(created.stamp.kind).toBe('song');
    expect(created.title).toBe('Paadal');
    expect(created.revision).toBe(1);
    expect(created.body).toEqual(SONG);
    expect(rows(db, STAMPS)).toHaveLength(1);
    expect(rows(db, REVISIONS)).toHaveLength(1);
    const id = created.stamp.id;

    const edited = await songs.edit(ADMIN, id, withChorus(SONG));
    expect(edited?.revision).toBe(2);
    expect(edited?.body.sections.map((section) => section.id)).toEqual(['verse-1', 'chorus']);

    const history = await songs.history(ADMIN, id);
    expect(history.map((version) => version.revision)).toEqual([1, 2]);
    expect(history[0]?.body).toEqual(SONG);
    expect((await songs.current(ADMIN, id))?.revision).toBe(2);
    expect((await songs.current(ADMIN, id, 1))?.body).toEqual(SONG);
  });

  it('appends nothing for a save that changed nothing, and says which version still stands', async () => {
    const { db, songs } = store();
    const created = await songs.create(ADMIN, 'Paadal', SONG);
    const again = await songs.edit(ADMIN, created.stamp.id, SONG);
    expect(again?.revision).toBe(1);
    expect(rows(db, REVISIONS)).toHaveLength(1);
  });

  it('answers with nothing for a song, or a version of one, that was never written', async () => {
    const { songs } = store();
    const created = await songs.create(ADMIN, 'Paadal', SONG);
    expect(await songs.current(ADMIN, 'id-nope')).toBeUndefined();
    expect(await songs.current(ADMIN, created.stamp.id, 7)).toBeUndefined();
    expect(await songs.edit(ADMIN, 'id-nope', SONG)).toBeUndefined();
    expect(await songs.raw(ADMIN, 'id-nope')).toBeUndefined();
    expect(await songs.editRaw(ADMIN, 'id-nope', songToYaml(SONG))).toBeUndefined();
    expect(await songs.exportPortable(ADMIN, 'id-nope')).toBeUndefined();
    expect(await songs.history(ADMIN, 'id-nope')).toEqual([]);
  });
});

describe('the visual surface and the raw surface are one configuration', () => {
  it('shows the same song either way, whichever one wrote it last', async () => {
    const { songs } = store();
    const created = await songs.create(ADMIN, 'Paadal', SONG);
    const id = created.stamp.id;
    expect(await songs.raw(ADMIN, id)).toBe(songToYaml(SONG));

    await songs.edit(ADMIN, id, withChorus(SONG));
    const parsed = songFromYaml((await songs.raw(ADMIN, id))!);
    expect(parsed.ok && parsed.value).toEqual(withChorus(SONG));
  });

  it('loses nothing when a song is opened as text and saved straight back', async () => {
    const { db, songs } = store();
    const created = await songs.create(ADMIN, 'Paadal', SONG);
    const id = created.stamp.id;
    const saved = await songs.editRaw(ADMIN, id, (await songs.raw(ADMIN, id))!);
    expect(saved?.body).toEqual(SONG);
    // The configuration did not change, so nothing was appended: a round trip through the raw editor is
    // not an edit, and a history full of them would say a song changed on days nobody touched it.
    expect(saved?.revision).toBe(1);
    expect(rows(db, REVISIONS)).toHaveLength(1);
  });

  it('saves what the raw surface typed, and the visual surface reads it back', async () => {
    const { songs } = store();
    const created = await songs.create(ADMIN, 'Paadal', SONG);
    const id = created.stamp.id;
    const retyped = (await songs.raw(ADMIN, id))!.replace('Muthal vari', 'Muthal varigal');
    const saved = await songs.editRaw(ADMIN, id, retyped);
    expect(saved?.revision).toBe(2);
    expect((await songs.current(ADMIN, id))?.body.sections[0]?.text[1]?.text).toBe('Muthal varigal');
    expect(await songs.raw(ADMIN, id, 1)).toBe(songToYaml(SONG));
  });
});

describe('a refused save writes nothing at all', () => {
  it('refuses text YAML cannot read, and says where, having appended nothing', async () => {
    const { db, songs } = store();
    const created = await songs.create(ADMIN, 'Paadal', SONG);
    const error = await refused(songs.editRaw(ADMIN, created.stamp.id, 'titles:\n\ttamil: பாடல்\n'));
    expect(error.kind).toBe('schema');
    expect(error.problems).toEqual([
      { path: 'song', code: 'yaml.syntax', message: expect.any(String), at: { line: 2, column: 1 } },
    ]);
    expect(rows(db, REVISIONS)).toHaveLength(1);
    expect((await songs.current(ADMIN, created.stamp.id))?.body).toEqual(SONG);
  });

  it('refuses text that is good YAML and a bad song, at the line the bad field is on', async () => {
    const { db, songs } = store();
    const created = await songs.create(ADMIN, 'Paadal', SONG);
    const broken = (await songs.raw(ADMIN, created.stamp.id))!.replace(`  - ${TA_LATN}\n`, '');
    const error = await refused(songs.editRaw(ADMIN, created.stamp.id, broken));
    expect(error.kind).toBe('schema');
    expect(error.problems.map((problem) => problem.path)).toEqual(['song.sections.0.text.1.languageKey']);
    expect(error.problems[0]?.at?.line).toBeGreaterThan(1);
    expect(rows(db, REVISIONS)).toHaveLength(1);
  });

  it('refuses a configuration the visual surface got wrong, before it looks the song up at all', async () => {
    const { db, songs } = store();
    const error = await refused(songs.edit(ADMIN, 'id-nope', { ...SONG, languages: [] }));
    expect(error.kind).toBe('schema');
    expect(error.problems.map((problem) => problem.path)).toEqual([
      'song.sections.0.text.0.languageKey',
      'song.sections.0.text.1.languageKey',
    ]);
    expect(rows(db, STAMPS)).toHaveLength(0);
    expect(rows(db, REVISIONS)).toHaveLength(0);
  });

  it('says the library’s own refusal in this store’s words, so a caller asks only one of them', async () => {
    const { db, songs } = store();
    const error = await refused(songs.create(ADMIN, '', SONG));
    expect(error.kind).toBe('schema');
    expect(error.message).toContain('library.title');
    expect(rows(db, STAMPS)).toHaveLength(0);
  });

  it('refuses to create a song that is not one, stamping nothing to hold it', async () => {
    const { db, songs } = store();
    const error = await refused(songs.create(ADMIN, 'Paadal', { ...SONG, provenance: { source: 'import' } } as SongBody));
    expect(error.kind).toBe('schema');
    expect(rows(db, STAMPS)).toHaveLength(0);
  });
});

describe('a song as bytes that travel', () => {
  it('exports the same bytes for a song nothing changed, and the version it was asked for', async () => {
    const { songs } = store();
    const created = await songs.create(ADMIN, 'Paadal', SONG);
    const id = created.stamp.id;
    const first = await songs.exportPortable(ADMIN, id);
    expect(first).toBe(exportSong(SONG));
    expect(await songs.exportPortable(ADMIN, id)).toBe(first);

    await songs.edit(ADMIN, id, withChorus(SONG));
    expect(await songs.exportPortable(ADMIN, id)).not.toBe(first);
    expect(await songs.exportPortable(ADMIN, id, 1)).toBe(first);
  });

  it('imports what another installation exported, provenance and all, and re-exports it identically', async () => {
    const { db, songs } = store();
    const text = exportSong(IMPORTED);
    const imported = await songs.importPortable(ADMIN, 'Paadal', text);
    expect(imported.stamp.kind).toBe('song');
    expect(imported.revision).toBe(1);
    expect(imported.body).toEqual(IMPORTED);
    expect(await songs.exportPortable(ADMIN, imported.stamp.id)).toBe(text);
    expect(rows(db, STAMPS)).toHaveLength(1);
  });

  it('imports a song twice as two songs, because a copy is not the same configuration’s history', async () => {
    const { songs } = store();
    const text = exportSong(SONG);
    const first = await songs.importPortable(ADMIN, 'Paadal', text);
    const second = await songs.importPortable(ADMIN, 'Paadal (copy)', text);
    expect(second.stamp.id).not.toBe(first.stamp.id);
    expect(second.body).toEqual(first.body);
  });

  it('refuses bytes that are not a song, stamping nothing to hold them', async () => {
    const { db, songs } = store();
    const error = await refused(songs.importPortable(ADMIN, 'Paadal', 'not a portable document'));
    expect(error.kind).toBe('schema');
    expect(error.problems.map((problem) => problem.path)).toEqual(['document']);
    expect(rows(db, STAMPS)).toHaveLength(0);
    expect(rows(db, REVISIONS)).toHaveLength(0);
  });
});

// ADR 0004's decision: a generated slide is a deterministic projection of a pinned source revision and a
// pinned Slide Layout revision, reading nothing that was not pinned.
describe('song slide generation', () => {
  it('uses the selected source and Layout revisions, mixed bindings, section order and repeat expansion', async () => {
    const { songs, layouts, groups, source, selected, input } = await generation(LAYOUT, withSungChorus(SONG_WITH_META));
    await layouts.version(LAYOUT_ADMIN, selected.stamp.id, { boxes: [keyed('new-title', 'title')] });
    await songs.edit(ADMIN, source.stamp.id, { ...SONG_WITH_META, titles: { tamil: 'மாற்றம்', romanized: 'Maatram' } });
    const group = await songs.generate(ADMIN, source.stamp.id, input);
    expect(group.body.generatedFrom).toEqual({
      songId: source.stamp.id, songRevision: 1, slideLayoutId: selected.stamp.id, slideLayoutRevision: 1,
    });
    expect(group.body.mode).toBe('generated');
    expect(group.body.slides.map((slide) => slide.id)).toEqual(['verse-1', 'chorus-1', 'chorus-2']);
    expect(group.body.slides.map((slide) => slide.label)).toEqual(['Verse 1', 'Chorus (1/2)', 'Chorus (2/2)']);
    expect(group.body.slides[0]?.languageBlocks).toEqual([
      { id: 'title', languageKey: TA, text: 'பாடல்' },
      { id: 'title-latn', languageKey: TA_LATN, text: 'Paadal' },
      { id: 'lyric', languageKey: TA, text: 'முதல் வரி' },
      { id: 'lyric-latn', languageKey: TA_LATN, text: 'Muthal vari' },
      { id: 'author', languageKey: TA, text: 'Author Name' },
      { id: 'copyright', languageKey: TA, text: '© 2026 Author' },
    ]);
    expect(group.body.slides[1]?.languageBlocks.find((block) => block.id === 'lyric')?.text).toBe('குரல் கூட்டணி');
    expect((await groups.current(ADMIN, group.stamp.id))?.body.generatedFrom).toEqual(group.body.generatedFrom);
  });

  it('regenerates identical slides without appending a revision; changed inputs append once', async () => {
    const { songs, source, input, revisions, groups } = await generation();
    const group = await songs.generate(ADMIN, source.stamp.id, input);
    const repeated = await songs.generate(ADMIN, source.stamp.id, { ...input, slideGroupId: group.stamp.id });
    expect(repeated.body).toEqual(group.body);
    expect(await revisions.count(ADMIN, group.stamp.id)).toBe(1);
    const changed = await songs.edit(ADMIN, source.stamp.id, { ...SONG_WITH_META, titles: { ...SONG_WITH_META.titles, romanized: 'New title' } });
    await songs.generate(ADMIN, source.stamp.id, { ...input, songRevision: changed!.revision, slideGroupId: group.stamp.id });
    expect(await revisions.count(ADMIN, group.stamp.id)).toBe(2);
    expect((await groups.history(ADMIN, group.stamp.id))[0]?.body).toEqual(group.body);
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN])('requires explicit positive source and Layout revisions (%s)', async (revision) => {
    const { songs, source, input, library } = await generation();
    for (const field of ['songRevision', 'slideLayoutRevision']) {
      await expect(songs.generate(ADMIN, source.stamp.id, { ...input, [field]: revision } as SongGeneration))
        .rejects.toMatchObject({ kind: 'schema' });
    }
    expect(await library.list(ADMIN, { kind: 'slideGroup' })).toEqual([]);
  });

  it.each(['source', 'source-revision', 'layout', 'layout-revision', 'group'])('refuses a missing %s without creating a group', async (missing) => {
    const { songs, source, input, library } = await generation();
    await expect(songs.generate(ADMIN, missing === 'source' ? 'missing' : source.stamp.id, {
      ...input,
      ...(missing === 'source-revision' ? { songRevision: 99 } : {}),
      ...(missing === 'layout' ? { slideLayoutId: 'missing' } : {}),
      ...(missing === 'layout-revision' ? { slideLayoutRevision: 99 } : {}),
      ...(missing === 'group' ? { slideGroupId: 'missing' } : {}),
    })).rejects.toMatchObject({ kind: 'state' });
    expect(await library.list(ADMIN, { kind: 'slideGroup' })).toEqual([]);
  });

  it.each([
    box('sermon-title', { mode: 'keyed', contentKind: 'sermon', contentKey: 'title', languageKey: TA }),
    keyed('missing-language', 'lyricLine', 'en'),
  ])('refuses unresolvable keyed boxes ($id)', async (binding) => {
    const { songs, source, input, library } = await generation({ boxes: [binding] });
    await expect(songs.generate(ADMIN, source.stamp.id, input)).rejects.toMatchObject({ kind: 'state' });
    expect(await library.list(ADMIN, { kind: 'slideGroup' })).toEqual([]);
  });

  it('refuses missing bound metadata before writing', async () => {
    const { songs, source, input, library } = await generation();
    const minimal = await songs.edit(ADMIN, source.stamp.id, { ...SONG_WITH_META, metadata: undefined });
    await expect(songs.generate(ADMIN, source.stamp.id, { ...input, songRevision: minimal!.revision })).rejects.toMatchObject({ kind: 'state' });
    expect(await library.list(ADMIN, { kind: 'slideGroup' })).toEqual([]);
  });

  it('does not overwrite a custom group or another song’s generated group', async () => {
    const { songs, source, input, groups } = await generation();
    const generated = await songs.generate(ADMIN, source.stamp.id, input);
    const custom = await groups.duplicate(ADMIN, generated.stamp.id);
    await expect(songs.generate(ADMIN, source.stamp.id, { ...input, slideGroupId: custom!.stamp.id })).rejects.toMatchObject({ kind: 'state' });
    const other = await songs.create(ADMIN, 'Other song', SONG_WITH_META);
    await expect(songs.generate(ADMIN, other.stamp.id, { ...input, slideGroupId: generated.stamp.id })).rejects.toMatchObject({ kind: 'state' });
    expect((await groups.current(ADMIN, generated.stamp.id))?.body).toEqual(generated.body);
  });
});

describe('a stamp with no configuration is corrupt, not missing', () => {
  it('refuses reading a song whose revision was never written', async () => {
    const { db, songs } = store();
    const created = await songs.create(ADMIN, 'Paadal', SONG);
    db.rows.set(REVISIONS, []);
    const error = await refused(songs.current(ADMIN, created.stamp.id));
    expect(error.kind).toBe('corrupt');
    expect(error.message).toContain(created.stamp.id);
  });

  it('refuses a stored configuration this build cannot read, rather than serving it', async () => {
    const { db, songs } = store();
    const created = await songs.create(ADMIN, 'Paadal', SONG);
    const [revision] = rows(db, REVISIONS);
    const body = { titles: { tamil: 'பாடல்' } };
    db.rows.set(REVISIONS, [{ ...revision, body, hash: addressOf(body) }]);
    const error = await refused(songs.current(ADMIN, created.stamp.id));
    expect(error.kind).toBe('corrupt');
    expect(error.message).toContain('song.titles.romanized');
  });
});
