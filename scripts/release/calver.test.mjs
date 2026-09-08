import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextCalver } from './calver.mjs';

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
