// One place for the coverage floor every workspace runs under. A package is free to add its own
// includes, excludes and timeouts, but not its own thresholds: lowering the floor anywhere means
// editing this file, which every package imports, instead of quietly changing a number in one config.
//
// This is the standing target, not a temporary relaxation, and it is deliberately not 100: unit-test
// coverage is the backstop, not the enforcement mechanism — the real proof that a feature works is the
// integration and browser suites exercising it end to end (see scripts/workspace/route-coverage.mjs for
// the census that keeps those honest). A floor chasing 100 buys diminishing assurance at a cost this
// project would pay on every change, forever. Branches sits lowest because exhaustive branch coverage on
// error/edge paths is integration territory, not unit territory.
export const coverageFloor = {
  statements: 70,
  branches: 60,
  functions: 70,
  lines: 70,
};

// Every vitest workspace retries a failing test once before letting it fail the run. A test that only
// ever fails once is more often a slow stack or a race than a real defect, and a policy that never
// retries trains people to re-run the whole job by hand instead; a policy that retries silently and
// endlessly trains people to ignore red altogether. One retry, reported either way, is the middle of
// that. The browser suite (tests/harness/playwright.config.ts) deliberately opts out of this — see its
// own comment for why a browser flake is graded differently from a unit or integration one.
export const testRetry = 1;
