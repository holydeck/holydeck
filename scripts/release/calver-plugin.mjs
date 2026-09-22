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

class CalverPlugin extends Plugin {
  getIncrementedVersion({ latestVersion }) {
    if (this.config.options.version.isPreRelease === true && this.config.options.version.preReleaseId === 'next') {
      const tags = listVersionTags();
      const latestStable = latestCalverTag(tags, { prerelease: false });
      const latestPrerelease = latestCalverTag(tags, { prerelease: true });
      return nextPrerelease(latestStable, latestPrerelease);
    }
    return nextCalver(latestVersion);
  }

  getIncrementedVersionCI({ latestVersion }) {
    if (this.config.options.version.isPreRelease === true && this.config.options.version.preReleaseId === 'next') {
      const tags = listVersionTags();
      const latestStable = latestCalverTag(tags, { prerelease: false });
      const latestPrerelease = latestCalverTag(tags, { prerelease: true });
      return nextPrerelease(latestStable, latestPrerelease);
    }
    return nextCalver(latestVersion);
  }
}

export default CalverPlugin;
