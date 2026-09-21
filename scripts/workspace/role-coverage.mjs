// Like route-coverage.mjs, this counts harness integration evidence, not in-process route tests.
// Keys pin each registration and permission: removing or weakening a guard leaves a stale claim.
import { readFileSync, readdirSync } from 'node:fs';

import ts from 'typescript';

import { fromRepoRoot } from './pipeline.mjs';

export const ROUTES_DIR = 'apps/app/src';

// Entries take { testPath, testName }, naming a reviewed wrong-permission HTTP test in the harness.
// The census checks that the named, enabled test still contains a forbidden-status assertion; the
// harness itself proves the behavior. No existing harness HTTP test supplies that evidence yet.
export const ROLE_INTEGRATION_TESTS = {};

// Move a key into ROLE_INTEGRATION_TESTS when its negative integration case is implemented.
export const KNOWN_INTEGRATION_GAPS = {
  'accounts-routes.ts PATCH CONTROL_PATH ACCOUNTS_MANAGE': 'no harness test refuses a control-presentation grant to a non-admin',
  'accounts-routes.ts POST ACCOUNTS_PATH ACCOUNTS_MANAGE': 'no harness test refuses account creation to a non-admin',
  'accounts-routes.ts PATCH STATUS_PATH ACCOUNTS_MANAGE': 'no harness test refuses account status changes to a non-admin',
  'accounts-routes.ts PATCH ROLE_PATH ACCOUNTS_MANAGE': 'no harness test refuses role assignment to a non-admin',
  'capability-routes.ts POST GUEST_INVITATION_PATH PRESENTATION_CONTROL': 'no harness test refuses guest invitations without Control presentation',
  'capability-routes.ts POST OUTPUT_CAPABILITY_PATH PRESENTATION_CONTROL': 'no harness test refuses output capabilities without Control presentation',
  'capability-routes.ts DELETE REVOKE_PATH PRESENTATION_CONTROL': 'no harness test refuses capability revocation without Control presentation',
  'media-routes.ts POST MEDIA_PATH MEDIA_MANAGE': 'no harness test refuses media uploads to a non-admin',
  'reference-routes.ts GET LOOKUP_PATH PRESENTATION_CONTROL': 'no harness test refuses reference lookup without Control presentation',
  'reference-routes.ts POST SHOWN_REFERENCES_PATH PRESENTATION_CONTROL': 'no harness test refuses showing references without Control presentation',
  'reference-routes.ts GET SHOWN_REFERENCES_PATH PRESENTATION_CONTROL': 'no harness test refuses reference history without Control presentation',
  'settings-routes.ts GET SETTINGS_PATH SETTINGS_MANAGE': 'no harness test refuses settings reads to a non-admin',
  'settings-routes.ts PATCH SETTINGS_PATH SETTINGS_MANAGE': 'no harness test refuses settings changes to a non-admin',
  'slide-layout-routes.ts POST SLIDE_LAYOUTS_PATH LAYOUTS_MANAGE': 'no harness test refuses layout creation to a non-admin',
  'slide-layout-routes.ts GET LAYOUT_PATH LAYOUTS_MANAGE': 'no harness test refuses layout reads to a non-admin',
  'slide-layout-routes.ts GET LAYOUT_REVISIONS_PATH LAYOUTS_MANAGE': 'no harness test refuses layout revision reads to a non-admin',
  'slide-layout-routes.ts PUT LAYOUT_BOXES_PATH LAYOUTS_MANAGE': 'no harness test refuses layout edits to a non-admin',
  'slide-layout-routes.ts POST LAYOUT_REVISION_PATH LAYOUTS_MANAGE': 'no harness test refuses layout restoration to a non-admin',
  'slide-layout-routes.ts PATCH LAYOUT_STATUS_PATH LAYOUTS_MANAGE': 'no harness test refuses layout archival to a non-admin',
  'translation-offset-routes.ts PUT SET_PATH SETTINGS_MANAGE': 'no harness test refuses translation offset changes to a non-admin',
};

const parse = (name, text) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const property = (node, name) => {
  if (node === undefined || !ts.isObjectLiteralExpression(node) || node.properties.some(ts.isSpreadAssignment)) {
    return undefined;
  }
  const entry = node.properties.find((entry) =>
    (ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry)) && entry.name.text === name);
  return entry === undefined ? undefined : ts.isShorthandPropertyAssignment(entry) ? entry.name : entry.initializer;
};

const walk = (node, visit) => {
  visit(node);
  ts.forEachChild(node, (child) => { walk(child, visit); });
};

// The no-store branches register the same routes from a const table using destructuring.
function tableBindings(node, constants) {
  let loop = node.parent;
  while (loop !== undefined && !ts.isForOfStatement(loop)) loop = loop.parent;
  if (loop === undefined || !ts.isIdentifier(loop.expression) || !ts.isVariableDeclarationList(loop.initializer)) return undefined;
  let table = constants.get(loop.expression.text);
  if (table !== undefined && ts.isAsExpression(table)) table = table.expression;
  const binding = loop.initializer.declarations[0]?.name;
  if (table === undefined || !ts.isArrayLiteralExpression(table) || binding === undefined ||
      !(ts.isArrayBindingPattern(binding) || ts.isObjectBindingPattern(binding))) return undefined;
  return table.elements.map((row) => {
    const values = new Map();
    binding.elements.forEach((entry, index) => {
      if (!ts.isBindingElement(entry) || !ts.isIdentifier(entry.name)) return;
      const value = ts.isArrayBindingPattern(binding) && ts.isArrayLiteralExpression(row)
        ? row.elements[index] : property(row, entry.propertyName?.text ?? entry.name.text);
      values.set(entry.name.text, value);
    });
    return values;
  });
}

/** Scan actual registrations, not comments or unused permission declarations. Unsupported guards fail closed. */
export function permissionRoutesIn(routeSources) {
  const routes = [];
  const problems = [];
  for (const [file, source] of Object.entries(routeSources)) {
    const tree = parse(file, source);
    if (tree.parseDiagnostics.length > 0) problems.push(`${file} cannot be parsed for permission routes`);
    const constants = new Map();
    const guards = new Map();
    for (const statement of tree.statements) {
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) constants.set(declaration.name.text, declaration.initializer);
      }
    }
    const record = (method, path, need) => {
      const route = `${file} ${method} ${path}`;
      const guard = need !== undefined && ts.isIdentifier(need) ? constants.get(need.text) : need;
      const kind = property(guard, 'kind');
      const permission = property(guard, 'need');
      let signature;
      if (kind !== undefined && ts.isStringLiteral(kind) && ['public', 'session'].includes(kind.text)) {
        signature = kind.text;
      } else if (kind !== undefined && ts.isStringLiteral(kind) && kind.text === 'permission' &&
                 permission !== undefined && (ts.isIdentifier(permission) || ts.isStringLiteral(permission))) {
        signature = permission.getText(tree);
        routes.push(`${route} ${signature}`);
      } else {
        problems.push(`${route} has no recognizable authorization guard`);
        return;
      }
      if (guards.has(route) && guards.get(route) !== signature) problems.push(`${route} declares inconsistent authorization guards`);
      guards.set(route, signature);
    };
    walk(tree, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const call = node.expression;
      if (call.expression.getText(tree) !== 'app') return;
      const method = call.name.text;
      if (method === 'route') {
        const options = node.arguments[0];
        const bindings = tableBindings(node, constants) ?? [new Map()];
        for (const values of bindings) {
          const resolve = (value) => value !== undefined && ts.isIdentifier(value) && values.has(value.text) ? values.get(value.text) : value;
          const verb = resolve(property(options, 'method'));
          const path = resolve(property(options, 'url'));
          if (verb === undefined || !ts.isStringLiteral(verb) || path === undefined) {
            problems.push(`${file} uses app.route with an unrecognized method or URL`);
          } else {
            record(verb.text, path.getText(tree), resolve(property(property(options, 'config'), 'need')));
          }
        }
        return;
      }
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'].includes(method)) return;
      const path = node.arguments[0]?.getText(tree) ?? '<missing path>';
      const need = property(property(node.arguments[1], 'config'), 'need');
      record(method.toUpperCase(), path, need);
    });
  }
  return { routes: [...new Set(routes)], problems };
}

function hasNegativeTest(source, testName) {
  const tree = parse('integration.test.ts', source);
  let found = false;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(tree);
      // Do not accept evidence hidden in skipped/conditional suites or tests.
      if (/^(?:describe|test|it)\./u.test(callee)) return;
      if (['test', 'it'].includes(callee) && node.arguments[0]?.text === testName) {
        const callback = node.arguments[1];
        if (callback === undefined || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return;
        walk(callback.body, (assertion) => {
          if (!ts.isCallExpression(assertion) || !ts.isPropertyAccessExpression(assertion.expression)) return;
          if (!['toBe', 'toEqual'].includes(assertion.expression.name.text) ||
              assertion.arguments[0]?.getText(tree) !== '403') return;
          const expect = assertion.expression.expression;
          if (!ts.isCallExpression(expect) || expect.expression.getText(tree) !== 'expect') return;
          const actual = expect.arguments[0];
          if (actual !== undefined && ts.isPropertyAccessExpression(actual) && actual.name.text === 'status') found = true;
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  if (tree.parseDiagnostics.length === 0) visit(tree);
  return found;
}

export function verifyRoleCoverage({ routeSources, readTest }, {
  tested = ROLE_INTEGRATION_TESTS,
  gaps = KNOWN_INTEGRATION_GAPS,
} = {}) {
  const { routes, problems } = permissionRoutesIn(routeSources);
  for (const route of routes) {
    const isCovered = Object.hasOwn(tested, route);
    const isGap = Object.hasOwn(gaps, route);
    if (!isCovered && !isGap) {
      problems.push(`${route} is a permission route this census does not classify as tested or as a known gap`);
    }
    if (isCovered && isGap) problems.push(`${route} is listed as both tested and a known gap`);
  }
  for (const [route, { testPath, testName }] of Object.entries(tested)) {
    if (!routes.includes(route)) {
      problems.push(`${route} is claimed as tested but is not a permission route on disk`);
    } else {
      const source = readTest(testPath);
      if (source === undefined) {
        problems.push(`${route} is claimed as tested by ${testPath}, which does not exist`);
      } else if (!/^tests\/harness\/integration\/(?:[\w-]+\/)*[\w-]+\.test\.ts$/u.test(testPath) ||
                 !hasNegativeTest(source, testName)) {
        problems.push(`${route} has no enabled HTTP 403 test named ${testName} in ${testPath}`);
      }
    }
  }
  for (const [route, reason] of Object.entries(gaps)) {
    if (!routes.includes(route)) problems.push(`${route} is a known integration gap that is not a permission route on disk`);
    if (typeof reason !== 'string' || reason.trim() === '') problems.push(`${route} has no reason for its known integration gap`);
  }
  return problems;
}

export function readRoles() {
  const routeSources = {};
  for (const entry of readdirSync(fromRepoRoot(ROUTES_DIR), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith('-routes.ts')) {
      routeSources[entry.name] = readFileSync(fromRepoRoot(`${ROUTES_DIR}/${entry.name}`), 'utf8');
    }
  }
  const readTest = (path) => {
    try {
      return readFileSync(fromRepoRoot(path), 'utf8');
    } catch {
      return undefined;
    }
  };
  return { routeSources, readTest };
}
