import { resolveBook } from './canon.js';
import { HolyDeckError } from './messages.js';

export interface Reference {
  book: string;
  chapter: number;
  verses: number[];
}

export function parseVerseList(input: string | number): number[] {
  const raw = String(input).trim();
  if (raw === '') throw new HolyDeckError('invalid_verse_list', { input: raw });
  const verses: number[] = [];
  for (const token of raw.split(',')) {
    const part = token.trim();
    const single = /^(\d+)$/.exec(part);
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (single) {
      verses.push(toVerseNumber(single[1]!, raw));
    } else if (range) {
      const from = toVerseNumber(range[1]!, raw);
      const to = toVerseNumber(range[2]!, raw);
      if (from > to) throw new HolyDeckError('invalid_verse_list', { input: raw });
      for (let verse = from; verse <= to; verse += 1) verses.push(verse);
    } else {
      throw new HolyDeckError('invalid_verse_list', { input: raw });
    }
  }
  return verses;
}

function toVerseNumber(digits: string, input: string): number {
  const value = Number(digits);
  if (value < 1 || value > 999) throw new HolyDeckError('invalid_verse_list', { input });
  return value;
}

export function formatVerseList(verses: number[]): string {
  const parts: string[] = [];
  let index = 0;
  while (index < verses.length) {
    let end = index;
    while (end + 1 < verses.length && verses[end + 1] === verses[end]! + 1) end += 1;
    parts.push(end > index ? `${verses[index]}-${verses[end]}` : String(verses[index]));
    index = end + 1;
  }
  return parts.join(',');
}

export function parseReference(input: string): Reference {
  // Split on the colon and walk back over the chapter digits rather than matching a book name
  // with a lazy pattern: a name is free text, and "<anything> <digits>" backtracks on a string
  // of spaces long enough to matter.
  const trimmed = input.trim();
  const colon = trimmed.indexOf(':');
  const head = colon === -1 ? '' : trimmed.slice(0, colon);
  let digits = head.length;
  while (digits > 0 && head[digits - 1]! >= '0' && head[digits - 1]! <= '9') digits -= 1;
  const chapterText = head.slice(digits);
  const bookText = head.slice(0, digits).trimEnd();
  const rest = trimmed.slice(colon + 1);
  const separated = digits > bookText.length;
  const valid = colon !== -1 && chapterText !== '' && bookText !== '' && separated && /^\S/.test(rest);
  const book = valid ? resolveBook(bookText) : undefined;
  if (book === undefined) throw new HolyDeckError('invalid_reference', { input });
  const chapter = Number(chapterText);
  if (chapter < 1 || chapter > 150) throw new HolyDeckError('invalid_reference', { input });
  let verses: number[];
  try {
    verses = parseVerseList(rest);
  } catch {
    throw new HolyDeckError('invalid_reference', { input });
  }
  return { book, chapter, verses };
}
