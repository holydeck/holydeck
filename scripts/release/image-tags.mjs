import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CALVER_PATTERN } from './calver.mjs';

export function isNewestStable(version, existingTags) {
  const stableVersions = existingTags
    .map((tag) => tag.replace(/^v/, ''))
    .filter((v) => CALVER_PATTERN.test(v) && !v.includes('-next.'));
  const [year, month, patch] = version.split(/[.]/).map(Number);
  return stableVersions.every((candidate) => {
    if (candidate === version) return true;
    const [cy, cm, cp] = candidate.split('.').map(Number);
    if (cy !== year) return cy < year;
    if (cm !== month) return cm < month;
    return cp <= patch;
  });
}

// Mirrors isNewestStable so the moving `:next` pointer is guarded the same way `:latest` is: a
// re-run of an old prerelease build, or a build cut for an older calendar base after a newer
// prerelease already shipped, must not walk `:next` backwards.
export function isNewestPrerelease(version, existingTags) {
  const prereleaseVersions = existingTags
    .map((tag) => tag.replace(/^v/, ''))
    .filter((v) => CALVER_PATTERN.test(v) && v.includes('-next.'));
  const parts = (v) => CALVER_PATTERN.exec(v).slice(1, 5).map(Number);
  const [year, month, patch, next] = parts(version);
  return prereleaseVersions.every((candidate) => {
    if (candidate === version) return true;
    const [cy, cm, cp, cn] = parts(candidate);
    if (cy !== year) return cy < year;
    if (cm !== month) return cm < month;
    if (cp !== patch) return cp < patch;
    return cn <= next;
  });
}

export function imageTags({ version, existingTags, names }) {
  const prerelease = version.includes('-next.');
  const suffixes = [
    version,
    prerelease && isNewestPrerelease(version, existingTags) ? 'next' : undefined,
    !prerelease && isNewestStable(version, existingTags) ? 'latest' : undefined,
  ].filter((s) => s !== undefined);
  const result = {};
  for (const name of names) {
    result[name] = suffixes.map((suffix) => `ghcr.io/holydeck/${name}:${suffix}`);
  }
  return result;
}

function main(version, namesArg) {
  try {
    const names = namesArg.split(',');
    const existingTags = readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean);
    const tags = imageTags({ version, existingTags, names });
    for (const name of names) console.log(`${name.toUpperCase()}_TAGS=${tags[name].join(',')}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv[2], process.argv[3]);
