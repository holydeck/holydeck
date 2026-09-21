// Release-time enforcement of T11's legal-decision record: a release must not ship while any legal
// decision — license transition, contributor consent, bible display, song lyrics, mark protection, and
// the rest — remains unaccepted. Writing and approving that record is a maintainer-with-counsel decision
// this script never makes; it only reads legal/index.json and refuses to let a release proceed while what
// it finds disagrees with what a release requires. A repository with no legal/index.json at all has
// recorded nothing, which blocks a release exactly as a repository where every decision is still
// "proposed" would — the absence of the file is not a pass.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { fromRepoRoot } from '../workspace/pipeline.mjs';

export const LEGAL_RECORD_FILE = 'legal/index.json';

/**
 * Grades one legal-decision record (the parsed contents of legal/index.json, or undefined when the file
 * does not exist). Every decision must be accepted, with a reviewer, a date, an evidence link, no open
 * questions, and a role that says outright whether counsel was retained — "no counsel retained" is as
 * valid an answer here as naming real counsel, as long as it is the honest one.
 */
export function verifyLegalGate(record) {
  if (record === undefined) {
    return [
      `${LEGAL_RECORD_FILE} was not found: no legal decision is recorded in this repository, and a release with none recorded cannot proceed`,
    ];
  }
  if (!Array.isArray(record.legalDecisions)) {
    return [`${LEGAL_RECORD_FILE} has no legalDecisions array`];
  }

  const problems = [];
  for (const decision of record.legalDecisions) {
    const topic = decision.topic ?? '(untitled decision)';
    if (decision.status !== 'accepted') {
      problems.push(`${topic}: status is ${JSON.stringify(decision.status ?? null)}, must be "accepted" before release`);
      continue;
    }
    if (!decision.reviewer || decision.reviewer === 'pending') {
      problems.push(`${topic}: accepted with no reviewer recorded`);
    }
    if (!decision.date) {
      problems.push(`${topic}: accepted with no date recorded`);
    }
    if (!decision.evidenceLink) {
      problems.push(`${topic}: accepted with no evidenceLink recorded`);
    }
    if (!/counsel/iu.test(decision.role ?? '')) {
      problems.push(`${topic}: accepted role "${decision.role ?? ''}" does not say whether counsel was retained`);
    }
    const unresolved = Array.isArray(decision.unresolvedQuestions) ? decision.unresolvedQuestions : [];
    if (unresolved.length > 0) {
      problems.push(`${topic}: accepted with ${unresolved.length} unresolved question(s) still open`);
    }
  }
  return problems;
}

/** Reads legal/index.json from the repository root, or returns undefined when it does not exist. */
export function readLegalRecord() {
  try {
    return JSON.parse(readFileSync(fromRepoRoot(LEGAL_RECORD_FILE), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function main() {
  const problems = verifyLegalGate(readLegalRecord());
  if (problems.length > 0) {
    for (const problem of problems) console.error(`legal-gate: ${problem}`);
    process.exit(1);
  }
  console.log('legal-gate: every recorded legal decision is accepted');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
