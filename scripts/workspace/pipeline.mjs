// Membership gate for the root pipeline. `turbo run <task>` only runs a task in the packages that
// declare it, so a workspace missing a script — or missing from pnpm-workspace.yaml altogether — is
// not an error to turbo: the root command stays green and simply never looks at that package. This
// script is what turns that silence into a failure, and it is the reason the root commands can be
// trusted to cover every workspace rather than whichever ones happen to be wired up.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const fromRepoRoot = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

// The four tasks turbo.json declares. Every workspace runs all four; a package with nothing to lint
// or nothing to build still declares the script, because "no script" and "nothing to do" are
// indistinguishable from the root and only one of them is intentional.
export const PIPELINE_TASKS = ['build', 'test', 'lint', 'typecheck'];

export const WORKSPACES = [
  'packages/core',
  'packages/contracts',
  'apps/cli',
  'apps/corpus',
  'apps/app',
  'apps/web',
  'apps/worker',
];

export const COVERAGE_BASE = 'vitest.base.ts';

// Exactly one workspace is published to a registry. Everything else is private, and a package that
// quietly stops being private is a package that can be published by accident.
export const PUBLISHED_WORKSPACE = 'apps/cli';

const COVERAGE_METRICS = ['statements', 'branches', 'functions', 'lines'];

// pnpm-workspace.yaml is read as text rather than parsed: the only thing needed from it is the list
// of package globs, and matching them here keeps this script free of a YAML dependency.
export function workspaceGlobsOf(yamlText) {
  const globs = [];
  let inPackages = false;
  for (const line of yamlText.split('\n')) {
    if (/^packages:\s*$/u.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const entry = /^\s+-\s+(\S+)\s*$/u.exec(line);
      if (entry === null) break;
      globs.push(entry[1]);
    }
  }
  return globs;
}

const matchesGlob = (glob, dir) => {
  const [prefix, rest] = glob.split('*');
  if (rest === undefined) return glob === dir;
  return dir.startsWith(prefix) && rest === '' && !dir.slice(prefix.length).includes('/');
};

/**
 * Grades the repository layout against the pipeline it claims to have. `manifests` and
 * `vitestConfigs` are keyed by workspace directory; a missing key means the file is absent.
 */
export function verifyPipeline({ workspaceYaml, manifests, vitestConfigs, coverageBase }) {
  const problems = [];
  const globs = workspaceGlobsOf(workspaceYaml ?? '');

  if (coverageBase === undefined) {
    problems.push(`${COVERAGE_BASE} is missing`);
  } else {
    for (const metric of COVERAGE_METRICS) {
      if (!new RegExp(`\\b${metric}:\\s*100\\b`, 'u').test(coverageBase)) {
        problems.push(`${COVERAGE_BASE} does not hold ${metric} at 100`);
      }
    }
  }

  for (const dir of WORKSPACES) {
    if (!globs.some((glob) => matchesGlob(glob, dir))) {
      problems.push(`${dir} is not matched by any pnpm-workspace.yaml package glob`);
    }

    const manifestText = manifests[dir];
    if (manifestText === undefined) {
      problems.push(`${dir}/package.json is missing`);
      continue;
    }
    const manifest = JSON.parse(manifestText);

    const expectedName = `@holydeck/${dir.split('/').at(-1)}`;
    if (manifest.name !== expectedName) {
      problems.push(`${dir}/package.json has name ${manifest.name}, expected ${expectedName}`);
    }
    if (manifest.type !== 'module') problems.push(`${dir}/package.json is not "type": "module"`);
    if (dir === PUBLISHED_WORKSPACE) {
      if (manifest.private === true) problems.push(`${dir}/package.json is private and cannot be published`);
    } else if (manifest.private !== true) {
      problems.push(`${dir}/package.json is not private`);
    }

    for (const task of PIPELINE_TASKS) {
      if (manifest.scripts?.[task] === undefined) {
        problems.push(`${dir}/package.json declares no ${task} script, so turbo run ${task} skips it`);
      }
    }

    // A package is free to add excludes and timeouts of its own, but the thresholds themselves come
    // from one file, so lowering them anywhere is a visible edit to a file every package imports.
    const vitestConfig = vitestConfigs[dir];
    if (vitestConfig === undefined) {
      problems.push(`${dir}/vitest.config.ts is missing`);
    } else if (!vitestConfig.includes(COVERAGE_BASE.replace(/\.ts$/u, '.js'))) {
      problems.push(`${dir}/vitest.config.ts does not take its coverage thresholds from ${COVERAGE_BASE}`);
    }
  }

  return problems;
}

export function readRepo() {
  const read = (path) => {
    try {
      return readFileSync(fromRepoRoot(path), 'utf8');
    } catch {
      return undefined;
    }
  };
  const manifests = {};
  const vitestConfigs = {};
  for (const dir of WORKSPACES) {
    manifests[dir] = read(`${dir}/package.json`);
    vitestConfigs[dir] = read(`${dir}/vitest.config.ts`);
  }
  return { workspaceYaml: read('pnpm-workspace.yaml'), manifests, vitestConfigs, coverageBase: read(COVERAGE_BASE) };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = verifyPipeline(readRepo());
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}
