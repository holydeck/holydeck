import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractNotes } from './extract-notes.mjs';

const changelog = [
  '# Changelog',
  '',
  '## [2026.9.1](https://github.com/holydeck/holydeck/compare/v2026.9.0...v2026.9.1) (2026-09-20)',
  '',
  '### Bug Fixes',
  '',
  '* **cli:** keep the staleness footer on stderr',
  '',
  '## 2026.9.0 (2026-09-08)',
  '',
  '### Features',
  '',
  '* first public release',
  '',
].join('\n');

test('extracts a section bounded by the next version heading', () => {
  assert.equal(
    extractNotes(changelog, '2026.9.1'),
    '### Bug Fixes\n\n* **cli:** keep the staleness footer on stderr',
  );
});

test('extracts the last section to the end of the file', () => {
  assert.equal(extractNotes(changelog, '2026.9.0'), '### Features\n\n* first public release');
});

test('subsection headings never terminate a section early', () => {
  assert.match(extractNotes(changelog, '2026.9.1'), /Bug Fixes/);
});

test('returns null for a version with no section', () => {
  assert.equal(extractNotes(changelog, '2026.8.0'), null);
});

test('an empty section body yields an empty string', () => {
  const sparse = '# Changelog\n\n## 2026.9.1 (2026-09-20)\n\n## 2026.9.0 (2026-09-08)\n\n* note\n';
  assert.equal(extractNotes(sparse, '2026.9.1'), '');
});
