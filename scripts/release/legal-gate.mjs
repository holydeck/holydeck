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

// Governs whether a `next`-channel release may ever substitute a recorded prerelease exemption for full
// legal acceptance. Fixed at 'full' here: a maintainer ruling to allow 'prerelease-exemption' is a legal
// decision this script does not make for itself, so flipping it is a deliberate, separate commit, never
// something a release argument alone can trigger.
export const NEXT_CHANNEL_POLICY = 'full';

/**
 * A prerelease exemption is a maintainer-granted, time-boxed substitute for full legal acceptance on the
 * `next` channel only — never on stable. Every field must be present and the grant must not have expired;
 * this only checks shape and expiry, never the signature's cryptographic validity (a workflow-level
 * concern, see legal-gate's module comment).
 */
function exemptionValid(record, channel, now) {
  const exemption = record?.prereleaseExemption;
  if (exemption === undefined) return false;
  if (exemption.channel !== channel) return false;
  if (typeof exemption.grantedBy !== 'string' || exemption.grantedBy === '') return false;
  if (typeof exemption.scope !== 'string' || exemption.scope === '') return false;
  if (typeof exemption.signature !== 'string' || exemption.signature === '') return false;
  const expiresAt = new Date(exemption.expiresAt ?? '');
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * Grades one legal-decision record (the parsed contents of legal/index.json, or undefined when the file
 * does not exist). Every decision must be accepted, with a reviewer, a date, an evidence link, no open
 * questions, and a role that says outright whether counsel was retained — "no counsel retained" is as
 * valid an answer here as naming real counsel, as long as it is the honest one.
 *
 * `channel` and `policy` only ever relax anything on `next`, and only when `policy` is explicitly
 * `'prerelease-exemption'` — the default `policy` (the `NEXT_CHANNEL_POLICY` constant) keeps `next`
 * exactly as strict as `stable`.
 */
export function verifyLegalGate(record, { channel = 'stable', policy = NEXT_CHANNEL_POLICY, now = new Date() } = {}) {
  if (channel === 'next' && policy === 'prerelease-exemption' && exemptionValid(record, channel, now)) {
    return [];
  }
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
  const channel = process.argv[2] ?? 'stable';
  const problems = verifyLegalGate(readLegalRecord(), { channel });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`legal-gate: ${problem}`);
    process.exit(1);
  }
  console.log(`legal-gate: every recorded legal decision is accepted (channel: ${channel})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
