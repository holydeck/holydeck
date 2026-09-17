import { describe, expect, it } from 'vitest';

import { CONTENT_LANGUAGES } from '@holydeck/contracts/content-languages';
import { FIELD_CODES } from '@holydeck/contracts/problems';
import { parseSongBody } from '@holydeck/contracts/songs';

import { YAML_SYNTAX, songFromYaml, songToYaml } from './song-yaml.js';

import type { SongBody } from '@holydeck/contracts/songs';

const [TAMIL, ROMANIZED_TAMIL] = CONTENT_LANGUAGES;

const TA = TAMIL!.key;

const TA_LATN = ROMANIZED_TAMIL!.key;

// A verse is written on more than one line, which is the whole reason the raw surface is YAML and not JSON.
const VERSE_TA = 'முதல் வரி\nஇரண்டாம் வரி';

const SONG: SongBody = {
  titles: { tamil: 'பாடல்', romanized: 'Paadal' },
  languages: [TA, TA_LATN],
  sections: [
    {
      id: 'verse-1',
      label: 'Verse 1',
      text: [
        { languageKey: TA, text: VERSE_TA },
        { languageKey: TA_LATN, text: 'Muthal vari\nIrandaam vari' },
      ],
    },
    {
      id: 'chorus',
      label: 'Chorus',
      repeat: { count: 2 },
      text: [{ languageKey: TA, text: 'பல்லவி' }],
    },
  ],
  provenance: { source: 'manual' },
  metadata: { author: 'Anbu' },
};

// Written out by hand so every line number a refusal names can be counted by eye. The two language keys
// are read off the registry rather than typed, the way every other fixture in this workspace reads them.
const lines = (repeat: string): readonly string[] => [
  'titles:',
  '  tamil: பாடல்',
  '  romanized: Paadal',
  'languages:',
  `  - ${TA}`,
  `  - ${TA_LATN}`,
  'sections:',
  '  - id: verse-1',
  '    label: Verse 1',
  '    repeat:',
  `      count: ${repeat}`,
  '    text:',
  `      - languageKey: ${TA}`,
  '        text: முதல் வரி',
  'provenance:',
  '  source: manual',
  '',
];

const RAW = lines('2').join('\n');

const read = (text: string): readonly { path: string; code: string; at?: unknown }[] => {
  const parsed = songFromYaml(text);
  if (parsed.ok) throw new Error('the text was read as a song');
  return parsed.problems.map((problem) => ({ path: problem.path, code: problem.code, at: problem.at }));
};

describe('a song as the text somebody edits', () => {
  it('writes a song and reads back exactly the song it wrote', () => {
    const text = songToYaml(SONG);
    expect(songFromYaml(text)).toEqual({ ok: true, value: SONG });
  });

  it('writes the same text every time, and the same text for a song written in another order', () => {
    const shuffled: SongBody = {
      metadata: SONG.metadata,
      provenance: SONG.provenance,
      sections: SONG.sections,
      languages: SONG.languages,
      titles: { romanized: SONG.titles.romanized, tamil: SONG.titles.tamil },
    };
    expect(songToYaml(SONG)).toBe(songToYaml(shuffled));
  });

  it('keeps a verse’s line breaks as line breaks rather than as an escape nobody can read', () => {
    const text = songToYaml(SONG);
    expect(text).toContain('முதல் வரி\n');
    expect(text).not.toContain('\\n');
    const parsed = songFromYaml(text);
    expect(parsed.ok && parsed.value.sections[0]?.text[0]?.text).toBe(VERSE_TA);
  });

  it('reads a song somebody typed themselves, in whatever order they typed it in', () => {
    const parsed = songFromYaml(RAW);
    expect(parsed.ok && parsed.value.sections[1]).toBeUndefined();
    expect(parsed.ok && parsed.value.titles).toEqual({ tamil: 'பாடல்', romanized: 'Paadal' });
    expect(parsed.ok && parsed.value.sections[0]?.repeat).toEqual({ count: 2 });
  });

  it('reads nothing the schema would not accept, having no rules of its own', () => {
    const parsed = songFromYaml(RAW);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parseSongBody(parsed.value).ok).toBe(true);
  });
});

describe('text that is not a song, and where it is wrong', () => {
  it('names the line and column of text YAML itself cannot read', () => {
    const tabbed = ['titles:', '\ttamil: பாடல்', ''].join('\n');
    const problems = read(tabbed);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ path: 'song', code: YAML_SYNTAX, at: { line: 2, column: 1 } });
  });

  it('refuses a key typed twice, which would otherwise lose one of the two in silence', () => {
    const doubled = ['titles:', '  tamil: one', '  tamil: two', ''].join('\n');
    expect(read(doubled)).toEqual([{ path: 'song', code: YAML_SYNTAX, at: { line: 3, column: 3 } }]);
  });

  it('names the line of the field the schema refused, not the start of the file', () => {
    expect(read(lines('1').join('\n'))).toEqual([
      { path: 'song.sections.0.repeat.count', code: FIELD_CODES.tooSmall, at: { line: 11, column: 14 } },
    ]);
  });

  it('names a field deep in a list of sections at the place it is written', () => {
    const wrong = [...lines('2')];
    wrong[12] = '      - languageKey: kl-Nope';
    expect(read(wrong.join('\n'))).toEqual([
      { path: 'song.sections.0.text.0.languageKey', code: FIELD_CODES.notAllowed, at: { line: 13, column: 22 } },
    ]);
  });

  it('points at the mapping a required field is missing from, there being no line of its own to point at', () => {
    const missing = [...lines('2')];
    missing.splice(2, 1);
    expect(read(missing.join('\n'))).toEqual([
      { path: 'song.titles.romanized', code: FIELD_CODES.required, at: { line: 2, column: 3 } },
    ]);
  });

  it('refuses an empty document without inventing a place in it', () => {
    expect(read('')).toEqual([{ path: 'song', code: FIELD_CODES.notAnObject, at: undefined }]);
  });

  it('refuses text that parses into something that is not a song at all', () => {
    expect(read('- a list of nothing\n')).toEqual([
      { path: 'song', code: FIELD_CODES.notAnObject, at: { line: 1, column: 1 } },
    ]);
  });

  it('reports every problem in the text at once, rather than one edit at a time', () => {
    const several = [...lines('1')];
    several[5] = '  - kl-Nope';
    expect(read(several.join('\n')).map((problem) => problem.path)).toEqual([
      'song.languages.1',
      'song.sections.0.repeat.count',
    ]);
  });
});
