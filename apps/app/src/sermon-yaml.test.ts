import { describe, expect, it } from 'vitest';

import { CONTENT_LANGUAGES } from '@holydeck/contracts/content-languages';
import { FIELD_CODES } from '@holydeck/contracts/problems';
import { parseSermonFile } from '@holydeck/core/sermon';

import { SERMON_PATH } from './sermon-body.js';
import { YAML_SYNTAX, sermonFromYaml, sermonToYaml } from './sermon-yaml.js';

import type { SermonBody } from './sermon-body.js';

const [TAMIL, ROMANIZED_TAMIL] = CONTENT_LANGUAGES;

const TA = TAMIL!.key;

const TA_LATN = ROMANIZED_TAMIL!.key;

const BODY: SermonBody = {
  sermon: parseSermonFile(`translations: [TAM, ROM]
verses:
  - {book: PSA, chapter: 117, verses: 2, offsets: {ROM: 1}}
  - {book: PSA, chapter: 117, verses: 1}
`),
  languages: {
    [TA]: { translation: 'TAM', title: 'நன்றி', speaker: 'பேச்சாளர்', points: ['இரக்கம்', 'துதி'] },
    [TA_LATN]: { translation: 'ROM', title: 'Nandri', speaker: 'Speaker', points: ['Kindness', 'Praise'] },
  },
};

// Written out by hand so every line number a refusal names can be counted by eye. The stored shape is the
// one `parseSermonBody` reads: `entries`, not the `verses` shorthand a sermon file is typed in.
const lines = (chapter: string): readonly string[] => [
  'sermon:',
  '  translations: [TAM]',
  '  entries:',
  '    - book: PSA',
  `      chapter: ${chapter}`,
  '      verses: [2]',
  '      offsets: {}',
  '  notices: []',
  'languages:',
  `  ${TA}:`,
  '    translation: TAM',
  '    title: நன்றி',
  '',
];

const RAW = lines('117').join('\n');

const read = (text: string): readonly { path: string; code: string; at?: unknown }[] => {
  const parsed = sermonFromYaml(text);
  if (parsed.ok) throw new Error('the text was read as a sermon');
  return parsed.problems.map((problem) => ({ path: problem.path, code: problem.code, at: problem.at }));
};

describe('a sermon as the text somebody edits', () => {
  it('writes a sermon and reads back exactly the sermon it wrote', () => {
    const text = sermonToYaml(BODY);
    expect(sermonFromYaml(text)).toEqual({ ok: true, value: BODY });
  });

  it('reads a sermon somebody typed themselves', () => {
    const parsed = sermonFromYaml(RAW);
    expect(parsed.ok && parsed.value.sermon.entries).toEqual([
      { book: 'PSA', chapter: 117, verses: [2], offsets: {} },
    ]);
    expect(parsed.ok && parsed.value.languages[TA]).toEqual({ translation: 'TAM', title: 'நன்றி' });
  });
});

describe('switching from raw to visual mid-edit', () => {
  it('keeps every typed change, having no rules the visual surface would not also keep', () => {
    const retyped = sermonToYaml(BODY).replace('Nandri', 'Nandri (retyped)');
    const switched = sermonFromYaml(retyped);
    expect(switched.ok && switched.value.languages[TA_LATN]?.title).toBe('Nandri (retyped)');
    // Everything else the person typed survives the switch untouched.
    expect(switched.ok && switched.value.sermon.entries).toEqual(BODY.sermon.entries);
  });

  it('refuses the switch explicitly on a broken edit, rather than silently discarding it', () => {
    const broken = sermonToYaml(BODY).replace('chapter: 117', 'chapter: -1');
    const switched = sermonFromYaml(broken);
    expect(switched.ok).toBe(false);
    // Refused, not silently converted to an empty or partial visual configuration.
    expect(switched.ok || switched.problems).not.toEqual([]);
  });
});

describe('text that is not a sermon, and where it is wrong', () => {
  it('names the line and column of text YAML itself cannot read', () => {
    const tabbed = ['sermon:', '\ttranslations: [TAM]', ''].join('\n');
    expect(read(tabbed)).toEqual([{ path: SERMON_PATH, code: YAML_SYNTAX, at: { line: 2, column: 1 } }]);
  });

  it('names the line of an invalid entry field deep in the sermon file, not the start of the file', () => {
    const problems = read(lines('0').join('\n'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ path: `${SERMON_PATH}.sermon.entries.0.chapter`, code: 'sermon.invalid' });
    expect((problems[0]!.at as { line: number }).line).toBe(5);
  });

  it('points at the mapping a required language field is missing from', () => {
    const missing = [...lines('117')];
    missing[10] = ''; // drops the "translation: TAM" line, leaving a language with no translation
    const problems = read(missing.join('\n'));
    expect(problems).toEqual([
      { path: `${SERMON_PATH}.languages.${TA}`, code: 'sermon.language_invalid', at: { line: 12, column: 5 } },
    ]);
  });

  it('refuses an empty document without inventing a place in it', () => {
    expect(read('')).toEqual([{ path: SERMON_PATH, code: FIELD_CODES.notAnObject, at: undefined }]);
  });

  it('refuses text that parses into something that is not a sermon at all', () => {
    expect(read('- a list of nothing\n')).toEqual([
      { path: SERMON_PATH, code: FIELD_CODES.notAnObject, at: { line: 1, column: 1 } },
    ]);
  });
});
