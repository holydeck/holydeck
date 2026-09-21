import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SHIPPED_FILES, infraDetailsIn, readRepo, verifyExposure } from './exposure-scan.mjs';

const clean = () => ({
  documents: Object.fromEntries(SHIPPED_FILES.map((file) => [file, `# ${file}\n`])),
  sources: {
    'apps/app/src/app.ts': "export const corpusUrl = 'http://server:3000';\n",
    'packages/core/src/config.ts': "export const dataDir = join(homeDir, '.local', 'share');\n",
  },
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

test('a repository that names no real infrastructure has nothing to report', () => {
  assert.deepEqual(verifyExposure(clean()), []);
});

// The bullet in its own words: a deliberately added internal detail fails the review.
test('a deliberately added internal detail fails the public-exposure review', () => {
  const problems = verifyExposure(withDocument('README.md', 'Connect the corpus to db01.internal for now.\n'));
  assert.deepEqual(problems, ['README.md:1:23: names db01.internal, a private infrastructure detail']);
});

test('flags a private IPv4 address wherever it is shipped, and where', () => {
  const problems = verifyExposure(withDocument('compose.yaml', '# reachable at 10.20.30.40 on the ops network\n'));
  assert.deepEqual(problems, ['compose.yaml:1:16: names 10.20.30.40, a private infrastructure detail']);
});

test('flags every private range, not only one', () => {
  for (const address of ['10.4.2.9', '172.16.4.4', '172.31.255.255', '192.168.0.4']) {
    const problems = verifyExposure(withDocument('SECURITY.md', `${address}\n`));
    assert.deepEqual(problems, [`SECURITY.md:1:1: names ${address}, a private infrastructure detail`]);
  }
});

test('leaves loopback, a public address and a routable-looking third octet alone', () => {
  const text = '127.0.0.1 and ::1 and 8.8.8.8 and 172.32.0.1 and 172.8.0.1 and 11.0.0.1\n';
  assert.deepEqual(verifyExposure(withDocument('README.md', text)), []);
});

test('flags an internal-only hostname suffix in shipped source, and where', () => {
  const problems = verifyExposure(withSource('apps/worker/src/queue.ts', "throw new Error('unreachable: worker-01.internal');\n"));
  assert.deepEqual(problems, [
    'apps/worker/src/queue.ts:1:31: names worker-01.internal, a private infrastructure detail',
  ]);
});

test('leaves a public domain and a bare XDG path alone, because neither names real infrastructure', () => {
  const input = clean();
  input.documents['README.md'] = 'See https://corpus.example.com and ~/.local/share/holydeck.\n';
  assert.deepEqual(verifyExposure(input), []);
});

test('leaves tests alone, because a test has to name a realistic address to prove redaction removes one', () => {
  const input = withSource('apps/app/src/redaction.test.ts', "const leak = 'mongodb://root:hunter2@db.internal:27017';\n");
  assert.deepEqual(verifyExposure(input), []);
});

test('refuses a shipped file that is missing, rather than passing a review of nothing', () => {
  const input = clean();
  delete input.documents['SECURITY.md'];
  assert.deepEqual(verifyExposure(input), ['SECURITY.md: ships with the deployment and was not found']);
});

test('finds every private detail a piece of text names, with its line and column', () => {
  const text = 'first line is clean\nsecond names 10.0.0.1 and then db.internal too\n';
  assert.deepEqual(infraDetailsIn(text), [
    { line: 2, column: 14, said: '10.0.0.1' },
    { line: 2, column: 32, said: 'db.internal' },
  ]);
});

test('this repository names no real infrastructure', () => {
  assert.deepEqual(verifyExposure(readRepo()), []);
});
