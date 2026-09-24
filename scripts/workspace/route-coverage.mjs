// Route-level integration coverage, censused the way pipeline.mjs censuses workspace structure: every
// route module and direct registration in app.ts/live.ts is classified as harness-tested or a named
// gap. An identity in neither list — new, renamed, or forgotten — fails the census.
//
// This is a different layer from the `*.integration.test.ts` files colocated in apps/app/src: those
// prove a store or a domain module works against a real MongoDB, called directly, never through a route.
// What ROUTE_INTEGRATION_TESTS points at is tests/harness/integration — the suite that starts the built
// application, corpus and worker as real processes and proves a route answers a real HTTP or WebSocket
// request, the way a deployment is actually reached.

import { readFileSync, readdirSync } from 'node:fs';

import ts from 'typescript';

import { fromRepoRoot } from './pipeline.mjs';

export const ROUTES_DIR = 'apps/app/src';

// Every route identity with harness-level HTTP or WebSocket coverage, and its test file — checked to
// exist, so a deleted or renamed test file is a census failure rather than a claim nobody rechecks.
export const ROUTE_INTEGRATION_TESTS = {
  'media-delivery-routes.ts': 'tests/harness/integration/media-delivery.test.ts',
  'session-routes.ts': 'tests/harness/integration/surfaces.test.ts',
  'corpus-proxy-routes.ts': 'tests/harness/integration/cli-corpus-proxy.test.ts',
  'app.ts GET /health': 'tests/harness/integration/surfaces.test.ts',
  'app.ts GET /api/v1/translations': 'tests/harness/integration/surfaces.test.ts',
  'live.ts GET LIVE_PATH': 'tests/harness/integration/surfaces.test.ts',
  'content-language-routes.ts': 'tests/harness/e2e/content.spec.ts',
  'library-routes.ts': 'tests/harness/e2e/content.spec.ts',
  'media-routes.ts': 'tests/harness/e2e/content.spec.ts',
  'pptx-routes.ts': 'tests/harness/integration/pptx-import.test.ts',
  'scripture-routes.ts': 'tests/harness/e2e/content.spec.ts',
  'slide-group-routes.ts': 'tests/harness/e2e/content.spec.ts',
  'slide-label-routes.ts': 'tests/harness/e2e/content.spec.ts',
  'slide-layout-routes.ts': 'tests/harness/e2e/content.spec.ts',
  'song-routes.ts': 'tests/harness/e2e/content.spec.ts',
};

// A route identity with no harness-level test yet. Closing a gap means deleting its line here and adding one
// to ROUTE_INTEGRATION_TESTS above, which is a diff a reviewer sees, not a rule someone quietly stopped
// enforcing.
export const KNOWN_INTEGRATION_GAPS = {
  'output-defaults-routes.ts': 'no harness test reads the output defaults over HTTP',
  'app.ts GET /api/contracts': 'no harness test reads the released contract registry over HTTP',
  'app.ts GET /api/v1/translations/:abbr/canon': "no harness test reads a translation's canon over HTTP",
  'app.ts GET /api/v1/translations/:abbr/verses': 'no harness test reads verses over HTTP',
  'live.ts GET LIVE_CONNECTIONS_PATH': 'no harness test reads live connection counts over HTTP',
  'accounts-routes.ts': 'no harness test drives the admin account lifecycle over HTTP',
  'audit-routes.ts': 'no harness test reads the audit trail over HTTP',
  'backup-routes.ts': 'no harness test starts a backup over HTTP',
  'capability-routes.ts': 'no harness test issues or revokes a guest or output capability over HTTP',
  'conflict-routes.ts': 'no harness test lists or settles a shelved conflict over HTTP',
  'integration-routes.ts': 'no harness test reads or toggles a third-party integration over HTTP',
  'job-routes.ts': 'no harness test lists or requeues a job over HTTP',
  'live-exchange-routes.ts': 'no harness test exchanges a guest or output join token for live tickets over HTTP',
  'media-migration-routes.ts': 'no harness test triggers or cleans up a media storage-root migration over HTTP',
  'media-cleanup-routes.ts': 'no harness test reports on or purges media over HTTP',
  'notification-routes.ts': 'no harness test reads or manages a notification inbox over HTTP',
  'operations-routes.ts': 'no harness test reads operational health over HTTP',
  'order-routes.ts': 'no harness test reads the running order over HTTP',
  'passkey-routes.ts':
    'registration and authentication need a WebAuthn authenticator, which the harness (raw fetch, no ' +
    'browser) cannot provide — likely belongs in tests/harness/e2e instead',
  'preparation-routes.ts': 'no harness test drives preparing a Service, its readiness checklist or an operator override over HTTP',
  'presence-routes.ts': 'no harness test enters, lists or leaves presence over HTTP',
  'reference-routes.ts': 'no harness test looks a reference up or shows one over HTTP',
  'restore-routes.ts': 'no harness test starts a restore over HTTP',
  'revision-routes.ts': 'no harness test reads, compares or restores a revision over HTTP',
  'sermon-routes.ts': 'no harness test creates or edits a Sermon over HTTP',
  'run-routes.ts':
    'tests/harness/e2e/live-run.spec.ts starts a run over HTTP and drives it over the socket, but no ' +
    'tests/harness/integration test ends one or reads its deck, theme, additions, review or recap',
  'service-routes.ts': 'no harness test drives the Service workspace lifecycle over HTTP',
  'settings-routes.ts': 'no harness test reads or changes settings over HTTP',
  'service-template-routes.ts':
    'no harness test creates, previews, saves forward, archives, restores or mints a Service Template from ' +
    'a Service over HTTP',
  'totp-routes.ts': 'no harness test drives TOTP setup or verification over HTTP',
  'translation-offset-routes.ts': 'no harness test reads or configures a translation offset over HTTP',
  'workspace-position-routes.ts': 'no harness test reads or writes a workspace position over HTTP',
};

/**
 * Grades the route census against what the repository actually holds. `routeFiles` is every `*-routes.ts`
 * file plus direct registrations in app.ts/live.ts; `fileExists` checks claimed test paths, so this reads a
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
      problems.push(`${route} is a route identity this census does not classify as tested or as a known gap`);
    }
    if (isCovered && isGap) {
      problems.push(`${route} is listed as both tested and a known gap`);
    }
  }

  for (const [route, testPath] of Object.entries(ROUTE_INTEGRATION_TESTS)) {
    if (!routeFiles.includes(route)) {
      problems.push(`${route} is claimed as tested but is not a route identity on disk`);
    } else if (!fileExists(testPath)) {
      problems.push(`${route} is claimed as tested by ${testPath}, which does not exist`);
    }
  }

  for (const gap of Object.keys(KNOWN_INTEGRATION_GAPS)) {
    if (!routeFiles.includes(gap)) {
      problems.push(`${gap} is a known integration gap that is not a route identity on disk`);
    }
  }

  return problems;
}

export function directRoutesIn(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (tree.parseDiagnostics.length > 0) throw new Error(`${file} cannot be parsed for direct routes`);
  const routes = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const call = node.expression;
      if (call.expression.getText(tree) === 'app' &&
          ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'].includes(call.name.text)) {
        const path = node.arguments[0];
        const identity = path === undefined ? '<missing path>'
          : ts.isStringLiteral(path) ? path.text : path.getText(tree);
        routes.push(`${file} ${call.name.text.toUpperCase()} ${identity}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return [...new Set(routes)];
}

export function readRoutes() {
  const routeFiles = readdirSync(fromRepoRoot(ROUTES_DIR), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('-routes.ts'))
    .map((entry) => entry.name);
  for (const file of ['app.ts', 'live.ts']) {
    routeFiles.push(...directRoutesIn(file, readFileSync(fromRepoRoot(`${ROUTES_DIR}/${file}`), 'utf8')));
  }
  routeFiles.sort();
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
