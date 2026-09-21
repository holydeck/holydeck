import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KNOWN_INTEGRATION_GAPS, ROUTE_INTEGRATION_TESTS, directRoutesIn, readRoutes, verifyRouteCoverage } from './route-coverage.mjs';

const complete = () => ({
  routeFiles: [...Object.keys(ROUTE_INTEGRATION_TESTS), ...Object.keys(KNOWN_INTEGRATION_GAPS)].sort(),
  fileExists: () => true,
});

test('a census where every route identity is tested or a named gap has no problems', () => {
  assert.deepEqual(verifyRouteCoverage(complete()), []);
});

test('refuses a route identity classified as neither tested nor a known gap', () => {
  const input = complete();
  input.routeFiles.push('invented-routes.ts', 'app.ts GET /new');
  assert.deepEqual(verifyRouteCoverage(input), [
    'invented-routes.ts is a route identity this census does not classify as tested or as a known gap',
    'app.ts GET /new is a route identity this census does not classify as tested or as a known gap',
  ]);
});

test('refuses a route identity claimed as both tested and a known gap', () => {
  const input = complete();
  const [route] = Object.keys(ROUTE_INTEGRATION_TESTS);
  KNOWN_INTEGRATION_GAPS[route] = 'temporary, for this test';
  try {
    assert.deepEqual(verifyRouteCoverage(input), [`${route} is listed as both tested and a known gap`]);
  } finally {
    delete KNOWN_INTEGRATION_GAPS[route];
  }
});

test('refuses a tested claim whose test file does not exist', () => {
  const input = complete();
  input.fileExists = () => false;
  assert.deepEqual(verifyRouteCoverage(input), Object.entries(ROUTE_INTEGRATION_TESTS).map(
    ([route, testPath]) => `${route} is claimed as tested by ${testPath}, which does not exist`,
  ));
});

test('refuses a tested or gapped route that is no longer a route identity on disk', () => {
  const input = complete();
  input.routeFiles = input.routeFiles.filter((route) =>
    !['session-routes.ts', 'app.ts GET /health', 'live.ts GET LIVE_CONNECTIONS_PATH'].includes(route));
  assert.deepEqual(verifyRouteCoverage(input), [
    'session-routes.ts is claimed as tested but is not a route identity on disk',
    'app.ts GET /health is claimed as tested but is not a route identity on disk',
    'live.ts GET LIVE_CONNECTIONS_PATH is a known integration gap that is not a route identity on disk',
  ]);
});

// The checks above all run against constructed input. This one runs them against the repository, so a
// check that only ever grades a fixture cannot pass for the repository it was written to grade.
test('the repository itself accounts for every route identity it ships', () => {
  assert.deepEqual(verifyRouteCoverage(readRoutes()), []);
});

test('direct registrations include literal and constant paths, ignoring comments and unrelated calls', () => {
  assert.deepEqual(directRoutesIn('app.ts', `
    // app.get('/comment', handler);
    const example = "app.get('/string', handler)";
    other.get('/other', handler);
    app.register(plugin);
    function register() {
      app.get('/health', {}, handler);
      app.get('/health', {}, handler);
      app.get(LIVE_PATH, { websocket: true }, handler);
      app.post('/new', {}, handler);
      app.get();
    }
  `), ['app.ts GET /health', 'app.ts GET LIVE_PATH', 'app.ts POST /new', 'app.ts GET <missing path>']);
  assert.deepEqual(directRoutesIn('live.ts', ''), []);
  assert.throws(() => directRoutesIn('app.ts', 'app.get('), /cannot be parsed for direct routes/u);
});
