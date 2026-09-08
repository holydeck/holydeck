import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyReleaseState } from './verify-release-state.mjs';

const manifest = (version) => JSON.stringify({ name: 'x', version });

const consistent = {
  tag: 'v2026.9.0',
  manifests: {
    'package.json': manifest('2026.9.0'),
    'packages/core/package.json': manifest('2026.9.0'),
    'apps/cli/package.json': manifest('2026.9.0'),
    'apps/server/package.json': manifest('2026.9.0'),
  },
  cliVersionModule: "export const CLI_VERSION = '2026.9.0';\n",
  changelog: '# Changelog\n\n## 2026.9.0 (2026-09-08)\n\n### Features\n\n* first release\n',
};

test('a consistent release state has no problems', () => {
  assert.deepEqual(verifyReleaseState(consistent), []);
});

test('accepts a linked conventional-changelog heading', () => {
  const changelog =
    '# Changelog\n\n## [2026.9.0](https://github.com/holydeck/holydeck/compare/v2026.8.0...v2026.9.0) (2026-09-08)\n';
  assert.deepEqual(verifyReleaseState({ ...consistent, changelog }), []);
});

test('a malformed tag is the only reported problem', () => {
  assert.deepEqual(verifyReleaseState({ ...consistent, tag: 'release-1' }), [
    "tag 'release-1' does not match v<major>.<minor>.<patch>",
  ]);
});

test('a lagging manifest is reported by path', () => {
  const state = {
    ...consistent,
    manifests: { ...consistent.manifests, 'apps/server/package.json': manifest('2026.8.9') },
  };
  assert.deepEqual(verifyReleaseState(state), [
    'apps/server/package.json has version 2026.8.9, expected 2026.9.0',
  ]);
});

test('a stale CLI_VERSION constant is reported', () => {
  const state = { ...consistent, cliVersionModule: "export const CLI_VERSION = '0.0.0';\n" };
  assert.deepEqual(verifyReleaseState(state), [
    'apps/cli/src/version.ts does not pin CLI_VERSION to 2026.9.0',
  ]);
});

test('a missing changelog section is reported', () => {
  const state = { ...consistent, changelog: '# Changelog\n\n## 2026.8.0 (2026-08-02)\n' };
  assert.deepEqual(verifyReleaseState(state), [
    'CHANGELOG.md has no section heading for 2026.9.0',
  ]);
});
