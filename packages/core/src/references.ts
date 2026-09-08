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
  const match = /^([1-3][A-Z]{2}|[A-Z]{3})\s+(\d+):(\S.*)$/.exec(input.trim().toUpperCase());
  if (!match) throw new HolyDeckError('invalid_reference', { input });
  const chapter = Number(match[2]);
  if (chapter < 1 || chapter > 150) throw new HolyDeckError('invalid_reference', { input });
  let verses: number[];
  try {
    verses = parseVerseList(match[3]!);
  } catch {
    throw new HolyDeckError('invalid_reference', { input });
  }
  return { book: match[1]!, chapter, verses };
}
