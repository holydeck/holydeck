import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORKSPACES } from '../workspace/pipeline.mjs';
import { MANIFESTS } from './sync-versions.mjs';
import { EXPECTED_PACKAGE_NAMES, verifyReleaseState } from './verify-release-state.mjs';

const packageNames = {
  'package.json': 'holydeck-monorepo',
  'packages/core/package.json': '@holydeck/core',
  'apps/cli/package.json': '@holydeck/cli',
  'apps/corpus/package.json': '@holydeck/corpus',
};
const manifest = (path, version) => JSON.stringify({ name: packageNames[path], version });

const consistent = {
  tag: 'v2026.9.0',
  manifests: {
    'package.json': manifest('package.json', '2026.9.0'),
    'packages/core/package.json': manifest('packages/core/package.json', '2026.9.0'),
    'apps/cli/package.json': manifest('apps/cli/package.json', '2026.9.0'),
    'apps/corpus/package.json': manifest('apps/corpus/package.json', '2026.9.0'),
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

test('rejects regex metacharacters in a tag', () => {
  assert.deepEqual(verifyReleaseState({ ...consistent, tag: 'v2026.9.0.*' }), [
    "tag 'v2026.9.0.*' does not match v<major>.<minor>.<patch>",
  ]);
});

test('a lagging manifest is reported by path', () => {
  const state = {
    ...consistent,
    manifests: {
      ...consistent.manifests,
      'apps/corpus/package.json': manifest('apps/corpus/package.json', '2026.8.9'),
    },
  };
  assert.deepEqual(verifyReleaseState(state), [
    'apps/corpus/package.json has version 2026.8.9, expected 2026.9.0',
  ]);
});

test('a wrong package name is reported by path', () => {
  const state = {
    ...consistent,
    manifests: {
      ...consistent.manifests,
      'apps/cli/package.json': JSON.stringify({ name: 'holydeck', version: '2026.9.0' }),
    },
  };
  assert.deepEqual(verifyReleaseState(state), [
    'apps/cli/package.json has name holydeck, expected @holydeck/cli',
  ]);
});

// A rename leaves the old path behind somewhere. The gate knows four manifests by name, and a
// path outside that set used to be waved through unnamed rather than reported.
test('a manifest the gate does not know is reported, not waved through', () => {
  const state = {
    ...consistent,
    manifests: {
      ...consistent.manifests,
      'apps/server/package.json': JSON.stringify({ name: '@holydeck/corpus', version: '2026.9.0' }),
    },
  };
  assert.deepEqual(verifyReleaseState(state), [
    'apps/server/package.json is not a release manifest',
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

// A workspace the release scripts do not know keeps its old version forever: the tag says one thing
// and the package another, and nothing in the release run notices.
test('every workspace in the root pipeline is versioned in lockstep, and nothing else is', () => {
  assert.deepEqual([...MANIFESTS].sort(), WORKSPACES.map((workspace) => `${workspace}/package.json`).sort());
});

test('every workspace in the root pipeline is named in the release gate', () => {
  assert.deepEqual(
    WORKSPACES.filter(
      (workspace) => EXPECTED_PACKAGE_NAMES[`${workspace}/package.json`] === undefined,
    ),
    [],
  );
});
