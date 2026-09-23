import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentBranch, guardBranch } from './guard-branch.mjs';

test('accepts the run when the current branch matches the required one', () => {
  assert.doesNotThrow(() => guardBranch('main', 'main'));
  assert.doesNotThrow(() => guardBranch('next', 'next'));
});

test('rejects a stable release attempted from next', () => {
  assert.throws(() => guardBranch('main', 'next'), /must be run from the 'main' branch.*'next'/);
});

test('rejects a next prerelease attempted from main', () => {
  assert.throws(() => guardBranch('next', 'main'), /must be run from the 'next' branch.*'main'/);
});

test('rejects a release attempted from an unrelated branch', () => {
  assert.throws(() => guardBranch('main', 'feature/x'), /must be run from the 'main' branch.*'feature\/x'/);
});

test('currentBranch reads and trims the injected exec output', () => {
  const calls = [];
  const exec = (...args) => {
    calls.push(args);
    return 'next\n';
  };

  assert.equal(currentBranch(exec), 'next');
  assert.deepEqual(calls, [['git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }]]);
});
