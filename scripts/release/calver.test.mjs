import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CALVER_PATTERN, nextCalver, nextPrerelease } from './calver.mjs';

const at = (iso) => new Date(iso);

test('first release of a month starts at patch 0', () => {
  assert.equal(nextCalver('2026.8.4', at('2026-09-03T10:00:00Z')), '2026.9.0');
});

test('a release within the same month increments the patch', () => {
  assert.equal(nextCalver('2026.9.0', at('2026-09-20T10:00:00Z')), '2026.9.1');
});

test('the month is unpadded', () => {
  assert.equal(nextCalver('2026.1.0', at('2026-01-15T10:00:00Z')), '2026.1.1');
});

test('year rollover starts the new year at month.0', () => {
  assert.equal(nextCalver('2026.12.7', at('2027-01-01T00:30:00Z')), '2027.1.0');
});

test('a v-prefixed latest version is accepted', () => {
  assert.equal(nextCalver('v2026.9.2', at('2026-09-21T10:00:00Z')), '2026.9.3');
});

test('non-calver history (the 0.0.0 placeholder) starts a fresh month', () => {
  assert.equal(nextCalver('0.0.0', at('2026-09-08T10:00:00Z')), '2026.9.0');
});

test('a missing latest version starts a fresh month', () => {
  assert.equal(nextCalver(undefined, at('2026-09-08T10:00:00Z')), '2026.9.0');
});

test('the boundary is UTC: late local time past a UTC month change rolls over', () => {
  assert.equal(nextCalver('2026.9.5', at('2026-10-01T01:30:00Z')), '2026.10.0');
});

test('CALVER_PATTERN accepts a calver version with or without a prerelease suffix', () => {
  assert.ok(CALVER_PATTERN.test('2026.10.0'));
  assert.ok(CALVER_PATTERN.test('2026.10.0-next.2'));
});

test('CALVER_PATTERN rejects a prerelease suffix with no digits', () => {
  assert.ok(!CALVER_PATTERN.test('2026.10.0-next'));
  assert.ok(!CALVER_PATTERN.test('2026.10.0-next.'));
  assert.ok(!CALVER_PATTERN.test('2026.10.0-next.abc'));
});

test('no existing prerelease starts at .1 on the next stable base', () => {
  assert.equal(nextPrerelease('2026.9.2', undefined, at('2026-09-21T10:00:00Z')), '2026.9.3-next.1');
});

test('an existing prerelease on the same base increments the prerelease number', () => {
  assert.equal(nextPrerelease('2026.9.2', '2026.9.3-next.1', at('2026-09-21T10:00:00Z')), '2026.9.3-next.2');
});

test('an existing prerelease on an older base resets to .1 on the new base', () => {
  assert.equal(nextPrerelease('2026.9.5', '2026.9.3-next.4', at('2026-10-01T01:30:00Z')), '2026.10.0-next.1');
});

test('a v-prefixed latest prerelease is accepted', () => {
  assert.equal(nextPrerelease('2026.9.2', 'v2026.9.3-next.1', at('2026-09-21T10:00:00Z')), '2026.9.3-next.2');
});
