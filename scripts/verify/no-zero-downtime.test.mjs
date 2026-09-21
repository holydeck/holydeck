import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readRepo } from '../workspace/exposure-scan.mjs';
import { verifyNoZeroDowntimeClaim, zeroDowntimeClaimsIn } from './no-zero-downtime.mjs';

const clean = () => ({
  documents: { 'README.md': '# README\n', 'MAINTENANCE.md': '# MAINTENANCE\n' },
  sources: { 'apps/app/src/main.ts': "export const port = 3000;\n" },
});

const withDocument = (file, text) => {
  const input = clean();
  input.documents[file] = text;
  return input;
};

const withSource = (file, text) => {
  const input = clean();
  input.sources[file] = text;
  return input;
};

test('a repository that claims nothing has nothing to report', () => {
  assert.deepEqual(verifyNoZeroDowntimeClaim(clean()), []);
});

test('flags "zero-downtime" wherever a document says it, and where', () => {
  const problems = verifyNoZeroDowntimeClaim(withDocument('README.md', 'This is a zero-downtime deployment.\n'));
  assert.deepEqual(problems, [
    'README.md:1:11: claims "zero-downtime", which this deployment does not guarantee',
  ]);
});

test('flags the phrase with a space instead of a hyphen, and case-insensitively', () => {
  const problems = verifyNoZeroDowntimeClaim(withDocument('MAINTENANCE.md', 'Restarts are Zero Downtime.\n'));
  assert.deepEqual(problems, [
    'MAINTENANCE.md:1:14: claims "Zero Downtime", which this deployment does not guarantee',
  ]);
});

test('flags the claim in shipped source too, and where', () => {
  const problems = verifyNoZeroDowntimeClaim(withSource('apps/app/src/main.ts', "// zero-downtime restarts\n"));
  assert.deepEqual(problems, [
    'apps/app/src/main.ts:1:4: claims "zero-downtime", which this deployment does not guarantee',
  ]);
});

test('finds every claim a piece of text makes, with its line and column', () => {
  const text = 'first line is honest\nsecond claims zero-downtime and then zero downtime too\n';
  assert.deepEqual(zeroDowntimeClaimsIn(text), [
    { line: 2, column: 15, said: 'zero-downtime' },
    { line: 2, column: 38, said: 'zero downtime' },
  ]);
});

test('leaves an honest description of restart behavior alone', () => {
  const text = 'A planned restart interrupts live sessions briefly; runs resume from persisted state once the app is back.\n';
  assert.deepEqual(verifyNoZeroDowntimeClaim(withDocument('MAINTENANCE.md', text)), []);
});

test('this repository claims no zero-downtime deployment', () => {
  assert.deepEqual(verifyNoZeroDowntimeClaim(readRepo()), []);
});
