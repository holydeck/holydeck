// release-it plugin that pins the next version to the lockstep calver scheme.
// To switch the project to commit-driven semver: delete this plugin's entry
// from .release-it.json and set the conventional-changelog plugin's
// `ignoreRecommendedBump` to false. No other change is needed.

import { execFileSync } from 'node:child_process';
import { Plugin } from 'release-it';
import { CALVER_PATTERN, nextCalver, nextPrerelease } from './calver.mjs';

export function latestCalverTag(tags, { prerelease }) {
  return tags
    .filter((tag) => CALVER_PATTERN.test(tag) && tag.includes('-next.') === prerelease)
    .reduce((latest, tag) => {
      if (latest === undefined) return tag;
      const lastPart = prerelease ? 5 : 4;
      const candidateParts = CALVER_PATTERN.exec(tag).slice(1, lastPart).map(Number);
      const latestParts = CALVER_PATTERN.exec(latest).slice(1, lastPart).map(Number);
      for (let index = 0; index < candidateParts.length; index += 1) {
        if (candidateParts[index] !== latestParts[index]) {
          return candidateParts[index] > latestParts[index] ? tag : latest;
        }
      }
      return latest;
    }, undefined);
}

export function listVersionTags(exec = execFileSync) {
  return exec('git', ['for-each-ref', '--format=%(refname:short)', 'refs/tags/v*'], {
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((tag) => tag.replace(/^v/, ''));
}

// The one place both getIncrementedVersion* hooks used to diverge, and the one place a stable release's
// base version comes from: the latest *stable* tag, never release-it's own `latestVersion` — which, right
// after a `-next.N` prerelease, names that prerelease tag, and nextCalver has no way to tell that base
// apart from an already-released one, bumping the patch a second time for a version that was never
// actually released. Exported standalone so this rule is tested directly, without a release-it Plugin to
// instantiate around it.
export function incrementedVersion(tags, isPreReleaseNext, now = new Date()) {
  const latestStable = latestCalverTag(tags, { prerelease: false });
  if (isPreReleaseNext) {
    const latestPrerelease = latestCalverTag(tags, { prerelease: true });
    return nextPrerelease(latestStable, latestPrerelease, now);
  }
  return nextCalver(latestStable, now);
}

class CalverPlugin extends Plugin {
  isPreReleaseNext() {
    return this.config.options.version.isPreRelease === true && this.config.options.version.preReleaseId === 'next';
  }

  getIncrementedVersion() {
    return incrementedVersion(listVersionTags(), this.isPreReleaseNext());
  }

  getIncrementedVersionCI() {
    return incrementedVersion(listVersionTags(), this.isPreReleaseNext());
  }
}

export default CalverPlugin;
