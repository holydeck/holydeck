import { BOOK_ALIASES } from './internal/book-aliases.js';
import { asArray, asNumber, asObject, asString } from './internal/json.js';
import { HolyDeckError } from './messages.js';

export interface LocalizedText {
  text: string;
  html?: string;
}

export interface TranslationLanguage {
  iso6391?: string;
  iso6393: string;
  name: string;
  localName: string;
  textDirection: string;
  languageTag: string;
}

export interface TranslationPublisher {
  id?: number;
  name: string;
  url?: string;
}

export interface TranslationMeta {
  id: number;
  abbreviation: string;
  localAbbreviation: string;
  title: string;
  localTitle: string;
  language: TranslationLanguage;
  copyrightShort?: LocalizedText;
  copyrightLong?: LocalizedText;
  readerFooter?: LocalizedText;
  readerFooterUrl?: string;
  publisher?: TranslationPublisher;
  metadataBuild: number;
  versification?: string;
}

export interface CanonChapter {
  id: string;
  label: string;
}

export interface CanonBook {
  usfm: string;
  canon: string;
  name: string;
  longName?: string;
  abbreviation?: string;
  chapters: CanonChapter[];
}

export interface Canon {
  books: CanonBook[];
}

export function parseVersionMeta(payload: unknown): { meta: TranslationMeta; canon: Canon } {
  const root = asObject(payload);
  const id = root === undefined ? undefined : asNumber(root.id);
  const abbreviation = root === undefined ? undefined : asString(root.abbreviation);
  const books = root === undefined ? undefined : asArray(root.books);
  if (root === undefined || id === undefined || abbreviation === undefined || books === undefined) {
    throw new HolyDeckError('version_meta_invalid', { reason: 'missing id, abbreviation or books' });
  }
  const language = asObject(root.language) ?? {};
  const meta: TranslationMeta = {
    id,
    abbreviation,
    localAbbreviation: asString(root.local_abbreviation) ?? abbreviation,
    title: asString(root.title) ?? abbreviation,
    localTitle: asString(root.local_title) ?? asString(root.title) ?? abbreviation,
    language: {
      iso6391: asString(language.iso_639_1),
      iso6393: asString(language.iso_639_3) ?? '',
      name: asString(language.name) ?? '',
      localName: asString(language.local_name) ?? asString(language.name) ?? '',
      textDirection: asString(language.text_direction) ?? 'ltr',
      languageTag: asString(language.language_tag) ?? '',
    },
    copyrightShort: localizedText(root.copyright_short),
    copyrightLong: localizedText(root.copyright_long),
    readerFooter: localizedText(root.reader_footer),
    readerFooterUrl: asString(root.reader_footer_url),
    publisher: publisherOf(root.publisher),
    metadataBuild: asNumber(root.metadata_build) ?? 0,
    versification: asString(root.vrs),
  };
  const canonBooks: CanonBook[] = [];
  for (const rawBook of books) {
    const book = asObject(rawBook);
    if (book === undefined || book.text === false) continue;
    const usfm = asString(book.usfm);
    if (usfm === undefined) continue;
    const chapters: CanonChapter[] = [];
    for (const rawChapter of asArray(book.chapters) ?? []) {
      const chapter = asObject(rawChapter);
      if (chapter === undefined || chapter.canonical !== true) continue;
      const chapterUsfm = asString(chapter.usfm);
      const chapterId = chapterUsfm?.split('.')[1];
      if (chapterId === undefined || chapterId === '') continue;
      chapters.push({ id: chapterId, label: asString(chapter.human) ?? chapterId });
    }
    canonBooks.push({
      usfm,
      canon: asString(book.canon) ?? 'ot',
      name: asString(book.human) ?? usfm,
      longName: asString(book.human_long),
      abbreviation: asString(book.abbreviation),
      chapters,
    });
  }
  if (canonBooks.length === 0) {
    throw new HolyDeckError('version_meta_invalid', { reason: 'no readable books in payload' });
  }
  return { meta, canon: { books: canonBooks } };
}

function localizedText(value: unknown): LocalizedText | undefined {
  const obj = asObject(value);
  const text = obj === undefined ? undefined : asString(obj.text);
  if (obj === undefined || text === undefined) return undefined;
  const html = asString(obj.html);
  return html !== undefined && html !== text ? { text, html } : { text };
}

function publisherOf(value: unknown): TranslationPublisher | undefined {
  const obj = asObject(value);
  const name = obj === undefined ? undefined : asString(obj.name);
  if (obj === undefined || name === undefined) return undefined;
  return { id: asNumber(obj.id), name, url: asString(obj.url) };
}

type BundledBook = [usfm: string, name: string, chapterCount: number, canon: 'ot' | 'nt'];

const PROTESTANT_CANON: BundledBook[] = [
  ['GEN', 'Genesis', 50, 'ot'], ['EXO', 'Exodus', 40, 'ot'], ['LEV', 'Leviticus', 27, 'ot'],
  ['NUM', 'Numbers', 36, 'ot'], ['DEU', 'Deuteronomy', 34, 'ot'], ['JOS', 'Joshua', 24, 'ot'],
  ['JDG', 'Judges', 21, 'ot'], ['RUT', 'Ruth', 4, 'ot'], ['1SA', '1 Samuel', 31, 'ot'],
  ['2SA', '2 Samuel', 24, 'ot'], ['1KI', '1 Kings', 22, 'ot'], ['2KI', '2 Kings', 25, 'ot'],
  ['1CH', '1 Chronicles', 29, 'ot'], ['2CH', '2 Chronicles', 36, 'ot'], ['EZR', 'Ezra', 10, 'ot'],
  ['NEH', 'Nehemiah', 13, 'ot'], ['EST', 'Esther', 10, 'ot'], ['JOB', 'Job', 42, 'ot'],
  ['PSA', 'Psalms', 150, 'ot'], ['PRO', 'Proverbs', 31, 'ot'], ['ECC', 'Ecclesiastes', 12, 'ot'],
  ['SNG', 'Song of Solomon', 8, 'ot'], ['ISA', 'Isaiah', 66, 'ot'], ['JER', 'Jeremiah', 52, 'ot'],
  ['LAM', 'Lamentations', 5, 'ot'], ['EZK', 'Ezekiel', 48, 'ot'], ['DAN', 'Daniel', 12, 'ot'],
  ['HOS', 'Hosea', 14, 'ot'], ['JOL', 'Joel', 3, 'ot'], ['AMO', 'Amos', 9, 'ot'],
  ['OBA', 'Obadiah', 1, 'ot'], ['JON', 'Jonah', 4, 'ot'], ['MIC', 'Micah', 7, 'ot'],
  ['NAM', 'Nahum', 3, 'ot'], ['HAB', 'Habakkuk', 3, 'ot'], ['ZEP', 'Zephaniah', 3, 'ot'],
  ['HAG', 'Haggai', 2, 'ot'], ['ZEC', 'Zechariah', 14, 'ot'], ['MAL', 'Malachi', 4, 'ot'],
  ['MAT', 'Matthew', 28, 'nt'], ['MRK', 'Mark', 16, 'nt'], ['LUK', 'Luke', 24, 'nt'],
  ['JHN', 'John', 21, 'nt'], ['ACT', 'Acts', 28, 'nt'], ['ROM', 'Romans', 16, 'nt'],
  ['1CO', '1 Corinthians', 16, 'nt'], ['2CO', '2 Corinthians', 13, 'nt'], ['GAL', 'Galatians', 6, 'nt'],
  ['EPH', 'Ephesians', 6, 'nt'], ['PHP', 'Philippians', 4, 'nt'], ['COL', 'Colossians', 4, 'nt'],
  ['1TH', '1 Thessalonians', 5, 'nt'], ['2TH', '2 Thessalonians', 3, 'nt'], ['1TI', '1 Timothy', 6, 'nt'],
  ['2TI', '2 Timothy', 4, 'nt'], ['TIT', 'Titus', 3, 'nt'], ['PHM', 'Philemon', 1, 'nt'],
  ['HEB', 'Hebrews', 13, 'nt'], ['JAS', 'James', 5, 'nt'], ['1PE', '1 Peter', 5, 'nt'],
  ['2PE', '2 Peter', 3, 'nt'], ['1JN', '1 John', 5, 'nt'], ['2JN', '2 John', 1, 'nt'],
  ['3JN', '3 John', 1, 'nt'], ['JUD', 'Jude', 1, 'nt'], ['REV', 'Revelation', 22, 'nt'],
];

export function bundledCanon(): Canon {
  return {
    books: PROTESTANT_CANON.map(([usfm, name, chapterCount, canon]) => ({
      usfm,
      canon,
      name,
      chapters: Array.from({ length: chapterCount }, (_, index) => ({
        id: String(index + 1),
        label: String(index + 1),
      })),
    })),
  };
}

export function findBook(canon: Canon, usfm: string): CanonBook | undefined {
  return canon.books.find((book) => book.usfm === usfm.toUpperCase());
}

const USFM_PATTERN = /^([1-3][A-Z]{2}|[A-Z]{3})$/;

/** Ordinals as people write them, so "2nd Samuel", "2. Samuel" and "II Samuel" all agree. */
const ORDINALS: Record<string, string> = {
  '1st': '1', first: '1', i: '1',
  '2nd': '2', second: '2', ii: '2',
  '3rd': '3', third: '3', iii: '3',
};

/** Accents on a Latin letter only, so "Römer" also answers to "Romer" and Tamil vowel signs stay. */
const LATIN_ACCENTS = /(?<=\p{Script=Latin})\p{M}+/gu;

/** "2nd Samuel", "II  Samuel." and "1. Samuel" alike become "2samuel"/"1samuel": one key per book. */
function nameKey(input: string): string {
  const tokens = input
    .toLowerCase()
    .normalize('NFD')
    .replace(LATIN_ACCENTS, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== '');
  const first = tokens[0];
  if (first !== undefined) tokens[0] = ORDINALS[first] ?? first;
  return tokens.join('');
}

let nameIndex: Map<string, string> | undefined;

function bookNames(): Map<string, string> {
  if (nameIndex === undefined) {
    nameIndex = new Map();
    for (const [usfm, name] of PROTESTANT_CANON) nameIndex.set(nameKey(name), usfm);
    for (const [usfm, ...names] of BOOK_ALIASES) {
      for (const name of names) nameIndex.set(nameKey(name), usfm);
    }
  }
  return nameIndex;
}

/**
 * Turns whatever names a book — a USFM code, or a name in any language BOOK_ALIASES knows —
 * into the USFM code the datastore is keyed by. Unknown three-letter codes pass through, as they
 * always have; a name that matches nothing returns undefined.
 */
export function resolveBook(input: string): string | undefined {
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();
  if (USFM_PATTERN.test(upper)) return upper;
  return bookNames().get(nameKey(trimmed));
}
