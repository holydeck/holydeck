// Extracts one version's section from CHANGELOG.md for the GitHub Release
// body, so the changelog stays the single source of release notes. Fails
// loudly when the section is missing — a release must never ship with
// silently empty notes.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NEXT_VERSION_HEADING = /^#{1,3} \[?\d+\.\d+\.\d+[\]\s(]/m;

export function extractNotes(changelog, version) {
  const escaped = version.replaceAll('.', '\\.');
  const heading = new RegExp(`^#{1,3} \\[?${escaped}[\\]\\s(]`, 'm').exec(changelog);
  if (!heading) return null;
  const bodyStart = changelog.indexOf('\n', heading.index);
  if (bodyStart === -1) return '';
  const rest = changelog.slice(bodyStart + 1);
  const next = NEXT_VERSION_HEADING.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

function main(version, changelogPath, outPath) {
  if (!version || !changelogPath || !outPath) {
    console.error('usage: extract-notes.mjs <version> <changelog-path> <out-path>');
    process.exit(1);
  }
  const notes = extractNotes(readFileSync(changelogPath, 'utf8'), version);
  if (notes === null) {
    console.error(`extract-notes: no section for ${version} in ${changelogPath}`);
    process.exit(1);
  }
  writeFileSync(outPath, `${notes}\n`);
  console.log(`extract-notes: wrote ${outPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main(process.argv[2], process.argv[3], process.argv[4]);
