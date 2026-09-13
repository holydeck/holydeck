import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

import { GATE_SCRIPT, REQUIRED_CHECKS, gateReport, runGate } from './gate.mjs';
import { fromRepoRoot } from '../release/sync-versions.mjs';

const read = (path) => readFileSync(fromRepoRoot(path), 'utf8');
const workflow = () => parse(read('.github/workflows/ci.yml'));

test('the gate names every check a push has to pass, cheapest first', () => {
  assert.deepEqual(
    REQUIRED_CHECKS.map((check) => check.command),
    [
      'pnpm run test:release',
      'pnpm run test:workspaces',
      'pnpm run test:verify',
      'pnpm run verify:compose',
      'pnpm turbo run lint',
      'pnpm turbo run typecheck',
      'pnpm turbo run test',
      'pnpm turbo run build',
      'pnpm turbo run test:e2e',
    ],
  );
  for (const check of REQUIRED_CHECKS) assert.match(check.name, /\S/u);
});

test('every check is run, and a failing one does not hide the ones after it', async () => {
  const ran = [];
  const outcome = await runGate((command) => {
    ran.push(command);
    return command !== 'pnpm turbo run lint';
  });
  assert.deepEqual(ran, REQUIRED_CHECKS.map((check) => check.command));
  assert.equal(outcome.ok, false);
  assert.deepEqual(
    outcome.results.filter((result) => !result.ok).map((result) => result.command),
    ['pnpm turbo run lint'],
  );
});

test('a gate where everything passed says so', async () => {
  const outcome = await runGate(() => true);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results.length, REQUIRED_CHECKS.length);
});

test('the report names every check and what happened to it', async () => {
  const outcome = await runGate((command) => command !== 'pnpm turbo run test');
  const report = gateReport(outcome);
  for (const check of REQUIRED_CHECKS) assert.ok(report.includes(check.name), `${check.name} is not in the report`);
  assert.match(report, /pnpm turbo run test\s+failed/u);
  assert.match(report, /pnpm run test:release\s+passed/u);
});

test('pre-push runs the shared gate rather than a list of its own', () => {
  const hook = read('.husky/pre-push');
  assert.match(hook, new RegExp(GATE_SCRIPT.replace(/[.]/gu, '\\.'), 'u'));
  for (const check of REQUIRED_CHECKS) {
    assert.ok(
      !hook.includes(check.command),
      `pre-push repeats ${check.command}; a second copy of the list is a copy that goes stale`,
    );
  }
});

test('pre-commit runs the staged-file checks, and only those', () => {
  const hook = read('.husky/pre-commit');
  assert.match(hook, /lint-staged/u);
  // The whole point of the fast hook: a commit must not wait for the gate a push runs.
  assert.ok(!hook.includes(GATE_SCRIPT), 'pre-commit runs the push gate, which makes every commit slow');
});

test('the staged-file checks cover every kind of file this repository holds', () => {
  const staged = JSON.parse(read('.lintstagedrc.json'));
  assert.deepEqual(Object.keys(staged), ['*.{ts,mts,mjs,js}', '*.{json,yaml,yml}']);
  // eslint --fix rewrites the file it checks, which is exactly the case partial staging has to survive.
  assert.match(JSON.stringify(staged['*.{ts,mts,mjs,js}']), /eslint --fix/u);
});

test('husky is installed by the repository itself, not by hand', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.scripts.prepare, 'husky');
  assert.equal(manifest.scripts['test:verify'], 'node --test "scripts/verify/**/*.test.mjs"');
  for (const dependency of ['husky', 'lint-staged']) {
    assert.ok(dependency in manifest.devDependencies, `${dependency} is not a devDependency`);
  }
});

test('CI runs every check the gate requires, independently of anyone\'s machine', () => {
  const steps = workflow().jobs.verify.steps.filter((step) => typeof step.run === 'string');
  const commands = steps.map((step) => step.run.trim());
  for (const check of REQUIRED_CHECKS) {
    assert.ok(commands.includes(check.command), `CI does not run ${check.command}`);
  }
});

test('CI runs nothing the gate does not require, so the two cannot drift apart', () => {
  const allowed = new Set([
    'pnpm install --frozen-lockfile',
    'pnpm --filter @holydeck/harness exec playwright install --with-deps chromium',
    ...REQUIRED_CHECKS.map((check) => check.command),
  ]);
  const steps = workflow().jobs.verify.steps.filter((step) => typeof step.run === 'string');
  for (const step of steps) {
    assert.ok(allowed.has(step.run.trim()), `CI runs ${step.run.trim()}, which the gate does not name`);
  }
});

test('a failing check in CI does not stop the report of the others', () => {
  const required = new Set(REQUIRED_CHECKS.map((check) => check.command));
  const steps = workflow().jobs.verify.steps.filter(
    (step) => typeof step.run === 'string' && required.has(step.run.trim()),
  );
  assert.equal(steps.length, REQUIRED_CHECKS.length);
  for (const step of steps) {
    assert.equal(step.if, '${{ !cancelled() }}', `${step.run.trim()} stops the run instead of reporting`);
  }
});
