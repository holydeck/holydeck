import { parse } from 'yaml';
import { resolveBook } from './canon.js';
import { asArray, asNumber, asObject, asString } from './internal/json.js';
import { HolyDeckError, formatMessage } from './messages.js';
import { parseVerseList } from './references.js';
import type { JsonObject } from './internal/json.js';

export interface SermonEntry {
  book: string;
  chapter: number;
  verses: number[];
  offsets: Record<string, number>;
}

export interface SermonFile {
  translations: string[];
  template?: string;
  entries: SermonEntry[];
  notices: string[];
}

export function parseSermonFile(text: string): SermonFile {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new HolyDeckError('sermon_invalid', { reason: `not valid YAML (${(error as Error).message})` });
  }
  const root = asObject(raw);
  if (root === undefined) {
    throw new HolyDeckError('sermon_invalid', { reason: 'expected a YAML mapping at the top level' });
  }
  return root.version !== undefined && root.translations === undefined
    ? parseLegacySermon(root)
    : parseModernSermon(root);
}

function parseModernSermon(root: JsonObject): SermonFile {
  const translations = parseTranslationList(root.translations, 'translations');
  let template: string | undefined;
  if (root.template !== undefined) {
    template = asString(root.template);
    if (template === undefined) throw new HolyDeckError('sermon_invalid', { reason: '"template" must be a string' });
  }
  const notices: string[] = [];
  const entries = parseEntryList(root.verses).map((item, index) => {
    const entry = parseEntryCore(item, index);
    const offsets: Record<string, number> = {};
    if (item.offsets !== undefined) {
      const offsetsObj = asObject(item.offsets);
      if (offsetsObj === undefined) {
        throw new HolyDeckError('sermon_invalid', {
          reason: `"verses[${index}].offsets" must be a mapping of translation to offset`,
        });
      }
      for (const [abbr, value] of Object.entries(offsetsObj)) {
        const offset = asNumber(value);
        if (offset === undefined || !Number.isInteger(offset)) {
          throw new HolyDeckError('sermon_invalid', { reason: `"verses[${index}].offsets.${abbr}" must be an integer` });
        }
        const upper = abbr.toUpperCase();
        if (!translations.includes(upper)) {
          throw new HolyDeckError('sermon_invalid', {
            reason: `"verses[${index}].offsets.${abbr}" names a translation that is not in "translations"`,
          });
        }
        offsets[upper] = offset;
      }
    }
    return { ...entry, offsets };
  });
  const sermon: SermonFile = { translations, entries, notices };
  if (template !== undefined) sermon.template = template;
  return sermon;
}

function parseLegacySermon(root: JsonObject): SermonFile {
  const notices: string[] = [formatMessage('legacy_sermon_format')];
  const translations = parseTranslationList(root.version, 'version');
  const entries = parseEntryList(root.verses).map((item, index) => {
    const entry = parseEntryCore(item, index);
    const offsets: Record<string, number> = {};
    const options = asObject(item.options);
    if (options !== undefined) {
      for (const [abbr, value] of Object.entries(options)) {
        const offset = asNumber(asObject(value)?.verseOffset);
        if (offset !== undefined && Number.isInteger(offset) && offset !== 0) {
          offsets[abbr.toUpperCase()] = offset;
        }
      }
    }
    if (item.force !== undefined) {
      notices.push(formatMessage('legacy_force_ignored', { reference: `${entry.book} ${entry.chapter}` }));
    }
    return { ...entry, offsets };
  });
  return { translations, entries, notices };
}

function parseTranslationList(value: unknown, key: string): string[] {
  const list = asArray(value);
  if (list === undefined || list.length === 0) {
    throw new HolyDeckError('sermon_invalid', {
      reason: `"${key}" must be a non-empty list of translation abbreviations`,
    });
  }
  return list.map((item, index) => {
    const abbr = asString(item);
    if (abbr === undefined || abbr.trim() === '') {
      throw new HolyDeckError('sermon_invalid', { reason: `"${key}[${index}]" must be a string` });
    }
    return abbr.trim().toUpperCase();
  });
}

function parseEntryList(value: unknown): JsonObject[] {
  const list = asArray(value);
  if (list === undefined || list.length === 0) {
    throw new HolyDeckError('sermon_invalid', { reason: '"verses" must be a non-empty list' });
  }
  return list.map((item, index) => {
    const obj = asObject(item);
    if (obj === undefined) throw new HolyDeckError('sermon_invalid', { reason: `"verses[${index}]" must be a mapping` });
    return obj;
  });
}

function parseEntryCore(item: JsonObject, index: number): { book: string; chapter: number; verses: number[] } {
  const named = asString(item.book);
  const book = named === undefined ? undefined : resolveBook(named);
  if (book === undefined) {
    throw new HolyDeckError('sermon_invalid', {
      reason: `"verses[${index}].book" must be a USFM code (e.g. GEN, PSA, 1SA) or a book name (e.g. "2nd Samuel", "1. Mose")`,
    });
  }
  const chapter = asNumber(item.chapter);
  if (chapter === undefined || !Number.isInteger(chapter) || chapter < 1) {
    throw new HolyDeckError('sermon_invalid', { reason: `"verses[${index}].chapter" must be a positive integer` });
  }
  if (typeof item.verses !== 'string' && typeof item.verses !== 'number') {
    throw new HolyDeckError('sermon_invalid', { reason: `"verses[${index}].verses" must be a verse list like "1-4,7"` });
  }
  let verses: number[];
  try {
    verses = parseVerseList(item.verses);
  } catch {
    throw new HolyDeckError('sermon_invalid', { reason: `"verses[${index}].verses" is not a valid verse list` });
  }
  return { book, chapter, verses };
}
