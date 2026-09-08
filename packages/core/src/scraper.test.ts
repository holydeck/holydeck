import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HolyDeckError } from './messages.js';
import { chapterUrl, isChallengePage, parseChapterHtml, sanitizeText, versionUrl } from './scraper.js';

const psa117 = readFileSync(new URL('../test/fixtures/kjv-psa117.html', import.meta.url), 'utf8');
const gen1 = readFileSync(new URL('../test/fixtures/kjv-gen1.html', import.meta.url), 'utf8');
const synthetic = readFileSync(new URL('../test/fixtures/synthetic-chapter.html', import.meta.url), 'utf8');

describe('sanitizeText', () => {
  it('normalizes whitespace exotica', () => {
    expect(sanitizeText('a\u00A0b\u2009c\u202Fd')).toBe('a b c d');
    expect(sanitizeText('s\u200Bo\u00ADf\uFEFFt\u200C\u200D')).toBe('soft');
    expect(sanitizeText('  a \n\t b  ')).toBe('a b');
  });
});

describe('urls', () => {
  it('builds chapter and version urls', () => {
    expect(chapterUrl(157, 'SCH2000', 'PSA', '4')).toBe('https://www.bible.com/bible/157/PSA.4.SCH2000');
    expect(versionUrl(157)).toBe('https://www.bible.com/api/bible/version/157');
  });
});

describe('isChallengePage', () => {
  it('detects the bot-protection challenge markers', () => {
    expect(isChallengePage('<html><head><title>Client Challenge</title></head></html>')).toBe(true);
    expect(isChallengePage('<script src="/_fs-ch-xyz/challenge.js"></script>')).toBe(true);
    expect(isChallengePage(psa117)).toBe(false);
  });
});

describe('parseChapterHtml on real KJV fixtures', () => {
  it('parses PSA 117 exactly (poetry fragments joined with one space)', () => {
    const { verses, canonVerseCount } = parseChapterHtml(psa117, 'PSA', '117');
    expect(canonVerseCount).toBe(2);
    expect(verses['1']).toBe('O praise the LORD, All ye nations: Praise him, all ye people.');
    expect(verses['2']).toBe(
      'For his merciful kindness is great toward us: And the truth of the LORD endureth for ever. Praise ye the LORD.',
    );
  });

  it('parses GEN 1 (prose) with all 31 verses', () => {
    const { verses, canonVerseCount } = parseChapterHtml(gen1, 'GEN', '1');
    expect(canonVerseCount).toBe(31);
    expect(Object.keys(verses)).toHaveLength(31);
    expect(verses['1']).toBe('In the beginning God created the heaven and the earth.');
    expect(verses['31']).toBe(
      'And God saw every thing that he had made, and, behold, it was very good. And the evening and the morning were the sixth day.',
    );
  });
});

describe('parseChapterHtml on the synthetic fixture', () => {
  const { verses, canonVerseCount } = parseChapterHtml(synthetic, 'TST', '4');

  it('keeps the superscription as verse 1', () => {
    expect(verses['1']).toBe('To the chief musician. A test song.');
  });

  it('excludes footnote and cross-reference content and joins fragments', () => {
    expect(verses['2']).toBe('Answer me when I call, O God of my rightness.');
  });

  it('assigns merged data-usfm text to every listed verse', () => {
    expect(verses['3']).toBe('Two verses merged into one text.');
    expect(verses['4']).toBe('Two verses merged into one text.');
    expect(canonVerseCount).toBe(4);
  });

  it('ignores verses of other books/chapters', () => {
    expect(Object.keys(verses)).toEqual(['1', '2', '3', '4']);
  });
});

describe('parseChapterHtml error paths', () => {
  it('throws scrape_blocked on a challenge page', () => {
    try {
      parseChapterHtml('<title>Client Challenge</title>', 'PSA', '117', 'https://x');
      expect.unreachable();
    } catch (error) {
      expect((error as HolyDeckError).code).toBe('scrape_blocked');
    }
  });

  it('throws scrape_parse_failed when no verse spans exist', () => {
    try {
      parseChapterHtml('<html><body><p>nothing here</p></body></html>', 'PSA', '117', 'https://x');
      expect.unreachable();
    } catch (error) {
      expect((error as HolyDeckError).code).toBe('scrape_parse_failed');
      expect((error as HolyDeckError).params.url).toBe('https://x');
    }
  });

  it('throws scrape_parse_failed when verse spans exist only for other chapters', () => {
    try {
      parseChapterHtml(synthetic, 'TST', '5');
      expect.unreachable();
    } catch (error) {
      expect((error as HolyDeckError).code).toBe('scrape_parse_failed');
    }
  });
});

describe('parseChapterHtml edge cases', () => {
  const coverageHtml = `
    <div class="Cov__d">
      <span data-usfm="TST.9.1">no class attribute at all, must be skipped as a non-verse span</span>
      <span class="Cov__verse" data-usfm="TST.9.2">
        <span>classless child span text that must not leak</span>
        <span class="Cov__content">Verse two content.</span>
      </span>
      <span class="Cov__verse" data-usfm="TST.9.abc">
        <span class="Cov__content">invalid verse number, must be skipped</span>
      </span>
      <span class="Cov__verse" data-usfm="TST.9.5">
        <span class="Cov__content">Verse five content.</span>
      </span>
      <span class="Cov__verse" data-usfm="TST.9.3">
        <span class="Cov__content">Verse three content.</span>
      </span>
    </div>
  `;

  it('skips data-usfm spans with no class attribute and classless content descendants', () => {
    const { verses } = parseChapterHtml(coverageHtml, 'TST', '9');
    expect(verses['1']).toBeUndefined();
    expect(verses['2']).toBe('Verse two content.');
  });

  it('skips a fragment whose data-usfm verse component is not a valid integer', () => {
    const { verses } = parseChapterHtml(coverageHtml, 'TST', '9');
    expect(verses['abc']).toBeUndefined();
    expect(Object.keys(verses).sort()).toEqual(['2', '3', '5']);
  });

  it('computes canonVerseCount correctly when verses are out of numeric order', () => {
    const { canonVerseCount } = parseChapterHtml(coverageHtml, 'TST', '9');
    expect(canonVerseCount).toBe(5);
  });
});
