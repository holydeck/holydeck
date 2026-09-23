import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelOf } from './channel-of.mjs';

test('a stable tag resolves to the stable channel and latest dist-tag', () => {
  assert.deepEqual(channelOf('v2026.10.0'), {
    channel: 'stable',
    distTag: 'latest',
    prerelease: false,
    version: '2026.10.0',
  });
});

test('a next prerelease tag resolves to the next channel and dist-tag', () => {
  assert.deepEqual(channelOf('v2026.10.0-next.3'), {
    channel: 'next',
    distTag: 'next',
    prerelease: true,
    version: '2026.10.0-next.3',
  });
});

test('a refs/tags stable tag resolves like its bare tag', () => {
  assert.deepEqual(channelOf('refs/tags/v2026.10.0'), channelOf('v2026.10.0'));
});

test('a non-calver tag throws', () => {
  assert.throws(() => channelOf('garbage'));
});
