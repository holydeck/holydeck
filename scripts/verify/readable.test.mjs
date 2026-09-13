import assert from 'node:assert/strict';
import { test } from 'node:test';

import { unreadable } from './readable.mjs';

const files = {
  'good.json': '{ "name": "holydeck" }',
  'good.yaml': 'services:\n  app:\n    image: holydeck\n',
  'broken.json': '{ "name": }',
  'broken.yaml': 'services:\n  app:\n   image: holydeck\n  - a list as well\n',
  'lenient.json': '{ "name": "holydeck", }',
  // Several documents in one file, which is what pnpm writes its lockfile as.
  'many.yaml': 'importers:\n  .: {}\n---\nsnapshots:\n  eslint: {}\n',
  'many-broken.yaml': 'importers:\n  .: {}\n---\nsnapshots:\n  eslint: {}\n - a list as well\n',
};
const read = (path) => files[path];

test('a pair of files that parse has nothing to report', () => {
  assert.deepEqual(unreadable(['good.json', 'good.yaml'], read), []);
});

test('a broken file is named, with what the parser said about it', () => {
  const [problem, ...rest] = unreadable(['good.json', 'broken.json'], read);
  assert.deepEqual(rest, []);
  assert.match(problem, /^broken\.json: /u);
});

test('a broken YAML file is named the same way', () => {
  assert.equal(unreadable(['broken.yaml'], read).length, 1);
});

test('a .json file is held to JSON, not to the YAML that would accept it', () => {
  // A trailing comma is a flow-mapping nicety in YAML and an error in JSON, and this file is JSON.
  assert.equal(unreadable(['lenient.json'], read).length, 1);
});

test('a file holding several documents is read as all of them', () => {
  assert.deepEqual(unreadable(['many.yaml'], read), []);
});

test('a broken document is reported even when it is not the first in the file', () => {
  const [problem, ...rest] = unreadable(['many-broken.yaml'], read);
  assert.deepEqual(rest, []);
  assert.match(problem, /^many-broken\.yaml: /u);
});

test('every problem is reported, not just the first', () => {
  assert.equal(unreadable(['broken.json', 'broken.yaml'], read).length, 2);
});
