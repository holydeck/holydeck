// The one overclaim T108 refuses to let this repository make: nothing shipped with the deployment may
// promise "zero downtime." A planned restart interrupts live sessions briefly and a run resumes from
// persisted state once the app is back (see runs.ts's resume, and MAINTENANCE.md) — a real guarantee, and
// a different one than "zero downtime," which this deployment does not make. Reuses exposure-scan.mjs's
// own sweep rather than keeping a second list of what "shipped" means: the same files that must not name
// real infrastructure must not make this claim either.

import { pathToFileURL } from 'node:url';

import { readRepo } from '../workspace/exposure-scan.mjs';

// Matches "zero-downtime" and "zero downtime", either way, case-insensitively — the only two ways this
// claim is actually written in English.
const CLAIM = /zero[\s-]downtime/giu;

/** Every place a piece of text makes the claim, with where it says it. */
export function zeroDowntimeClaimsIn(text) {
  const found = [];
  const lines = text.split('\n');
  for (const [at, line] of lines.entries()) {
    for (const match of line.matchAll(CLAIM)) {
      found.push({ line: at + 1, column: match.index + 1, said: match[0] });
    }
  }
  return found;
}

/** Grades the review. `documents` and `sources` are each keyed by repository-relative file path. */
export function verifyNoZeroDowntimeClaim({ documents, sources }) {
  const problems = [];
  for (const file of Object.keys(documents).sort()) {
    for (const found of zeroDowntimeClaimsIn(documents[file])) {
      problems.push(`${file}:${found.line}:${found.column}: claims "${found.said}", which this deployment does not guarantee`);
    }
  }
  for (const file of Object.keys(sources).sort()) {
    for (const found of zeroDowntimeClaimsIn(sources[file])) {
      problems.push(`${file}:${found.line}:${found.column}: claims "${found.said}", which this deployment does not guarantee`);
    }
  }
  return problems;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = verifyNoZeroDowntimeClaim(readRepo());
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}
