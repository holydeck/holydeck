import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KNOWN_INTEGRATION_GAPS, ROUTE_INTEGRATION_TESTS, readRoutes, verifyRouteCoverage } from './route-coverage.mjs';

const complete = () => ({
  routeFiles: [...Object.keys(ROUTE_INTEGRATION_TESTS), ...Object.keys(KNOWN_INTEGRATION_GAPS)].sort(),
  fileExists: () => true,
});

test('a census where every route file is tested or a named gap has no problems', () => {
  assert.deepEqual(verifyRouteCoverage(complete()), []);
});

test('refuses a route file classified as neither tested nor a known gap', () => {
  const input = complete();
  input.routeFiles.push('invented-routes.ts');
  assert.deepEqual(verifyRouteCoverage(input), [
    'invented-routes.ts is a route file this census does not classify as tested or as a known gap',
  ]);
});

test('refuses a route file claimed as both tested and a known gap', () => {
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
  const [route, testPath] = Object.entries(ROUTE_INTEGRATION_TESTS)[0];
  assert.deepEqual(verifyRouteCoverage(input), [`${route} is claimed as tested by ${testPath}, which does not exist`]);
});

test('refuses a tested or gapped route that is no longer a route file on disk', () => {
  const input = complete();
  input.routeFiles = input.routeFiles.filter((route) => route !== 'session-routes.ts');
  assert.deepEqual(verifyRouteCoverage(input), [
    'session-routes.ts is claimed as tested but is not a route file on disk',
  ]);
});

// The checks above all run against constructed input. This one runs them against the repository, so a
// check that only ever grades a fixture cannot pass for the repository it was written to grade.
test('the repository itself accounts for every route file it ships', () => {
  assert.deepEqual(verifyRouteCoverage(readRoutes()), []);
});
