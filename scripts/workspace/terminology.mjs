// The terminology census. The glossary calls one word out by name: "template" alone is ambiguous and must
// not appear in product copy or requirements — what is meant is either a Slide Layout (reusable box
// geometry) or a Service Template (a reusable order of service). The two are different things, and a file
// that says only "template" has already lost the distinction a reader needs.
//
// This is a guard on the files that are written to the rule, not a repository-wide sweep: it grades the
// list below and nothing else, so a file joins the rule by being added here on the task that writes it.
// A retroactive sweep would fail on files nobody has reviewed against the glossary yet, and a census that
// fails for reasons nobody owns is a census that gets switched off.
//
// The match is a case-insensitive substring rather than a whole word, because the bare noun does most of
// its damage inside an identifier — `layoutTemplateId`, `TEMPLATES`, `template_id` — and a whole-word
// match would read every one of those as something else. The one exception is the compound itself:
// "template" directly after "service", with or without a separator between them, is the allowed term.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { fromRepoRoot } from './pipeline.mjs';

/** Every file held to the glossary's terminology. Add a file here on the task that writes it. */
export const GUARDED_FILES = [
  'apps/app/src/slide-layout-routes.test.ts',
  'apps/app/src/slide-layout-routes.ts',
  'apps/app/src/slide-layouts.test.ts',
  'apps/app/src/slide-layouts.ts',
  'packages/contracts/src/layouts.test.ts',
  'packages/contracts/src/layouts.ts',
];

/** The bare noun, anywhere in a word, unless "service" is what comes directly before it. */
const BARE_NOUN = /(?<!service[ \t_-]?)template/giu;

export const CORRECTION = 'the term is Slide Layout or Service Template, never the bare noun';

/** Every line of the source that says the bare noun, with the column it says it at. */
export function bareNounsIn(text) {
  const found = [];
  const lines = text.split('\n');
  for (const [at, line] of lines.entries()) {
    for (const match of line.matchAll(BARE_NOUN)) {
      found.push({ line: at + 1, column: match.index + 1, said: match[0] });
    }
  }
  return found;
}

/** Grades the census. `sources` is keyed by repository-relative file path. */
export function verifyTerminology({ sources }) {
  const problems = [];
  for (const file of GUARDED_FILES) {
    const text = sources[file];
    // A guarded file that is not there is a file that was renamed out from under the rule, which is
    // exactly the way a guard stops guarding without anybody noticing.
    if (text === undefined) {
      problems.push(`${file}: is held to the glossary and was not found`);
      continue;
    }
    for (const said of bareNounsIn(text)) {
      problems.push(`${file}:${said.line}:${said.column}: says "${said.said}", and ${CORRECTION}`);
    }
  }
  return problems;
}

export function readRepo() {
  const sources = {};
  for (const file of GUARDED_FILES) {
    try {
      sources[file] = readFileSync(fromRepoRoot(file), 'utf8');
    } catch {
      continue;
    }
  }
  return { sources };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = verifyTerminology(readRepo());
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}
