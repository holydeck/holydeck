// The one list of checks that has to pass before work leaves a machine.
//
// It lives here, in one place, because the alternative is three lists: one in a hook, one in a workflow
// and one in a contributor's head. The hook runs this file; CI runs the same commands and a test in this
// directory holds the two together, so a check added here cannot be a check CI quietly skips.

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Where the hook finds this file, repo-relative, so the hook and the test agree on one path. */
export const GATE_SCRIPT = 'scripts/verify/gate.mjs';

// Cheapest first: the scripted checks take seconds and catch a whole class of mistake, so a developer
// who got a name or a manifest wrong hears about it before waiting out the build.
//
// `verify:stack` is deliberately absent: it needs a running Docker stack, which is a machine's state
// rather than a repository's, and a gate that cannot pass on a laptop with Docker off is a gate people
// learn to skip.
export const REQUIRED_CHECKS = [
  { name: 'the release scripts', command: 'pnpm run test:release' },
  { name: 'the workspace census', command: 'pnpm run test:workspaces' },
  { name: 'this gate and the hooks', command: 'pnpm run test:verify' },
  { name: 'the compose stacks', command: 'pnpm run verify:compose' },
  { name: 'lint', command: 'pnpm turbo run lint' },
  { name: 'typecheck', command: 'pnpm turbo run typecheck' },
  { name: 'every unit and integration suite', command: 'pnpm turbo run test' },
  { name: 'the build', command: 'pnpm turbo run build' },
  { name: 'the browser suite', command: 'pnpm turbo run test:e2e' },
];

/**
 * Runs every check, in order, and keeps going after a failure: someone who has two things to fix should
 * learn both now rather than one per push.
 */
export async function runGate(run) {
  const results = [];
  for (const check of REQUIRED_CHECKS) {
    results.push({ ...check, ok: await run(check.command) });
  }
  return { results, ok: results.every((result) => result.ok) };
}

export function gateReport({ results }) {
  const width = Math.max(...results.map((result) => result.command.length));
  const lines = results.map(
    ({ command, name, ok }) => `${command.padEnd(width)}  ${ok ? 'passed' : 'failed'}  ${name}`,
  );
  const failed = results.filter((result) => !result.ok);
  return [
    ...lines,
    '',
    failed.length === 0
      ? 'Every required check passed.'
      : `${failed.length} of ${results.length} checks failed: ${failed.map((result) => result.command).join(', ')}`,
  ].join('\n');
}

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function runHere(command) {
  try {
    execSync(command, { cwd: repoRoot, stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outcome = await runGate(runHere);
  process.stdout.write(`\n${gateReport(outcome)}\n`);
  process.exitCode = outcome.ok ? 0 : 1;
}
