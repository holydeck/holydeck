// The pre-commit hook, graded by running it.
//
// What it has to protect is narrow and easy to get wrong: a developer who staged one hunk of a file and
// left another in the working tree must get a commit of the first hunk and keep the second, even though
// the checks rewrite the file in between. Asserting that the configuration mentions lint-staged proves
// nothing about it, so this runs the real hook, with the real binary, over a real repository.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { fromRepoRoot } from '../release/sync-versions.mjs';

const FILE = 'service.mjs';
const COMMITTED = ['export const first = 1;', 'export const middle = 2;', 'export const last = 3;', ''].join('\n');
// The staged hunk is a change the checks do not undo, plus whitespace they do: a staged edit that the
// fix erases entirely leaves nothing to commit, which is a different case from this one.
const STAGED = COMMITTED.replace('export const first = 1;', 'export const first = 11;   ');
const BOTH = STAGED.replace('export const last = 3;', 'export const last = 33;');

/** Trailing whitespace removed, in place: a check that rewrites what it was given, like eslint --fix. */
const FIXER = [
  "import { readFileSync, writeFileSync } from 'node:fs';",
  'for (const path of process.argv.slice(2)) {',
  "  writeFileSync(path, readFileSync(path, 'utf8').replace(/[ \\t]+$/gmu, ''));",
  '}',
  '',
].join('\n');

function repository() {
  const directory = mkdtempSync(join(tmpdir(), 'holydeck-hooks-'));
  const git = (...args) =>
    execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', env: { ...process.env, HOME: directory } });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'harness@localhost.invalid');
  git('config', 'user.name', 'Harness');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(directory, FILE), COMMITTED);
  writeFileSync(join(directory, 'fix.mjs'), FIXER);
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'subject', private: true }) + '\n');
  writeFileSync(join(directory, '.lintstagedrc.json'), JSON.stringify({ '*.mjs': ['node fix.mjs'] }) + '\n');
  // The repository's own installed binaries, so what runs here is the version a developer's hook runs,
  // not a copy of lint-staged this test brought along.
  symlinkSync(fromRepoRoot('node_modules'), join(directory, 'node_modules'));
  // The hook under test, byte for byte.
  cpSync(fromRepoRoot('.husky/pre-commit'), join(directory, 'pre-commit'));
  git('add', '.');
  git('commit', '--quiet', '--no-verify', '-m', 'the state before anyone edited anything');
  return { directory, git };
}

test('a commit of one hunk keeps the hunk that was not staged, after the checks rewrote the file', () => {
  const { directory, git } = repository();
  try {
    writeFileSync(join(directory, FILE), STAGED);
    git('add', FILE);
    // The second edit is left where a developer left it: in the working tree, deliberately unstaged.
    writeFileSync(join(directory, FILE), BOTH);

    execFileSync('sh', [join(directory, 'pre-commit')], {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, HOME: directory },
    });
    git('commit', '--quiet', '--no-verify', '-m', 'the staged hunk');

    // What was committed: the staged line, with the checks' fix applied to it.
    const committed = git('show', 'HEAD:' + FILE);
    assert.match(committed, /^export const first = 11;$/mu);
    assert.ok(!committed.includes('last = 33'), 'the unstaged hunk was committed');

    // What is still on disk: the unstaged line, exactly as it was left.
    const working = readFileSync(join(directory, FILE), 'utf8');
    assert.match(working, /^export const last = 33;$/mu);
    assert.match(working, /^export const first = 11;$/mu);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a commit is refused when a staged file does not pass', () => {
  const { directory, git } = repository();
  try {
    writeFileSync(
      join(directory, '.lintstagedrc.json'),
      JSON.stringify({ '*.mjs': ['node -e "process.exit(1)"'] }) + '\n',
    );
    writeFileSync(join(directory, FILE), STAGED);
    git('add', FILE);
    assert.throws(
      () =>
        execFileSync('sh', [join(directory, 'pre-commit')], {
          cwd: directory,
          stdio: 'ignore',
          env: { ...process.env, HOME: directory },
        }),
      /Command failed/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
