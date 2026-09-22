import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestCalverTag, listVersionTags } from './calver-plugin.mjs';

test('latestCalverTag picks the numerically newest stable tag', () => {
  assert.equal(
    latestCalverTag(['2026.9.0', '2026.10.0', '2026.10.0-next.1'], { prerelease: false }),
    '2026.10.0',
  );
});

test('latestCalverTag separates stable and prerelease tags', () => {
  const tags = ['2026.10.0', '2026.10.0-next.1', '2026.10.0-next.2'];
  assert.equal(latestCalverTag(tags, { prerelease: false }), '2026.10.0');
  assert.equal(latestCalverTag(tags, { prerelease: true }), '2026.10.0-next.2');
});

test('latestCalverTag returns undefined when no matching tag exists', () => {
  assert.equal(latestCalverTag(['not-a-version', '2026.10.0-next.1'], { prerelease: false }), undefined);
});

test('listVersionTags strips prefixes and blank lines', () => {
  const calls = [];
  const exec = (...args) => {
    calls.push(args);
    return 'v2026.9.0\n\nv2026.10.0-next.1\n';
  };

  assert.deepEqual(listVersionTags(exec), ['2026.9.0', '2026.10.0-next.1']);
  assert.deepEqual(calls, [
    [
      'git',
      ['for-each-ref', '--format=%(refname:short)', 'refs/tags/v*'],
      { encoding: 'utf8' },
    ],
  ]);
});
