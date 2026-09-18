// Route-level integration coverage, censused the way pipeline.mjs censuses workspace structure: every
// route file the application ships is classified as either harness-tested or a named gap, and a route
// file in neither list — new, renamed, or simply forgotten — fails the census rather than passing by
// default.
//
// This is a different layer from the `*.integration.test.ts` files colocated in apps/app/src: those
// prove a store or a domain module works against a real MongoDB, called directly, never through a route.
// What ROUTE_INTEGRATION_TESTS points at is tests/harness/integration — the suite that starts the built
// application, corpus and worker as real processes and proves a route answers a real HTTP or WebSocket
// request, the way a deployment is actually reached.

import { readFileSync, readdirSync } from 'node:fs';

import { fromRepoRoot } from './pipeline.mjs';

export const ROUTES_DIR = 'apps/app/src';

// Every route file with harness-level HTTP coverage, and the file that test lives in — checked to exist,
// so a deleted or renamed test file is a census failure rather than a claim nobody rechecks.
export const ROUTE_INTEGRATION_TESTS = {
  'session-routes.ts': 'tests/harness/integration/surfaces.test.ts',
};

// A route file with no harness-level test yet. Closing a gap means deleting its line here and adding one
// to ROUTE_INTEGRATION_TESTS above, which is a diff a reviewer sees, not a rule someone quietly stopped
// enforcing.
export const KNOWN_INTEGRATION_GAPS = {
  'accounts-routes.ts': 'no harness test drives the admin account lifecycle over HTTP',
  'capability-routes.ts': 'no harness test issues or revokes a guest or output capability over HTTP',
  'passkey-routes.ts':
    'registration and authentication need a WebAuthn authenticator, which the harness (raw fetch, no ' +
    'browser) cannot provide — likely belongs in tests/harness/e2e instead',
  'reference-routes.ts': 'no harness test looks a reference up or shows one over HTTP',
  'settings-routes.ts': 'no harness test reads or changes settings over HTTP',
  'slide-layout-routes.ts': 'no harness test creates, versions or archives a Slide Layout over HTTP',
  'totp-routes.ts': 'no harness test drives TOTP setup or verification over HTTP',
  'translation-offset-routes.ts': 'no harness test reads or configures a translation offset over HTTP',
};

/**
 * Grades the route census against what the repository actually holds. `routeFiles` is every `*-routes.ts`
 * file on disk; `fileExists` answers whether a path claimed as a test is really there, so this reads a
 * repository in a test as easily as on disk.
 */
export function verifyRouteCoverage({ routeFiles, fileExists }) {
  const problems = [];
  const covered = new Set(Object.keys(ROUTE_INTEGRATION_TESTS));
  const gapped = new Set(Object.keys(KNOWN_INTEGRATION_GAPS));

  for (const route of routeFiles) {
    const isCovered = covered.has(route);
    const isGap = gapped.has(route);
    if (!isCovered && !isGap) {
      problems.push(`${route} is a route file this census does not classify as tested or as a known gap`);
    }
    if (isCovered && isGap) {
      problems.push(`${route} is listed as both tested and a known gap`);
    }
  }

  for (const [route, testPath] of Object.entries(ROUTE_INTEGRATION_TESTS)) {
    if (!routeFiles.includes(route)) {
      problems.push(`${route} is claimed as tested but is not a route file on disk`);
    } else if (!fileExists(testPath)) {
      problems.push(`${route} is claimed as tested by ${testPath}, which does not exist`);
    }
  }

  for (const gap of Object.keys(KNOWN_INTEGRATION_GAPS)) {
    if (!routeFiles.includes(gap)) {
      problems.push(`${gap} is a known integration gap that is not a route file on disk`);
    }
  }

  return problems;
}

export function readRoutes() {
  const routeFiles = readdirSync(fromRepoRoot(ROUTES_DIR), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('-routes.ts'))
    .map((entry) => entry.name)
    .sort();
  const fileExists = (path) => {
    try {
      readFileSync(fromRepoRoot(path));
      return true;
    } catch {
      return false;
    }
  };
  return { routeFiles, fileExists };
}
