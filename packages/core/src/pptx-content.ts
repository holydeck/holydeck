// Turning one raw PPTX text block — exactly as `pptx.ts`'s `extractPptx` returns it, unmodified — into
// the two structured readings PPTX-04 asks for on top of that deterministic list: which script each part
// of it is written in, and whether the whole block is nothing but a repeat marker. `extractPptx` itself
// stays pure listing (see its own header, "nothing here interprets what it finds"), so both readings live
// here instead of being folded into it.
//
// Neither function reaches the filesystem or a database, and neither imports `@holydeck/contracts`
// (packages/core stays a dependency-free leaf package, T69 ruling 2): the language keys and repeat-count
// shape this file produces are structurally compatible with `content-languages.ts`'s registry and
// `songs.ts`'s `SectionText`/`SectionRepeat` in spirit — same fields, same meaning — but restated locally
// rather than imported. Adapting these into the real `songs.ts` types when a full `SongBody` gets
// assembled is T71's job, not this file's.

const TAMIL_SCRIPT = /\p{Script=Tamil}/u;
const LATIN_SCRIPT = /\p{Script=Latin}/u;

/** The two script-separated content languages a song's text is read in: `content-languages.ts`'s `ta`
 *  (Tamil script) and `ta-Latn` (Romanized Tamil / Latin script) keys, restated rather than imported. */
export type PptxScriptKey = 'ta' | 'ta-Latn';

/** One maximal run of one script within a raw text block, in the order it appears in the original text. */
export interface PptxTextRun {
  languageKey: PptxScriptKey;
  text: string;
}

type Script = 'ta' | 'latn';

function classify(char: string): Script | undefined {
  if (TAMIL_SCRIPT.test(char)) return 'ta';
  if (LATIN_SCRIPT.test(char)) return 'latn';
  return undefined;
}

const tagFor = (script: Script): PptxScriptKey => (script === 'ta' ? 'ta' : 'ta-Latn');

/**
 * Splits a raw text block into maximal contiguous runs of Tamil script (`ta`) and Latin script
 * (`ta-Latn`), per T69 ruling 3. Every character is tested against `\p{Script=Tamil}` and
 * `\p{Script=Latin}` (the same `\p{Script=…}` mechanism `sermon-ai.ts`'s `LATIN_ACCENTS` already uses,
 * applied here to a different purpose); a script-neutral character — anything matching neither property,
 * not only the whitespace/punctuation/digits the ruling names as examples, but equally a letter from some
 * third script entirely — never starts a run by itself. It attaches to the run already in progress, or,
 * if none has started yet, to whichever run starts next. A boundary exists only where the run in progress
 * meets a character of the other script.
 *
 * Which side a neutral stretch sitting between two DIFFERENT-script runs attaches to is not pinned down
 * by the ruling; this reads it onto the run before it (absorbed into the run in progress as each
 * character is seen) rather than the run after, the same way trailing punctuation in ordinary prose reads
 * with what precedes it — a disclosed judgment call, not a spec-stated rule. A block with no Tamil- or
 * Latin-script character at all — including one written in some other script entirely — comes back as one
 * unsplit run tagged `ta-Latn`, this project's own default/Romanized key (also a disclosed default).
 */
export function splitScriptRuns(text: string): readonly PptxTextRun[] {
  const runs: PptxTextRun[] = [];
  let currentScript: Script | undefined;
  let buffer = '';
  let prefix = '';
  for (const char of text) {
    const script = classify(char);
    if (script === undefined) {
      if (currentScript === undefined) prefix += char;
      else buffer += char;
      continue;
    }
    if (currentScript === undefined) {
      currentScript = script;
      buffer = prefix + char;
      prefix = '';
    } else if (script === currentScript) {
      buffer += char;
    } else {
      runs.push({ languageKey: tagFor(currentScript), text: buffer });
      currentScript = script;
      buffer = char;
    }
  }
  if (currentScript === undefined) return [{ languageKey: 'ta-Latn', text }];
  runs.push({ languageKey: tagFor(currentScript), text: buffer });
  return runs;
}

/** How many times a repeat-marker block, once detected, is performed where it stands — the same shape as
 *  `songs.ts`'s `SectionRepeat`, restated rather than imported (T69 ruling 2). */
export interface PptxRepeatMarker {
  count: number;
}

/** The smallest repeat a marker converts to; mirrors `songs.ts`'s `SMALLEST_REPEAT` and its reasoning —
 *  "a section performed once is a section with nothing to say about it" — restated rather than imported. */
const SMALLEST_REPEAT = 2;

/** T69 ruling 4, pattern one: "x2", "×3", "(x2)", "(×4)". */
const REPEAT_X_PATTERN = /^\(?[x×]\s*(\d+)\)?$/iu;

/** T69 ruling 4, pattern two: "repeat 2", "repeat 2x", "repeat 3 times". */
const REPEAT_WORD_PATTERN = /^repeat\s+(\d+)\s*(x|times)?$/iu;

/**
 * Reads a text block as a repeat marker, per T69 ruling 4: the block's ENTIRE trimmed content — nothing
 * before or after it — must match one of the two patterns above, case-insensitively. A matched count
 * below `SMALLEST_REPEAT` is left as ordinary text (`undefined`), same as no match at all: a section
 * repeated once has nothing to say. Any other repeat-ish phrasing ("repeated twice", "x 2 times") is
 * explicitly out of scope for v1 and also reads as ordinary text — a documented limitation, not a bug to
 * fix by guessing at more patterns.
 */
export function detectRepeatMarker(text: string): PptxRepeatMarker | undefined {
  const trimmed = text.trim();
  const match = REPEAT_X_PATTERN.exec(trimmed) ?? REPEAT_WORD_PATTERN.exec(trimmed);
  if (match === null) return undefined;
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count < SMALLEST_REPEAT) return undefined;
  return { count };
}
