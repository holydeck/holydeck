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

const exemption = (overrides = {}) => ({
  channel: 'next',
  grantedBy: 'Maintainer',
  grantedAt: '2026-09-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  scope: 'next channel only',
  signature: 'deadbeef',
  ...overrides,
});

test('a stable-channel call behaves exactly as calling with no options at all', () => {
  const record = { legalDecisions: [accepted()] };
  assert.deepEqual(verifyLegalGate(record, { channel: 'stable' }), verifyLegalGate(record));
});

test('a next-channel release with no record is blocked, same as stable, under the default full policy', () => {
  assert.deepEqual(verifyLegalGate(undefined, { channel: 'next' }), [
    `${LEGAL_RECORD_FILE} was not found: no legal decision is recorded in this repository, and a release with none recorded cannot proceed`,
  ]);
});

test('the prerelease-exemption policy is never active unless a caller explicitly passes it', () => {
  const record = { prereleaseExemption: exemption() };
  assert.deepEqual(verifyLegalGate(record, { channel: 'next' }), [
    `${LEGAL_RECORD_FILE} has no legalDecisions array`,
  ]);
});

test('a valid, unexpired prerelease exemption passes the next channel under the exemption policy', () => {
  const record = { prereleaseExemption: exemption() };
  assert.deepEqual(verifyLegalGate(record, { channel: 'next', policy: 'prerelease-exemption' }), []);
});

test('full acceptance still passes the next channel under the exemption policy, with no exemption at all', () => {
  const record = { legalDecisions: [accepted()] };
  assert.deepEqual(verifyLegalGate(record, { channel: 'next', policy: 'prerelease-exemption' }), []);
});

test('an expired exemption does not pass, even under the exemption policy', () => {
  const record = { prereleaseExemption: exemption({ grantedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-06-01T00:00:00.000Z' }) };
  assert.deepEqual(verifyLegalGate(record, { channel: 'next', policy: 'prerelease-exemption' }), [
    `${LEGAL_RECORD_FILE} has no legalDecisions array`,
  ]);
});

test('an exemption granted for the wrong channel does not pass', () => {
  const record = { prereleaseExemption: exemption({ channel: 'stable' }) };
  assert.deepEqual(verifyLegalGate(record, { channel: 'next', policy: 'prerelease-exemption' }), [
    `${LEGAL_RECORD_FILE} has no legalDecisions array`,
  ]);
});

test('an exemption with no signature does not pass', () => {
  const record = { prereleaseExemption: exemption({ signature: '' }) };
  assert.deepEqual(verifyLegalGate(record, { channel: 'next', policy: 'prerelease-exemption' }), [
    `${LEGAL_RECORD_FILE} has no legalDecisions array`,
  ]);
});

test('an exemption with no scope does not pass', () => {
  const record = { prereleaseExemption: exemption({ scope: '' }) };
  assert.deepEqual(verifyLegalGate(record, { channel: 'next', policy: 'prerelease-exemption' }), [
    `${LEGAL_RECORD_FILE} has no legalDecisions array`,
  ]);
});
