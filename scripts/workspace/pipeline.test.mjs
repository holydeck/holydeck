import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PIPELINE_TASKS,
  PUBLISHED_WORKSPACE,
  WORKSPACES,
  packageDirsOn,
  readRepo,
  verifyPipeline,
  workspaceGlobsOf,
} from './pipeline.mjs';

const manifest = (dir, overrides = {}) => {
  const scripts = {};
  for (const task of PIPELINE_TASKS) scripts[task] = `run-${task}`;
  return JSON.stringify({
    name: `@holydeck/${dir.split('/').at(-1)}`,
    private: dir !== PUBLISHED_WORKSPACE,
    type: 'module',
    scripts,
    ...overrides,
  });
};

const complete = () => {
  const manifests = {};
  const vitestConfigs = {};
  for (const dir of WORKSPACES) {
    manifests[dir] = manifest(dir);
    vitestConfigs[dir] = "import { coverageFloor, testRetry } from '../../vitest.base.js';\n";
  }
  return {
    workspaceYaml: 'packages:\n  - packages/*\n  - apps/*\n  - tests/*\noverrides:\n  esbuild: 0.28.2\n',
    packageDirs: [...WORKSPACES],
    manifests,
    vitestConfigs,
    coverageBase:
      'export const coverageFloor = { statements: 70, branches: 60, functions: 70, lines: 70 };\n' +
      'export const testRetry = 1;\n',
  };
};

test('a repository whose pipeline covers every workspace has no problems', () => {
  assert.deepEqual(verifyPipeline(complete()), []);
});

// Each case names the diagnostic it provokes, written from the check rather than pasted from its
// output, so a check that starts reporting something else fails here instead of passing quietly.
const COUNTEREXAMPLES = [
  {
    why: 'a workspace outside every package glob is invisible to pnpm and to turbo',
    break: (input) => {
      input.workspaceYaml = 'packages:\n  - packages/*\n';
    },
    problems: [
      'apps/cli is not matched by any pnpm-workspace.yaml package glob',
      'apps/corpus is not matched by any pnpm-workspace.yaml package glob',
      'apps/app is not matched by any pnpm-workspace.yaml package glob',
      'apps/web is not matched by any pnpm-workspace.yaml package glob',
      'apps/worker is not matched by any pnpm-workspace.yaml package glob',
      'tests/harness is not matched by any pnpm-workspace.yaml package glob',
    ],
  },
  {
    why: 'a workspace with no manifest is not a workspace',
    break: (input) => {
      delete input.manifests['apps/web'];
    },
    problems: ['apps/web/package.json is missing'],
  },
  {
    why: 'a package under the wrong name is a package the release gate cannot recognise',
    break: (input) => {
      input.manifests['apps/worker'] = manifest('apps/worker', { name: '@holydeck/jobs' });
    },
    problems: ['apps/worker/package.json has name @holydeck/jobs, expected @holydeck/worker'],
  },
  {
    why: 'a CommonJS package cannot be imported by the ESM the rest of the repository is written in',
    break: (input) => {
      input.manifests['apps/app'] = manifest('apps/app', { type: 'commonjs' });
    },
    problems: ['apps/app/package.json is not "type": "module"'],
  },
  {
    why: 'a package that stops being private is a package publishable by accident',
    break: (input) => {
      input.manifests['apps/app'] = manifest('apps/app', { private: false });
    },
    problems: ['apps/app/package.json is not private'],
  },
  {
    why: 'the one package meant for a registry cannot be private',
    break: (input) => {
      input.manifests[PUBLISHED_WORKSPACE] = manifest(PUBLISHED_WORKSPACE, { private: true });
    },
    problems: [`${PUBLISHED_WORKSPACE}/package.json is private and cannot be published`],
  },
  {
    why: 'turbo skips a task the package does not declare, and reports success for the run',
    break: (input) => {
      input.manifests['apps/web'] = manifest('apps/web', { scripts: { build: 'run-build' } });
    },
    problems: [
      'apps/web/package.json declares no test script, so turbo run test skips it',
      'apps/web/package.json declares no lint script, so turbo run lint skips it',
      'apps/web/package.json declares no typecheck script, so turbo run typecheck skips it',
    ],
  },
  {
    why: 'a package holding its own thresholds can lower them without touching a shared file',
    break: (input) => {
      input.vitestConfigs['apps/worker'] = 'thresholds: { statements: 80 }\n';
    },
    problems: [
      'apps/worker/vitest.config.ts does not take its coverage thresholds from vitest.base.ts',
      'apps/worker/vitest.config.ts does not take its retry count from vitest.base.ts',
    ],
  },
  {
    why: 'a workspace with no vitest configuration runs no tests and reports no coverage',
    break: (input) => {
      delete input.vitestConfigs['apps/app'];
    },
    problems: ['apps/app/vitest.config.ts is missing'],
  },
  {
    why: 'thresholds below the floor in the shared file lower them everywhere at once',
    break: (input) => {
      input.coverageBase =
        'export const coverageFloor = { statements: 70, branches: 20, functions: 70, lines: 70 };\n' +
        'export const testRetry = 1;\n';
    },
    problems: ['vitest.base.ts does not hold branches at 60'],
  },
  {
    why: 'a shared file with no retry constant lets a workspace silently run with none',
    break: (input) => {
      input.coverageBase = 'export const coverageFloor = { statements: 70, branches: 60, functions: 70, lines: 70 };\n';
    },
    problems: ['vitest.base.ts does not hold testRetry at 1'],
  },
  {
    why: 'a config that stops importing the shared retry can set its own, unreviewed',
    break: (input) => {
      input.vitestConfigs['apps/worker'] = "import { coverageFloor } from '../../vitest.base.js';\n";
    },
    problems: ['apps/worker/vitest.config.ts does not take its retry count from vitest.base.ts'],
  },
  {
    why: 'no shared file at all is the same lowering, spelled differently',
    break: (input) => {
      delete input.coverageBase;
    },
    problems: ['vitest.base.ts is missing'],
  },
  {
    why: 'a package on disk the census never names is one no root command ever runs',
    break: (input) => {
      input.packageDirs.push('packages/invented');
    },
    problems: ['packages/invented is a package on disk that the pipeline census does not declare'],
  },
];

for (const counterexample of COUNTEREXAMPLES) {
  test(`refuses a pipeline where ${counterexample.why}`, () => {
    const input = complete();
    counterexample.break(input);
    assert.deepEqual(verifyPipeline(input), counterexample.problems);
  });
}

test('a glob matches one directory level and not the ones below it', () => {
  assert.deepEqual(workspaceGlobsOf('packages:\n  - packages/*\n  - apps/*\nother: 1\n'), [
    'packages/*',
    'apps/*',
  ]);
  const input = complete();
  input.manifests['apps/nested/deep'] = manifest('apps/nested/deep');
  assert.deepEqual(verifyPipeline({ ...input, workspaceYaml: 'packages:\n  - apps/*\n' }).slice(0, 1), [
    'packages/core is not matched by any pnpm-workspace.yaml package glob',
  ]);
});

// Discovery is what makes the census two-way: WORKSPACES is hand-written, and a package nobody adds to
// it is invisible to every rule above, because they all iterate the list rather than the repository.
test('discovery finds a package under a glob, and an exact path that is one', () => {
  const listing = { packages: ['core', 'localization', 'notes'], tools: ['scratch'] };
  const manifests = new Set(['packages/core', 'packages/localization', 'tools/exact']);
  const dirs = packageDirsOn(
    ['packages/*', 'tools/*', 'tools/exact'],
    (parent) => listing[parent] ?? [],
    (dir) => manifests.has(dir),
  );
  assert.deepEqual(dirs, ['packages/core', 'packages/localization', 'tools/exact']);
});

// A checkout being prepared has the glob before it has the directory, and a census that crashes there
// reports a stack trace where it should report the workspace it could not find.
test('discovery reports nothing for a glob whose directory is not there yet', () => {
  assert.deepEqual(
    packageDirsOn(['tests/*'], () => {
      throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
    }, () => false),
    [],
  );
});

// The checks above all run against constructed input. This one runs them against the repository, so
// a check that only ever grades a fixture cannot pass for the repository it was written to grade.
test('the repository itself covers every workspace in the root pipeline', () => {
  assert.deepEqual(verifyPipeline(readRepo()), []);
});
