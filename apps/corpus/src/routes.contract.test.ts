import { afterAll, beforeAll, expect, it } from 'vitest';
import { CORPUS_ROUTES } from '@holydeck/contracts/corpus';
import { API_ENDPOINTS } from './errors.js';
import { buildTestApp } from '../test/helpers/app.js';
import type { TestApp } from '../test/helpers/app.js';

// The released HTTP surface, written out rather than derived from the router, so that a route which
// moves, disappears, or appears has to be changed here by somebody who meant it. The package around
// these routes is being renamed; this list is what "behaviour-preserving" means in practice.
const RELEASED_ROUTES = [
  'GET /api/v1/stats',
  'GET /api/v1/translations',
  'GET /api/v1/translations/:abbr/canon',
  'GET /api/v1/translations/:abbr/search',
  'GET /api/v1/translations/:abbr/sync',
  'GET /api/v1/translations/:abbr/verses',
  'GET /api/v1/verse',
  'GET /health',
  'POST /api/v1/render',
  'POST /api/v1/translations/:abbr/sync',
];

// The one route that answers a request but is absent from the 404 body's directory. A caller only
// finds it by already knowing it, so it is a promise kept to somebody who is never told it exists.
const UNDOCUMENTED_ROUTES = ['GET /api/v1/verse'];

// printRoutes draws the router as a tree: each line is indented one four-character unit per level
// and carries only the segment its parent does not already spell out.
const routesOf = (tree: string): string[] => {
  const paths: string[] = [];
  const prefixes: string[] = [];
  for (const line of tree.split('\n')) {
    const node = /^((?:[│ ] {3})*)[├└]── (\S*)(?: \(([A-Z, ]+)\))?$/u.exec(line);
    if (node === null) continue;
    const [, indent = '', segment = '', methods] = node;
    const depth = indent.length / 4;
    prefixes.length = depth;
    prefixes.push(segment);
    if (methods === undefined) continue;
    for (const method of methods.split(', ')) {
      if (method !== 'HEAD') paths.push(`${method} ${prefixes.join('')}`);
    }
  }
  return paths.sort();
};

let ctx: TestApp;

beforeAll(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

afterAll(async () => {
  await ctx.stop();
});

// The application depends on a named subset of these routes. It cannot be the one that decides they
// still exist, so the dependency is checked here, against the router this server actually builds.
it('still serves every route the application depends on', () => {
  expect(CORPUS_ROUTES.map((route) => route.route).filter((route) => !RELEASED_ROUTES.includes(route))).toEqual([]);
});

it('serves every released route and nothing besides', () => {
  expect(routesOf(ctx.app.printRoutes({ commonPrefix: false }))).toEqual(RELEASED_ROUTES);
});

// A 404 body advertises the API to whoever mistyped a path, and that advertisement is released too:
// a route that exists but is not listed is a route nobody will find on their own.
it('advertises every released route it documents, and documents nothing it does not serve', () => {
  expect(Object.keys(API_ENDPOINTS).sort()).toEqual(
    RELEASED_ROUTES.filter((route) => !UNDOCUMENTED_ROUTES.includes(route)),
  );
});
