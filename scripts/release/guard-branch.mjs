// release.yml checks a pushed tag's ancestry: a stable tag must be reachable from main, a next
// tag from next (see its "Check the tag is on the right branch" step). .release-it.json's own
// requireBranch only rules out a third, unrelated branch — it accepts either main or next for
// both `pnpm release` and `pnpm release:next`, so nothing local stops a maintainer from cutting
// a next prerelease while checked out on main, which release-it would happily tag and push,
// only for release.yml to reject it far later. This guard closes that gap at the one place it
// is cheapest to catch it: before release-it even starts.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function currentBranch(exec = execFileSync) {
  return exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
}

export function guardBranch(expected, actual) {
  if (actual !== expected) {
    throw new Error(`this release must be run from the '${expected}' branch, not '${actual}'`);
  }
}

function main(expected) {
  try {
    guardBranch(expected, currentBranch());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv[2]);
