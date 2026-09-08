import { load } from 'cheerio';
import { HolyDeckError } from './messages.js';
import type { VerseMap } from './storage.js';

export function sanitizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\u00A0\u2007\u2009\u200A\u202F]/g, ' ')
    // eslint-disable-next-line no-misleading-character-class -- distinct zero-width code points to strip, not a joined sequence
    .replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function chapterUrl(translationId: number, abbr: string, book: string, chapter: string): string {
  return `https://www.bible.com/bible/${translationId}/${book}.${chapter}.${abbr}`;
}

export function versionUrl(translationId: number): string {
  return `https://www.bible.com/api/bible/version/${translationId}`;
}

export function isChallengePage(html: string): boolean {
  return html.includes('_fs-ch-') || /<title>\s*Client Challenge\s*<\/title>/i.test(html);
}

export interface ParsedChapter {
  verses: VerseMap;
  canonVerseCount: number;
}

export function parseChapterHtml(html: string, book: string, chapter: string, url = ''): ParsedChapter {
  if (isChallengePage(html)) throw new HolyDeckError('scrape_blocked');
  const $ = load(html);
  const prefix = `${book}.${chapter}.`;
  const fragments = new Map<number, string[]>();
  $('span[data-usfm]').each((_, element) => {
    const $fragment = $(element);
    if (!($fragment.attr('class') ?? '').includes('__verse')) return;
    let text = '';
    $fragment.find('span').each((_, child) => {
      const $child = $(child);
      if (!($child.attr('class') ?? '').includes('__content')) return;
      if ($child.parentsUntil($fragment, '[class*="__note"], [class*="__x"]').length > 0) return;
      text += $child.text();
    });
    // v8 ignore next -- selected via `span[data-usfm]`, so the attribute is always present
    for (const usfm of ($fragment.attr('data-usfm') ?? '').split('+')) {
      if (!usfm.startsWith(prefix)) continue;
      const verseNumber = Number(usfm.slice(prefix.length));
      if (!Number.isInteger(verseNumber) || verseNumber < 1) continue;
      const list = fragments.get(verseNumber) ?? [];
      list.push(text);
      fragments.set(verseNumber, list);
    }
  });
  if (fragments.size === 0) throw new HolyDeckError('scrape_parse_failed', { url });
  const verses: VerseMap = {};
  let canonVerseCount = 0;
  for (const [verseNumber, parts] of fragments) {
    verses[String(verseNumber)] = sanitizeText(parts.join(' '));
    if (verseNumber > canonVerseCount) canonVerseCount = verseNumber;
  }
  return { verses, canonVerseCount };
}
