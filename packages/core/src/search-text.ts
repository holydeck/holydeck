// Tamil / Romanized-Tamil text folding for the command palette (spec SRCH-01): so a query typed in
// either variant matches text stored in the same variant despite differing Unicode representations —
// NFC vs NFD-decomposed Tamil script, or case/diacritic differences in Romanized Tamil.
//
// This is Unicode/case folding only, not a phonetic transliteration engine: it never maps a Romanized
// spelling onto its Tamil-script equivalent, or back, because the two are not textually close enough
// for folding to relate them. `pptx-content.ts`'s `splitScriptRuns` already draws the same line for a
// different purpose — classifying which script a run is written in says nothing about spelling
// equivalence across scripts.

const TAMIL_SCRIPT = /\p{Script=Tamil}/u;

/**
 * Folds text for same-script, cross-representation matching. Text containing at least one
 * Tamil-script character is NFC-normalized only, so combining marks a keyboard or an import path
 * assembled differently still compare equal. Everything else is folded as Romanized text:
 * NFD-decomposed, stripped of combining marks, and lowercased, so "Amma", "amma" and an accented
 * spelling all compare equal. Applying this to both the query and the candidate text is what makes
 * the comparison symmetric.
 */
export function foldSearchText(text: string): string {
  if (TAMIL_SCRIPT.test(text)) return text.normalize('NFC');
  return text
    .normalize('NFD')
    .replace(/\p{Mark}/gu, '')
    .toLowerCase();
}

/**
 * Word/phrase matching primitives shared by `search.ts` (Scripture text) and `palette.ts` (the
 * command palette): both split a folded text into words on the same non-letter/number boundary,
 * and score a match the same way — a phrase found together beats the same words scattered. Kept
 * here, not duplicated, so the two never drift apart.
 */

export const NOT_A_WORD = /[^\p{L}\p{N}]+/u;

/** How many times the query's words appear together, in the order they were written. */
export function phraseCount(words: readonly string[], query: readonly string[]): number {
  let count = 0;
  for (let start = 0; start + query.length <= words.length; start += 1) {
    if (query.every((word, index) => words[start + index] === word)) count += 1;
  }
  return count;
}

/** How often the query's words appear anywhere in the text, or none at all when one of them is missing. */
export function scatteredCount(words: readonly string[], query: readonly string[]): number {
  let total = 0;
  for (const word of new Set(query)) {
    const found = words.filter((candidate) => candidate === word).length;
    if (found === 0) return 0;
    total += found;
  }
  return total;
}
