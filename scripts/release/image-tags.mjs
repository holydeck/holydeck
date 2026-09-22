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

export function imageTags({ version, existingTags, names }) {
  const prerelease = version.includes('-next.');
  const suffixes = [
    version,
    prerelease ? 'next' : undefined,
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
