import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageTags } from './image-tags.mjs';

test('a prerelease gets its version and next tags only', () => {
  assert.deepEqual(
    imageTags({
      version: '2026.10.0-next.1',
      existingTags: ['v2026.9.2', 'v2026.11.0', 'v2026.12.0-next.1'],
      names: ['corpus'],
    }),
    {
      corpus: [
        'ghcr.io/holydeck/corpus:2026.10.0-next.1',
        'ghcr.io/holydeck/corpus:next',
      ],
    },
  );
});

test('the newest stable gets latest when a matching prerelease exists', () => {
  assert.deepEqual(
    imageTags({
      version: '2026.10.0',
      existingTags: ['v2026.10.0-next.5', 'v2026.10.0'],
      names: ['corpus'],
    }),
    {
      corpus: ['ghcr.io/holydeck/corpus:2026.10.0', 'ghcr.io/holydeck/corpus:latest'],
    },
  );
});

test('an older stable does not get latest', () => {
  assert.deepEqual(
    imageTags({
      version: '2026.9.2',
      existingTags: ['v2026.10.0', 'v2026.9.2'],
      names: ['corpus'],
    }),
    {
      corpus: ['ghcr.io/holydeck/corpus:2026.9.2'],
    },
  );
});

test('aliases get the same tag suffixes under their repository names', () => {
  assert.deepEqual(
    imageTags({
      version: '2026.10.0-next.1',
      existingTags: [],
      names: ['corpus', 'server'],
    }),
    {
      corpus: [
        'ghcr.io/holydeck/corpus:2026.10.0-next.1',
        'ghcr.io/holydeck/corpus:next',
      ],
      server: [
        'ghcr.io/holydeck/server:2026.10.0-next.1',
        'ghcr.io/holydeck/server:next',
      ],
    },
  );
});
