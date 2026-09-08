// Fans one release version out to every lockstep package. release-it's npm
// plugin bumps the root package.json; this script runs as the `after:bump`
// hook and bumps the workspace manifests plus the CLI's embedded version
// constant (the published CLI is a standalone bundle and cannot read its
// package.json at runtime). release-it's git plugin stages the release
// commit with `git add . --update`, which picks these tracked files up.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Every path below is repo-relative, so resolve them against the repo root
// rather than the caller's working directory.
export const fromRepoRoot = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

export const MANIFESTS = [
  'packages/core/package.json',
  'apps/cli/package.json',
  'apps/server/package.json',
];

export const CLI_VERSION_FILE = 'apps/cli/src/version.ts';

export function isValidVersion(version) {
  return /^\d+\.\d+\.\d+$/.test(version ?? '');
}

export function bumpManifest(jsonText, version) {
  const manifest = JSON.parse(jsonText);
  manifest.version = version;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function cliVersionModule(version) {
  return `export const CLI_VERSION = '${version}';\n`;
}

function main(version) {
  if (!isValidVersion(version)) {
    console.error(`sync-versions: expected <major>.<minor>.<patch>, got '${version ?? ''}'`);
    process.exit(1);
  }
  for (const path of MANIFESTS) {
    const file = fromRepoRoot(path);
    writeFileSync(file, bumpManifest(readFileSync(file, 'utf8'), version));
  }
  writeFileSync(fromRepoRoot(CLI_VERSION_FILE), cliVersionModule(version));
  console.log(`sync-versions: ${MANIFESTS.length} manifests and ${CLI_VERSION_FILE} set to ${version}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv[2]);
