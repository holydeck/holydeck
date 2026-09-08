// release-it plugin that pins the next version to the lockstep calver scheme.
// To switch the project to commit-driven semver: delete this plugin's entry
// from .release-it.json and set the conventional-changelog plugin's
// `ignoreRecommendedBump` to false. No other change is needed.

import { Plugin } from 'release-it';
import { nextCalver } from './calver.mjs';

class CalverPlugin extends Plugin {
  getIncrementedVersion({ latestVersion }) {
    return nextCalver(latestVersion);
  }

  getIncrementedVersionCI({ latestVersion }) {
    return nextCalver(latestVersion);
  }
}

export default CalverPlugin;
