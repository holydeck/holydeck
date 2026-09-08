// Consistency gate for the tag-triggered release workflow: a stray or
// hand-pushed tag must never publish artifacts that disagree with the tag.
// Checks tag format, every lockstep manifest's name and version, the CLI's
// embedded version constant, and the changelog section — and reports every
// problem it finds.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CLI_VERSION_FILE, MANIFESTS, fromRepoRoot } from './sync-versions.mjs';

export const EXPECTED_PACKAGE_NAMES = {
  'package.json': 'holydeck-monorepo',
  'packages/core/package.json': '@holydeck/core',
  'apps/cli/package.json': '@holydeck/cli',
  'apps/server/package.json': '@holydeck/server',
};

export function verifyReleaseState({ tag, manifests, cliVersionModule, changelog }) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag ?? '');
  if (!match) {
    return [`tag '${tag ?? ''}' does not match v<major>.<minor>.<patch>`];
  }
  const version = match[1];
  const problems = [];
  for (const [path, jsonText] of Object.entries(manifests)) {
    const manifest = JSON.parse(jsonText);
    if (manifest.version !== version) {
      problems.push(`${path} has version ${manifest.version}, expected ${version}`);
    }
    const expectedName = EXPECTED_PACKAGE_NAMES[path];
    if (expectedName && manifest.name !== expectedName) {
      problems.push(`${path} has name ${manifest.name}, expected ${expectedName}`);
    }
  }
  if (!cliVersionModule.includes(`export const CLI_VERSION = '${version}';`)) {
    problems.push(`${CLI_VERSION_FILE} does not pin CLI_VERSION to ${version}`);
  }
  const heading = new RegExp(`^#{1,3} \\[?${version.replaceAll('.', '\\.')}[\\]\\s(]`, 'm');
  if (!heading.test(changelog)) {
    problems.push(`CHANGELOG.md has no section heading for ${version}`);
  }
  return problems;
}

function main(tag) {
  const manifests = Object.fromEntries(
    ['package.json', ...MANIFESTS].map((path) => [path, readFileSync(fromRepoRoot(path), 'utf8')]),
  );
  const problems = verifyReleaseState({
    tag,
    manifests,
    cliVersionModule: readFileSync(fromRepoRoot(CLI_VERSION_FILE), 'utf8'),
    changelog: readFileSync(fromRepoRoot('CHANGELOG.md'), 'utf8'),
  });
  if (problems.length > 0) {
    for (const problem of problems) console.error(`verify-release-state: ${problem}`);
    process.exit(1);
  }
  console.log(`verify-release-state: ${tag} is consistent`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv[2]);
