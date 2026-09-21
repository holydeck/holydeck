import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LEGAL_RECORD_FILE, readLegalRecord, verifyLegalGate } from './legal-gate.mjs';

const accepted = (overrides = {}) => ({
  topic: 'license-transition',
  status: 'accepted',
  reviewer: 'Maintainer',
  date: '2026-09-17',
  role: 'Maintainer decided alone — no counsel retained',
  evidenceLink: 'legal/decisions.md#license-transition',
  unresolvedQuestions: [],
  ...overrides,
});

test('no record at all blocks the release', () => {
  assert.deepEqual(verifyLegalGate(undefined), [
    `${LEGAL_RECORD_FILE} was not found: no legal decision is recorded in this repository, and a release with none recorded cannot proceed`,
  ]);
});

test('a record with no legalDecisions array is reported', () => {
  assert.deepEqual(verifyLegalGate({}), [`${LEGAL_RECORD_FILE} has no legalDecisions array`]);
});

test('an empty legalDecisions array has nothing to report', () => {
  assert.deepEqual(verifyLegalGate({ legalDecisions: [] }), []);
});

test('every decision accepted, with counsel language and no open questions, blocks nothing', () => {
  assert.deepEqual(verifyLegalGate({ legalDecisions: [accepted()] }), []);
});

test('accepts an honest "no counsel retained" record, the same as real counsel', () => {
  assert.deepEqual(
    verifyLegalGate({ legalDecisions: [accepted({ role: 'Reviewed with outside counsel' })] }),
    [],
  );
});

test('a proposed decision blocks the release, by topic', () => {
  const decisions = [accepted(), accepted({ topic: 'song-lyrics', status: 'proposed' })];
  assert.deepEqual(verifyLegalGate({ legalDecisions: decisions }), [
    'song-lyrics: status is "proposed", must be "accepted" before release',
  ]);
});

test('a missing status is reported as null, not silently accepted', () => {
  const decision = accepted({ status: undefined });
  assert.deepEqual(verifyLegalGate({ legalDecisions: [decision] }), [
    'license-transition: status is null, must be "accepted" before release',
  ]);
});

test('an accepted decision with no reviewer is reported', () => {
  assert.deepEqual(verifyLegalGate({ legalDecisions: [accepted({ reviewer: 'pending' })] }), [
    'license-transition: accepted with no reviewer recorded',
  ]);
});

test('an accepted decision with no date is reported', () => {
  assert.deepEqual(verifyLegalGate({ legalDecisions: [accepted({ date: null })] }), [
    'license-transition: accepted with no date recorded',
  ]);
});

test('an accepted decision with no evidence link is reported', () => {
  assert.deepEqual(verifyLegalGate({ legalDecisions: [accepted({ evidenceLink: '' })] }), [
    'license-transition: accepted with no evidenceLink recorded',
  ]);
});

test('an accepted decision whose role never says the word counsel is reported', () => {
  assert.deepEqual(verifyLegalGate({ legalDecisions: [accepted({ role: 'Maintainer' })] }), [
    'license-transition: accepted role "Maintainer" does not say whether counsel was retained',
  ]);
});

test('an accepted decision with unresolved questions left open is reported', () => {
  const decision = accepted({ unresolvedQuestions: ['is the mark registrable?'] });
  assert.deepEqual(verifyLegalGate({ legalDecisions: [decision] }), [
    'license-transition: accepted with 1 unresolved question(s) still open',
  ]);
});

test('every problem on one decision is reported, not just the first', () => {
  const decision = accepted({ reviewer: 'pending', date: null, evidenceLink: '', role: 'Maintainer' });
  assert.deepEqual(verifyLegalGate({ legalDecisions: [decision] }), [
    'license-transition: accepted with no reviewer recorded',
    'license-transition: accepted with no date recorded',
    'license-transition: accepted with no evidenceLink recorded',
    'license-transition: accepted role "Maintainer" does not say whether counsel was retained',
  ]);
});

test('an untitled decision is still reported, under a placeholder name', () => {
  assert.deepEqual(verifyLegalGate({ legalDecisions: [{ status: 'proposed' }] }), [
    '(untitled decision): status is "proposed", must be "accepted" before release',
  ]);
});

// This repository has not promoted T11's legal decision record into the public tree yet — the human
// approval and counsel review that record needs is a standing gate this script enforces, not one it can
// close itself. This documents today's real, correct, fail-closed state: a release cut right now is
// blocked, on purpose, until a maintainer records and accepts every decision here.
test('this repository has no legal decision record yet, so a release is correctly blocked', () => {
  assert.equal(readLegalRecord(), undefined);
});
