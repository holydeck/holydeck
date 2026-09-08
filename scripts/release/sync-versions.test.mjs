import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bumpManifest,
  cliVersionModule,
  isValidVersion,
  CLI_VERSION_FILE,
  MANIFESTS,
} from './sync-versions.mjs';

test('bumpManifest replaces only the version and keeps key order', () => {
  const input = '{\n  "name": "holydeck",\n  "version": "0.0.0",\n  "type": "module"\n}\n';
  assert.equal(
    bumpManifest(input, '2026.9.0'),
    '{\n  "name": "holydeck",\n  "version": "2026.9.0",\n  "type": "module"\n}\n',
  );
});

test('bumpManifest adds a version when the manifest has none', () => {
  const output = bumpManifest('{\n  "name": "holydeck-monorepo"\n}\n', '2026.9.0');
  assert.equal(JSON.parse(output).version, '2026.9.0');
});

test('cliVersionModule emits the exact constant module', () => {
  assert.equal(cliVersionModule('2026.9.1'), "export const CLI_VERSION = '2026.9.1';\n");
});

test('isValidVersion accepts calver and plain semver, rejects garbage', () => {
  assert.equal(isValidVersion('2026.9.0'), true);
  assert.equal(isValidVersion('1.2.3'), true);
  assert.equal(isValidVersion('v2026.9.0'), false);
  assert.equal(isValidVersion('2026.9'), false);
  assert.equal(isValidVersion(''), false);
});

test('the fan-out targets are the three workspace packages and the CLI constant', () => {
  assert.deepEqual(MANIFESTS, [
    'packages/core/package.json',
    'apps/cli/package.json',
    'apps/server/package.json',
  ]);
  assert.equal(CLI_VERSION_FILE, 'apps/cli/src/version.ts');
});
