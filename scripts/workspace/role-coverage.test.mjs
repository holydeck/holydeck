import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  permissionRoutesIn, readRoles, verifyRoleCoverage,
} from './role-coverage.mjs';

const route = 'example-routes.ts POST PATH MANAGE';
const source = `
  const PERMISSION: RouteNeed = { kind: 'permission', need: MANAGE };
  app.post(PATH, { config: { need: PERMISSION } }, async () => {});
`;
const testPath = 'tests/harness/integration/example.test.ts';
const testName = 'refuses the wrong permission';
const negative = `it('${testName}', async () => {
  const response = await fetch(url, { method: 'POST', headers: wrongRole.headers });
  expect(response.status).toBe(403);
});`;
const input = (text = source, evidence = negative) => ({
  routeSources: { 'example-routes.ts': text },
  readTest: () => evidence,
});
const covered = { tested: { [route]: { testPath, testName } }, gaps: {} };
const gapped = { tested: {}, gaps: { [route]: 'no harness negative case yet' } };

test('classifies an actual permission registration as tested or a named gap', () => {
  assert.deepEqual(verifyRoleCoverage(input(), covered), []);
  assert.deepEqual(verifyRoleCoverage(input(), gapped), []);
});

test('scans multiline and inline guards while ignoring comments, strings and unused declarations', () => {
  const scan = permissionRoutesIn({ 'example-routes.ts': `
    // app.post(FAKE, { config: { need: PERMISSION } }, handler);
    const text = "app.post(FAKE, { config: { need: PERMISSION } }, handler)";
    const UNUSED: RouteNeed = { kind: 'permission', need: OTHER };
    app.post(
      PATH,
      { config: { need: { kind: 'permission', need: MANAGE } } },
      handler,
    );
  ` });
  assert.deepEqual(scan, { routes: [route], problems: [] });
});

const anyRoute = 'example-routes.ts GET PATH FIRST|SECOND';
const anySource = `
  const NEED: RouteNeed = { kind: 'any-permission', needs: [FIRST, SECOND] };
  app.get(PATH, { config: { need: NEED } }, async () => {});
`;
const anyGapped = { tested: {}, gaps: { [anyRoute]: 'no harness negative case yet' } };

test('recognizes an any-permission guard and joins its needs for the census signature', () => {
  assert.deepEqual(permissionRoutesIn({ 'example-routes.ts': anySource }), { routes: [anyRoute], problems: [] });
  assert.deepEqual(
    verifyRoleCoverage({ routeSources: { 'example-routes.ts': anySource }, readTest: () => undefined }, anyGapped),
    [],
  );
});

test('an any-permission guard with an unresolvable needs array fails closed', () => {
  const broken = anySource.replace('needs: [FIRST, SECOND]', 'needs: computed()');
  assert.ok(permissionRoutesIn({ 'example-routes.ts': broken }).problems
    .some((problem) => problem.includes('has no recognizable authorization guard')));
});

test('narrowing an any-permission guard’s needs cannot hide behind an existing known gap', () => {
  const narrowed = anySource.replace('needs: [FIRST, SECOND]', 'needs: [FIRST]');
  const problems = verifyRoleCoverage(
    { routeSources: { 'example-routes.ts': narrowed }, readTest: () => undefined }, anyGapped,
  );
  assert.ok(problems.some((problem) => problem.includes('is a known integration gap that is not a permission route on disk')));
});

test('excludes public and session routes, including a file with mixed kinds', () => {
  const scan = permissionRoutesIn({ 'example-routes.ts': `${source}
    const PUBLIC: RouteNeed = { kind: 'public' };
    const SESSION: RouteNeed = { kind: 'session' };
    app.get(PATH, { config: { need: PUBLIC } }, handler);
    app.patch(PATH, { config: { need: SESSION } }, handler);
  ` });
  assert.deepEqual(scan, { routes: [route], problems: [] });
});

test('reports new permission routes and duplicate classifications', () => {
  assert.deepEqual(verifyRoleCoverage(input(), { tested: {}, gaps: {} }), [
    `${route} is a permission route this census does not classify as tested or as a known gap`,
  ]);
  assert.deepEqual(verifyRoleCoverage(input(), { ...covered, gaps: gapped.gaps }), [
    `${route} is listed as both tested and a known gap`,
  ]);
});

test('a gap for one method does not cover another method or another file', () => {
  assert.match(verifyRoleCoverage(input(`${source}\napp.get(PATH, { config: { need: PERMISSION } }, handler);`), gapped)[0], /GET PATH MANAGE/u);
  const value = input();
  value.routeSources['new-routes.ts'] = source;
  assert.match(verifyRoleCoverage(value, gapped)[0], /new-routes.ts POST PATH MANAGE/u);
});

test('removing or weakening a guard cannot disappear into the known gaps', () => {
  for (const changed of [
    source.replace('{ config: { need: PERMISSION } }', '{}'),
    source.replace("kind: 'permission'", "kind: 'session'"),
    source.replace("kind: 'permission'", "kind: 'public'"),
    source.replace('need: MANAGE', 'need: LESS'),
    source.replace('app.post(PATH', 'app.post(OTHER_PATH'),
    '',
  ]) {
    assert.ok(verifyRoleCoverage(input(changed), gapped).some((problem) => problem.includes('not a permission route on disk')));
    assert.ok(verifyRoleCoverage(input(changed), covered).some((problem) => problem.includes('not a permission route on disk')));
  }
});

test('reports unrecognized guards, spreads, unsupported registrations and invalid syntax', () => {
  for (const changed of [
    'app.post(PATH, handler);',
    source.replace('need: PERMISSION', 'need: UNKNOWN'),
    source.replace('need: MANAGE', 'need: computed()'),
    source.replace('need: MANAGE', 'need: MANAGE, ...override'),
    source.replace('const PERMISSION', 'let PERMISSION'),
    'app.route({ method: "POST", url: PATH });',
    'const broken = {',
  ]) {
    assert.ok(permissionRoutesIn({ 'example-routes.ts': changed }).problems.length > 0, changed);
  }
});

test('a deleted route file leaves stale tested and known-gap claims', () => {
  const value = { routeSources: {}, readTest: () => negative };
  assert.deepEqual(verifyRoleCoverage(value, covered), [
    `${route} is claimed as tested but is not a permission route on disk`,
  ]);
  assert.deepEqual(verifyRoleCoverage(value, gapped), [
    `${route} is a known integration gap that is not a permission route on disk`,
  ]);
});

test('requires a reason for every allowlisted gap', () => {
  for (const reason of ['', '   ', undefined]) {
    assert.deepEqual(verifyRoleCoverage(input(), { tested: {}, gaps: { [route]: reason } }), [
      `${route} has no reason for its known integration gap`,
    ]);
  }
});

test('fails when a claimed test file is deleted', () => {
  const value = input();
  value.readTest = () => undefined;
  assert.deepEqual(verifyRoleCoverage(value, covered), [
    `${route} is claimed as tested by ${testPath}, which does not exist`,
  ]);
});

test('requires the named enabled HTTP denial case, not merely an existing file or a comment', () => {
  for (const evidence of [
    '',
    `// ${negative.replaceAll('\n', '\n// ')}`,
    negative.replace(testName, 'unrelated case'),
    negative.replace('403', '401'),
    negative.replace('403', '200'),
    negative.replace('response.status', 'response.statusCode'),
    negative.replace('response.status', 'unrelated'),
    negative.replace('expect(response.status)', 'check(response.status)'),
    negative.replace('it(', 'it.skip('),
    `describe.skip('skipped suite', () => { ${negative} });`,
    `describe.skipIf(true)('skipped suite', () => { ${negative} });`,
    `it('${testName}');`,
    `it('${testName}', helper);`,
    `${negative}\nconst broken = {`,
  ]) {
    assert.equal(verifyRoleCoverage(input(source, evidence), covered).length, 1, evidence);
  }
});

test('accepts a named test inside an enabled suite and an equivalent equality assertion', () => {
  const evidence = `describe('permissions', () => { ${negative.replace('it(', 'test(').replace('toBe', 'toEqual')} });`;
  assert.deepEqual(verifyRoleCoverage(input(source, evidence), covered), []);
});

test('in-process route tests cannot be claimed as harness integration evidence', () => {
  assert.equal(verifyRoleCoverage(input(), {
    tested: { [route]: { testPath: 'apps/app/src/example-routes.test.ts', testName } }, gaps: {},
  }).length, 1);
});

test('the repository itself accounts for every permission registration it ships', () => {
  const repo = readRoles();
  assert.equal(Object.keys(repo.routeSources).length, 23);
  assert.equal(permissionRoutesIn(repo.routeSources).routes.length, 103);
  assert.deepEqual(verifyRoleCoverage(repo), []);
  assert.equal(verifyRoleCoverage(repo, { tested: {}, gaps: {} }).length, 103);
});

test('repository guard removal is detected even while its negative test is a known gap', () => {
  const repo = readRoles();
  repo.routeSources['accounts-routes.ts'] = repo.routeSources['accounts-routes.ts'].replace(
    'app.patch(CONTROL_PATH, { config: { need: PERMISSION } }', 'app.patch(CONTROL_PATH, {}',
  );
  const problems = verifyRoleCoverage(repo);
  assert.ok(problems.some((problem) => problem.includes('PATCH CONTROL_PATH has no recognizable authorization guard')));
});

test('weakening live.ts\'s connection-counts guard is caught even though it is a known gap', () => {
  const repo = readRoles();
  repo.routeSources['live.ts'] = repo.routeSources['live.ts'].replace(
    'app.get(LIVE_CONNECTIONS_PATH, { config: { need: PERMISSION } }', 'app.get(LIVE_CONNECTIONS_PATH, { config: { need: PUBLIC } }',
  );
  const problems = verifyRoleCoverage(repo);
  assert.ok(problems.some((problem) => problem === 'live.ts GET LIVE_CONNECTIONS_PATH PRESENTATION_CONTROL is a known integration gap that is not a permission route on disk'));
});

test('a route options spread is resolved when it provably cannot smuggle in a guard, rejected otherwise', () => {
  const safe = `
    const PUBLIC: RouteNeed = { kind: 'public' };
    const proving = flag ? {} : { preValidation: async () => {} };
    app.get(PATH, { websocket: true, config: { need: PUBLIC }, ...proving }, () => {});
  `;
  assert.deepEqual(permissionRoutesIn({ 'live.ts': safe }).problems, []);
  assert.deepEqual(permissionRoutesIn({ 'live.ts': safe }).routes, []);

  const unproven = `
    const PUBLIC: RouteNeed = { kind: 'public' };
    app.get(PATH, { websocket: true, config: { need: PUBLIC }, ...unknown }, () => {});
  `;
  assert.ok(permissionRoutesIn({ 'live.ts': unproven }).problems
    .some((problem) => problem.includes('has no recognizable authorization guard')));

  const unsafe = `
    const PUBLIC: RouteNeed = { kind: 'public' };
    const proving = flag ? {} : { config: { need: SOMETHING } };
    app.get(PATH, { websocket: true, config: { need: PUBLIC }, ...proving }, () => {});
  `;
  assert.ok(permissionRoutesIn({ 'live.ts': unsafe }).problems
    .some((problem) => problem.includes('has no recognizable authorization guard')));
});

test('table registration branches cannot weaken a guard while the normal branch retains it', () => {
  for (const file of ['accounts-routes.ts', 'translation-offset-routes.ts']) {
    const repo = readRoles();
    repo.routeSources[file] = repo.routeSources[file].replace(
      file === 'accounts-routes.ts' ? 'config: { need: PERMISSION }' : 'config: { need }',
      "config: { need: { kind: 'session' } }",
    );
    assert.ok(verifyRoleCoverage(repo).some((problem) => problem.includes('inconsistent authorization guards')), file);
  }
});

test('inspects literal generic registrations and tuple or object route tables', () => {
  for (const registration of [
    'app.route({ method: "POST", url: PATH, config: { need: PERMISSION }, handler });',
    'const ROUTES = [["POST", PATH]] as const; for (const [method, url] of ROUTES) { app.route({ method, url, config: { need: PERMISSION }, handler }); }',
    'const ROUTES = [{ method: "POST", url: PATH, need: PERMISSION }]; for (const { method, url, need } of ROUTES) { app.route({ method, url, config: { need }, handler }); }',
  ]) {
    assert.deepEqual(verifyRoleCoverage(input(`${source}\n${registration}`), gapped), []);
  }
});

test('the repository reader returns absent evidence as missing', () => {
  assert.equal(readRoles().readTest('tests/harness/integration/does-not-exist.test.ts'), undefined);
  assert.match(readRoles().readTest('tests/harness/integration/surfaces.test.ts'), /describe\(/u);
});
