// What a song is, as one configuration rather than as a pile of slides (spec SONG-01, §12.4). Everything
// a song says about itself lives here — its two canonical titles, the languages it is sung in, its ordered
// labelled sections, what repeats and how often, the little metadata it accepts, and where its content came
// from — and nothing about how any of it is drawn. Geometry belongs to a Slide Layout, and a song that
// carried a copy of one would be a song that stops matching the Layout the moment the Layout is edited.
//
// Three decisions shape the rest of this file.
//
// A draft is allowed to be unfinished. SONG-01 says so outright, and it is what a song looks like for most
// of its life: a title typed in one script and not yet the other, a verse nobody has translated, a section
// an import could not label. So the fields that hold what a person writes are required to be *there* and
// required to be text, and allowed to be empty — this file refuses a song that is malformed, never one that
// is merely incomplete. Which sections are missing which language is a readiness question, asked of a
// finished song by whatever puts it live, not a reason to refuse the save that was about to preserve it.
//
// The song declares its own ordered language list, and every section's text is keyed to it. That is two
// rules rather than one: a key has to name a language the registry in `./content-languages.js` carries, and
// it has to name one *this song* declared. A section carrying text in a language the song never listed is
// not an incomplete song, it is a song that disagrees with itself, and the order the texts are read in is
// the song's own `languages` order rather than an order each section repeats for itself.
//
// A repeat is a count on the section that repeats. The ordinary way a repeat reaches this system is as a
// mark in somebody's slide — a trailing "– 2" the import in §12.3 reads off a `.pptx` — and the whole of
// making it structured is moving the count out of the lyric and onto the section, where a projection can
// act on it. No narrower scope is minted: a repeat of "the last two lines" cannot be stated once for a
// song sung in two scripts, because the line counts of a Tamil verse and its romanization do not have to
// agree, and a field that only means something in one language is a field that lies in the other.

import { isContentLanguageKey } from './content-languages.js';
import { exportText, importText, portableDocument, portableSchema } from './portable.js';
import { FIELD_CODES, type FieldReader, type Parsed, type ParseFn, parseObject } from './problems.js';

/** Where every problem in a song body is reported under, and the root a raw editor locates against. */
export const SONG_PATH = 'song';

/** The version of the portable song file this build writes. Older versions are read by declared steps. */
export const SONG_SCHEMA_VERSION = 1;

/**
 * The two titles §12.4 names, and the registry key each one is the title in. Named against the registry
 * rather than spelled inline, so the day a title's language stops being `ta` there is one place to say so.
 */
export const TITLE_LANGUAGE_KEYS = Object.freeze({ tamil: 'ta', romanized: 'ta-Latn' });

/** A song's canonical titles: the Tamil one, and the romanization people search and announce it by. */
export type SongTitles = {
  readonly tamil: string;
  readonly romanized: string;
};

/** The metadata a song accepts, and the whole of it: §12.4 excludes tempo and reporting fields in v1. */
export const METADATA_KEYS = ['author', 'copyright'] as const;

export type SongMetadata = {
  readonly author?: string;
  readonly copyright?: string;
};

/** The smallest repeat there is. A section performed once is a section with nothing to say about it. */
export const SMALLEST_REPEAT = 2;

/** How many times the section it sits on is performed where it stands. */
export type SectionRepeat = {
  readonly count: number;
};

/** One language's words for one section, keyed to a language the song itself declares. */
export type SectionText = {
  readonly languageKey: string;
  readonly text: string;
};

/**
 * One labelled part of a song, in the order it is sung. The label is free text until a global catalog of
 * section labels exists to grade it against — §12.3 wants an import to label an ambiguous block from such
 * a catalog, and inventing the catalog here would put the vocabulary in the wrong file.
 */
export type LyricSection = {
  readonly id: string;
  readonly label: string;
  readonly repeat?: SectionRepeat;
  readonly text: readonly SectionText[];
};

/** The two ways a song's content arrives: somebody typed it, or something imported it. */
export const SONG_SOURCES = ['manual', 'import'] as const;

export type SongSource = (typeof SONG_SOURCES)[number];

export type ManualProvenance = {
  readonly source: 'manual';
};

/** Where imported content came from, in enough detail for an importer to attach its own record to it. */
export type ImportProvenance = {
  readonly source: 'import';
  /** What produced the content: `powerpoint` for §12.3's import, and whatever else arrives after it. */
  readonly importer: string;
  readonly importedAt: string;
  /** What was imported — a file name, an identifier in another system. Opaque here, on purpose. */
  readonly reference?: string;
  /** The import run this song came out of, for an importer that keeps runs of its own. */
  readonly importId?: string;
};

export type SongProvenance = ManualProvenance | ImportProvenance;

/**
 * The whole of what a song is, and exactly what is appended to its revision history. A type alias rather
 * than an interface, for the reason `SlideLayoutBody` is one: this is handed to the revision store and to
 * the portable writer as a body, both of which take a plain record of unknown values.
 */
export type SongBody = {
  readonly titles: SongTitles;
  /** The languages this song is sung in, in the order every section's text is read in. */
  readonly languages: readonly string[];
  readonly sections: readonly LyricSection[];
  readonly provenance: SongProvenance;
  readonly metadata?: SongMetadata;
};

/**
 * Required to be there and required to be text, and allowed to be empty — the draft rule from the header.
 * `FieldReader.text` refuses an empty string, which is the right rule for a name something is administered
 * under and the wrong one for a verse nobody has written yet.
 */
const draftText = (reader: FieldReader, name: string): string => {
  const raw = reader.present(name);
  if (raw === undefined) return '';
  if (typeof raw !== 'string') {
    reader.reject(name, FIELD_CODES.notText, 'must be text');
    return '';
  }
  return raw;
};

export const parseSongTitles: ParseFn<SongTitles> = (value, path) =>
  parseObject(value, path, (reader) => ({
    tamil: draftText(reader, 'tamil'),
    romanized: draftText(reader, 'romanized'),
  }));

const TITLES_FALLBACK: SongTitles = { tamil: '', romanized: '' };

/**
 * Metadata is read against a closed list, unlike every other object here, and the difference is that every
 * field of it is optional: a mistyped `copyrigt` would be dropped in silence, and a song would lose a line
 * nobody could see it had lost. Elsewhere a mistyped field is caught by the required field it failed to be.
 */
export const parseSongMetadata: ParseFn<SongMetadata> = (value, path) =>
  parseObject(value, path, (reader) => {
    const offered: readonly string[] = METADATA_KEYS;
    for (const key of reader.names) {
      if (!offered.includes(key)) {
        reader.reject(key, FIELD_CODES.notAllowed, `must be one of ${METADATA_KEYS.join(', ')}`);
      }
    }
    const author = reader.optionalText('author');
    if (author === '') reader.reject('author', FIELD_CODES.empty, 'must not be empty');
    const copyright = reader.optionalText('copyright');
    if (copyright === '') reader.reject('copyright', FIELD_CODES.empty, 'must not be empty');
    return {
      ...(author === undefined ? {} : { author }),
      ...(copyright === undefined ? {} : { copyright }),
    };
  });

export const parseSectionRepeat: ParseFn<SectionRepeat> = (value, path) =>
  parseObject(value, path, (reader) => ({ count: reader.wholeNumber('count', SMALLEST_REPEAT) }));

/** Graded against the registry the way `slide-groups.ts` grades a language block's own key. */
const boundLanguageKey = (reader: FieldReader): string => {
  const before = reader.problems.length;
  const key = reader.text('languageKey');
  if (reader.problems.length > before) return key;
  if (!isContentLanguageKey(key)) {
    reader.reject('languageKey', FIELD_CODES.notAllowed, 'must name a language in the content-language registry');
  }
  return key;
};

export const parseSectionText: ParseFn<SectionText> = (value, path) =>
  parseObject(value, path, (reader) => ({
    languageKey: boundLanguageKey(reader),
    text: draftText(reader, 'text'),
  }));

/** The first language two texts of one section share, or nothing when each says something once. */
const repeatedLanguage = (texts: readonly SectionText[]): string | undefined => {
  const seen = new Set<string>();
  for (const text of texts) {
    if (seen.has(text.languageKey)) return text.languageKey;
    seen.add(text.languageKey);
  }
  return undefined;
};

export const parseLyricSection: ParseFn<LyricSection> = (value, path) =>
  parseObject(value, path, (reader) => {
    const id = reader.text('id');
    const label = draftText(reader, 'label');
    const repeat = reader.optionalParsed('repeat', parseSectionRepeat);
    const before = reader.problems.length;
    const text = reader.parsedList('text', parseSectionText);
    // Asked only of a list every text of which was read: "it says this twice" is not worth saying about a
    // list whose other entry was refused a moment ago for not naming a language at all.
    if (reader.problems.length === before) {
      const twice = repeatedLanguage(text);
      if (twice !== undefined) {
        reader.reject('text', FIELD_CODES.notAllowed, `must not say this section twice in ${twice}`);
      }
    }
    return { id, label, ...(repeat === undefined ? {} : { repeat }), text };
  });

const MANUAL: SongProvenance = { source: 'manual' };

/** The fields only an import has. A song somebody typed carrying one of them is a song about nothing. */
const IMPORT_FIELDS = ['importer', 'importedAt', 'reference', 'importId'] as const;

export const parseSongProvenance: ParseFn<SongProvenance> = (value, path) =>
  parseObject(value, path, (reader) => {
    const before = reader.problems.length;
    const source = reader.choice('source', SONG_SOURCES);
    // A source this release does not have is one whose other fields it cannot read either: which of them
    // belong is exactly what the source decides.
    if (reader.problems.length > before) return MANUAL;
    if (source === 'manual') {
      for (const name of IMPORT_FIELDS) {
        reader.absent(name, FIELD_CODES.notAllowed, 'must not describe an import of a song entered by hand');
      }
      return { source };
    }
    const importer = reader.text('importer');
    const importedAt = reader.time('importedAt');
    const reference = reader.optionalText('reference');
    if (reference === '') reader.reject('reference', FIELD_CODES.empty, 'must not be empty');
    const importId = reader.optionalText('importId');
    if (importId === '') reader.reject('importId', FIELD_CODES.empty, 'must not be empty');
    return {
      source,
      importer,
      importedAt,
      ...(reference === undefined ? {} : { reference }),
      ...(importId === undefined ? {} : { importId }),
    };
  });

/** The languages the song is sung in: each one real, and each one declared once. */
const readLanguages = (reader: FieldReader): readonly string[] => {
  const before = reader.problems.length;
  const keys = reader.textList('languages');
  if (reader.problems.length > before) return keys;
  const seen = new Set<string>();
  for (const [index, key] of keys.entries()) {
    if (!isContentLanguageKey(key)) {
      reader.reject(`languages.${index}`, FIELD_CODES.notAllowed, 'must name a language in the content-language registry');
    } else if (seen.has(key)) {
      reader.reject(`languages.${index}`, FIELD_CODES.notAllowed, `must not declare ${key} twice`);
    }
    seen.add(key);
  }
  return keys;
};

/**
 * The sections, and the two rules that are about the song rather than about one section: no two sections
 * share an identifier, and no section says something in a language the song never declared. Both are asked
 * only of sections that were all read, for the reason `layouts.ts` asks its own list rules that way.
 */
const readSections = (reader: FieldReader, languages: readonly string[]): readonly LyricSection[] => {
  const before = reader.problems.length;
  const sections = reader.parsedList('sections', parseLyricSection);
  if (reader.problems.length > before) return sections;
  const seen = new Set<string>();
  for (const [index, section] of sections.entries()) {
    if (seen.has(section.id)) {
      reader.reject(`sections.${index}.id`, FIELD_CODES.notAllowed, `must not name a second section ${section.id}`);
    }
    seen.add(section.id);
    for (const [at, text] of section.text.entries()) {
      if (!languages.includes(text.languageKey)) {
        reader.reject(
          `sections.${index}.text.${at}.languageKey`,
          FIELD_CODES.notAllowed,
          'must name one of the languages this song declares',
        );
      }
    }
  }
  return sections;
};

/** Reads one song configuration, or every reason the value is not one. */
export function parseSongBody(value: unknown): Parsed<SongBody> {
  return parseObject(value, SONG_PATH, (reader) => {
    const titles = reader.parsed('titles', parseSongTitles, TITLES_FALLBACK);
    const languages = readLanguages(reader);
    const sections = readSections(reader, languages);
    const provenance = reader.parsed('provenance', parseSongProvenance, MANUAL);
    const metadata = reader.optionalParsed('metadata', parseSongMetadata);
    return {
      titles,
      languages,
      sections,
      provenance,
      ...(metadata === undefined ? {} : { metadata }),
    };
  });
}

/**
 * How a song travels between one HolyDeck and another. No migration step is declared because no earlier
 * version of this file shape was ever written; a step is added here the first time the shape changes.
 *
 * Nothing is left out of the file: everything a song holds is the song, and the singer and chord
 * relationships §12.4 keeps out of a portable export are relationships this schema does not carry at all.
 */
export const SONG_PORTABLE = portableSchema('song', SONG_SCHEMA_VERSION, []);

/** The bytes a song travels as. Canonical, so an unchanged song exports to the same bytes every time. */
export function exportSong(body: SongBody): string {
  return exportText(portableDocument(SONG_PORTABLE, body));
}

/** Reads those bytes back into a song, or into every reason they are not one this build can import. */
export function importSong(text: string): Parsed<SongBody> {
  const document = importText(text, SONG_PORTABLE);
  return document.ok ? parseSongBody(document.value.body) : document;
}
