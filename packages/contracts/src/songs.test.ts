import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical.js';
import { CONTENT_LANGUAGES } from './content-languages.js';
import { CONTENT_KEYS } from './layouts.js';
import { FIELD_CODES } from './problems.js';
import {
  METADATA_KEYS,
  SMALLEST_REPEAT,
  SONG_PORTABLE,
  SONG_SCHEMA_VERSION,
  SONG_SOURCES,
  TITLE_LANGUAGE_KEYS,
  exportSong,
  importSong,
  parseLyricSection,
  parseSongBody,
  parseSongMetadata,
  parseSongProvenance,
} from './songs.js';

import type { LyricSection, SongBody } from './songs.js';

// The registry names Tamil first and Romanized Tamil second — spec §11.5's stated default for a song.
// Read off the registry rather than typed here, the same way `slide-groups.test.ts` reads its own.
const [TAMIL, ROMANIZED_TAMIL] = CONTENT_LANGUAGES;

const TA = TAMIL!.key;

const TA_LATN = ROMANIZED_TAMIL!.key;

// Synthetic words throughout: nothing in this repository's fixtures is anybody's licensed lyric.
const VERSE: LyricSection = {
  id: 'verse-1',
  label: 'Verse 1',
  text: [
    { languageKey: TA, text: 'முதல் வரி' },
    { languageKey: TA_LATN, text: 'Muthal vari' },
  ],
};

const CHORUS: LyricSection = {
  id: 'chorus',
  label: 'Chorus',
  repeat: { count: SMALLEST_REPEAT },
  text: [
    { languageKey: TA, text: 'பல்லவி' },
    { languageKey: TA_LATN, text: 'Pallavi' },
  ],
};

const SONG: SongBody = {
  titles: { tamil: 'பாடல்', romanized: 'Paadal' },
  languages: [TA, TA_LATN],
  sections: [VERSE, CHORUS],
  provenance: { source: 'manual' },
  metadata: { author: 'Anbu', copyright: 'Public domain' },
};

const IMPORTED: SongBody = {
  ...SONG,
  provenance: {
    source: 'import',
    importer: 'powerpoint',
    importedAt: '2026-09-17T09:30:00Z',
    reference: 'sunday-set.pptx',
    importId: 'import-7',
  },
};

const song = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...SONG, ...over });

const problemsOf = (value: unknown): readonly string[] => {
  const parsed = parseSongBody(value);
  return parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}: ${problem.code}`);
};

describe('reading one song configuration', () => {
  it('round-trips every field a finished song carries', () => {
    expect(parseSongBody(SONG)).toEqual({ ok: true, value: SONG });
  });

  it('round-trips an imported song’s provenance, reference and import run alike', () => {
    expect(parseSongBody(IMPORTED)).toEqual({ ok: true, value: IMPORTED });
  });

  it('accepts a draft nobody has finished: no title, no language, no section', () => {
    const draft = {
      titles: { tamil: '', romanized: '' },
      languages: [],
      sections: [],
      provenance: { source: 'manual' },
    };
    expect(parseSongBody(draft)).toEqual({ ok: true, value: draft });
  });

  it('accepts a section a translator has not reached yet, which is unfinished rather than malformed', () => {
    const half = song({ sections: [{ ...VERSE, text: [{ languageKey: TA, text: '' }] }] });
    expect(problemsOf(half)).toEqual([]);
  });

  it('refuses anything that is not an object at all', () => {
    expect(problemsOf('a song')).toEqual(['song: field.not_an_object']);
  });

  it('reports every missing field at once, one problem each', () => {
    expect(problemsOf({})).toEqual([
      'song.titles: field.required',
      'song.languages: field.required',
      'song.sections: field.required',
      'song.provenance: field.required',
    ]);
  });

  it('names the two titles §12.4 asks for, each against the registry key it is written in', () => {
    expect(TITLE_LANGUAGE_KEYS).toEqual({ tamil: TA, romanized: TA_LATN });
    expect(problemsOf(song({ titles: { tamil: 7, romanized: 'Paadal' } }))).toEqual([
      'song.titles.tamil: field.not_text',
    ]);
    expect(problemsOf(song({ titles: { romanized: 'Paadal' } }))).toEqual(['song.titles.tamil: field.required']);
  });
});

describe('the languages a song declares', () => {
  it('refuses a key the content-language registry does not carry', () => {
    expect(problemsOf(song({ languages: [TA, 'kl-Nope'], sections: [] }))).toEqual([
      'song.languages.1: field.not_allowed',
    ]);
  });

  it('refuses the same language declared twice', () => {
    expect(problemsOf(song({ languages: [TA, TA_LATN, TA], sections: [] }))).toEqual([
      'song.languages.2: field.not_allowed',
    ]);
  });

  it('refuses a section saying something in a language the song never declared', () => {
    const parsed = parseSongBody(song({ languages: [TA] }));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems).toEqual([
      {
        path: 'song.sections.0.text.1.languageKey',
        code: FIELD_CODES.notAllowed,
        message: 'must name one of the languages this song declares',
      },
      {
        path: 'song.sections.1.text.1.languageKey',
        code: FIELD_CODES.notAllowed,
        message: 'must name one of the languages this song declares',
      },
    ]);
  });

  it('refuses a languages field that is not a list, and says nothing about the lines it cannot judge', () => {
    expect(problemsOf(song({ languages: TA }))).toEqual(['song.languages: field.not_a_list']);
  });

  it('refuses a language that is not text, and still says nothing about the lines it cannot judge', () => {
    expect(problemsOf(song({ languages: [TA, 7] }))).toEqual(['song.languages.1: field.not_text']);
  });

  it('refuses a text with no language key at all, and says nothing further about the key', () => {
    const section = { ...VERSE, text: [{ text: 'Muthal vari' }] };
    expect(problemsOf(song({ sections: [section] }))).toEqual(['song.sections.0.text.0.languageKey: field.required']);
  });

  it('refuses a language key the registry does not carry before asking whether the song declared it', () => {
    const section = { ...VERSE, text: [{ languageKey: 'kl-Nope', text: 'x' }] };
    expect(problemsOf(song({ sections: [section] }))).toEqual(['song.sections.0.text.0.languageKey: field.not_allowed']);
  });
});

describe('the ordered sections a song is sung in', () => {
  it('keeps the order it was written in, because reordering sections changes the song', () => {
    const reversed = parseSongBody(song({ sections: [CHORUS, VERSE] }));
    expect(reversed.ok && reversed.value.sections.map((section) => section.id)).toEqual(['chorus', 'verse-1']);
  });

  it('refuses two sections under one identifier', () => {
    expect(problemsOf(song({ sections: [VERSE, { ...CHORUS, id: VERSE.id }] }))).toEqual([
      'song.sections.1.id: field.not_allowed',
    ]);
  });

  it('refuses a section that says itself twice in one language', () => {
    const doubled = { ...VERSE, text: [...VERSE.text, { languageKey: TA, text: 'again' }] };
    expect(problemsOf(song({ sections: [doubled] }))).toEqual(['song.sections.0.text: field.not_allowed']);
  });

  it('refuses a section with no identifier, and reads its label as a draft may leave it', () => {
    expect(parseLyricSection({ label: '', text: [] }, 'section')).toEqual({
      ok: false,
      problems: [{ path: 'section.id', code: FIELD_CODES.required, message: 'is required' }],
    });
  });
});

describe('the repeat count on a section', () => {
  it('round-trips a count of two, the smallest repeat there is', () => {
    const parsed = parseSongBody(SONG);
    expect(parsed.ok && parsed.value.sections[1]?.repeat).toEqual({ count: 2 });
  });

  it('refuses a repeat of one, which says nothing at all', () => {
    const once = { ...CHORUS, repeat: { count: 1 } };
    expect(problemsOf(song({ sections: [once] }))).toEqual(['song.sections.0.repeat.count: field.too_small']);
  });

  it('refuses a count that is not a whole number of performances', () => {
    const half = { ...CHORUS, repeat: { count: 2.5 } };
    expect(problemsOf(song({ sections: [half] }))).toEqual([
      'song.sections.0.repeat.count: field.not_a_whole_number',
    ]);
  });
});

describe('the metadata a song accepts', () => {
  it('accepts exactly the keys a Slide Layout can bind a song’s metadata to', () => {
    for (const key of METADATA_KEYS) expect(CONTENT_KEYS.song).toContain(key);
  });

  it('refuses a key outside that list, rather than dropping it in silence', () => {
    expect(problemsOf(song({ metadata: { author: 'Anbu', tempo: 120 } }))).toEqual([
      'song.metadata.tempo: field.not_allowed',
    ]);
  });

  it('refuses a metadata field that is present and says nothing', () => {
    expect(problemsOf(song({ metadata: { author: '', copyright: '' } }))).toEqual([
      'song.metadata.author: field.empty',
      'song.metadata.copyright: field.empty',
    ]);
  });

  it('refuses metadata that is not an object, and accepts a song carrying none', () => {
    expect(parseSongMetadata([], 'song.metadata')).toEqual({
      ok: false,
      problems: [{ path: 'song.metadata', code: FIELD_CODES.notAnObject, message: 'must be an object' }],
    });
    const { metadata, ...bare } = SONG;
    expect(metadata).toBeDefined();
    expect(parseSongBody(bare)).toEqual({ ok: true, value: bare });
  });
});

describe('where a song’s content came from', () => {
  it('names the two sources content arrives by', () => {
    expect([...SONG_SOURCES]).toEqual(['manual', 'import']);
  });

  it('refuses a song entered by hand that describes an import anyway', () => {
    const muddled = { source: 'manual', importer: 'powerpoint', importedAt: '2026-09-17T09:30:00Z' };
    expect(problemsOf(song({ provenance: muddled }))).toEqual([
      'song.provenance.importer: field.not_allowed',
      'song.provenance.importedAt: field.not_allowed',
    ]);
  });

  it('asks an import what produced it and when', () => {
    expect(problemsOf(song({ provenance: { source: 'import' } }))).toEqual([
      'song.provenance.importer: field.required',
      'song.provenance.importedAt: field.required',
    ]);
  });

  it('refuses an import stamped with something that is not an instant', () => {
    const vague = { source: 'import', importer: 'powerpoint', importedAt: 'last Sunday' };
    expect(problemsOf(song({ provenance: vague }))).toEqual(['song.provenance.importedAt: field.not_a_time']);
  });

  it('refuses a present but empty reference or import run', () => {
    const blank = { ...IMPORTED.provenance, reference: '', importId: '' };
    expect(problemsOf(song({ provenance: blank }))).toEqual([
      'song.provenance.reference: field.empty',
      'song.provenance.importId: field.empty',
    ]);
  });

  it('refuses a source this build has never heard of, and asks nothing further of it', () => {
    expect(parseSongProvenance({ source: 'divination', importer: 'x' }, 'song.provenance')).toEqual({
      ok: false,
      problems: [
        {
          path: 'song.provenance.source',
          code: FIELD_CODES.notAllowed,
          message: 'must be one of manual, import',
        },
      ],
    });
  });
});

describe('a song as bytes that travel', () => {
  it('declares the song kind at the version this build writes', () => {
    expect(SONG_PORTABLE).toMatchObject({ kind: 'song', schemaVersion: SONG_SCHEMA_VERSION, steps: [] });
  });

  it('exports the same bytes every time for a song nothing changed', () => {
    expect(exportSong(SONG)).toBe(exportSong(SONG));
  });

  it('exports the same bytes for a song whose fields were written in another order', () => {
    const shuffled: SongBody = {
      metadata: SONG.metadata,
      provenance: SONG.provenance,
      sections: SONG.sections,
      languages: SONG.languages,
      titles: { romanized: SONG.titles.romanized, tamil: SONG.titles.tamil },
    };
    expect(exportSong(shuffled)).toBe(exportSong(SONG));
    expect(canonicalJson(shuffled)).toBe(canonicalJson(SONG));
  });

  it('imports what it exported, and re-exports it to the same bytes', () => {
    const text = exportSong(IMPORTED);
    const imported = importSong(text);
    expect(imported).toEqual({ ok: true, value: IMPORTED });
    expect(imported.ok && exportSong(imported.value)).toBe(text);
  });

  it('keeps the section order an export was written in', () => {
    const reordered: SongBody = { ...SONG, sections: [CHORUS, VERSE] };
    expect(exportSong(reordered)).not.toBe(exportSong(SONG));
    const imported = importSong(exportSong(reordered));
    expect(imported.ok && imported.value.sections.map((section) => section.id)).toEqual(['chorus', 'verse-1']);
  });

  it('refuses bytes that are not a portable document at all', () => {
    const parsed = importSong('not a document');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.map((problem) => problem.path)).toEqual(['document']);
  });

  it('refuses a document of another kind, and a song a newer build wrote', () => {
    const wrongKind = importSong(
      JSON.stringify({ format: 'holydeck.portable', formatVersion: 1, kind: 'slideLayout', schemaVersion: 1, body: SONG }),
    );
    expect(!wrongKind.ok && wrongKind.problems.map((problem) => problem.path)).toEqual(['document.kind']);

    const newer = importSong(
      JSON.stringify({ format: 'holydeck.portable', formatVersion: 1, kind: 'song', schemaVersion: 2, body: SONG }),
    );
    expect(!newer.ok && newer.problems.map((problem) => problem.path)).toEqual(['document.schemaVersion']);
  });

  it('refuses a document whose body is not a song, reporting where in the song it is wrong', () => {
    const text = exportSong({ ...SONG, languages: [] });
    const parsed = importSong(text);
    expect(!parsed.ok && parsed.problems.map((problem) => problem.path)).toEqual([
      'song.sections.0.text.0.languageKey',
      'song.sections.0.text.1.languageKey',
      'song.sections.1.text.0.languageKey',
      'song.sections.1.text.1.languageKey',
    ]);
  });
});
