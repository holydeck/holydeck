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
  for (const address of ['10.4.2.9', '172.16.4.4', '172.31.255.255', '192.168.0.4', '169.254.169.254']) {
    const problems = verifyExposure(withDocument('SECURITY.md', `${address}\n`));
    assert.deepEqual(problems, [`SECURITY.md:1:1: names ${address}, a private infrastructure detail`]);
  }
});

test('leaves loopback, a public address and a routable-looking third octet alone', () => {
  const text = '127.0.0.1 and ::1 and 8.8.8.8 and 172.32.0.1 and 172.8.0.1 and 11.0.0.1\n';
  assert.deepEqual(verifyExposure(withDocument('README.md', text)), []);
});

test('flags an IPv6 unique-local address (fd00::/8), and where', () => {
  const problems = verifyExposure(withDocument('SECURITY.md', 'reachable at fd12:3456:789a::1 on the ops network\n'));
  assert.deepEqual(problems, ['SECURITY.md:1:14: names fd12:3456:789a::1, a private infrastructure detail']);
});

test('flags an IPv6 link-local address (fe80::/10), and where', () => {
  const problems = verifyExposure(withDocument('SECURITY.md', 'link-local at fe80::a1b2:c3d4 for now\n'));
  assert.deepEqual(problems, ['SECURITY.md:1:15: names fe80::a1b2:c3d4, a private infrastructure detail']);
});

test('flags an IPv4 link-local / cloud-metadata address (169.254.0.0/16), and where', () => {
  const problems = verifyExposure(withDocument('SECURITY.md', '# metadata at 169.254.169.254 on the ops network\n'));
  assert.deepEqual(problems, ['SECURITY.md:1:15: names 169.254.169.254, a private infrastructure detail']);
});

test('leaves IPv6 loopback and a public IPv6 address alone', () => {
  const text = '::1 and 2001:db8::1 and 2606:4700:4700::1111\n';
  assert.deepEqual(verifyExposure(withDocument('README.md', text)), []);
});

test('flags an internal-only hostname suffix in shipped source, and where', () => {
  const problems = verifyExposure(withSource('apps/worker/src/queue.ts', "throw new Error('unreachable: worker-01.internal');\n"));
  assert.deepEqual(problems, [
    'apps/worker/src/queue.ts:1:31: names worker-01.internal, a private infrastructure detail',
  ]);
});

test('flags an internal detail in apps/web/Dockerfile.dev, a shipped file this census also reads', () => {
  const problems = verifyExposure(withDocument('apps/web/Dockerfile.dev', 'ENV UPSTREAM=db01.internal\n'));
  assert.deepEqual(problems, ['apps/web/Dockerfile.dev:1:14: names db01.internal, a private infrastructure detail']);
});

test('flags an internal detail in apps/cli/README.md, the document the npm package ships', () => {
  const problems = verifyExposure(withDocument('apps/cli/README.md', 'Point at db01.internal for now.\n'));
  assert.deepEqual(problems, ['apps/cli/README.md:1:10: names db01.internal, a private infrastructure detail']);
});

test('flags a private detail in shipped source that is not TypeScript, and where', () => {
  const problems = verifyExposure(withSource('apps/web/src/static/index.html', '<!-- talk to db01.internal -->\n'));
  assert.deepEqual(problems, [
    'apps/web/src/static/index.html:1:14: names db01.internal, a private infrastructure detail',
  ]);
});

test('leaves test-like non-TypeScript source alone too, the same room .test.ts already gets', () => {
  const input = withSource('apps/web/src/static/fixture.test.html', '<!-- db01.internal -->\n');
  assert.deepEqual(verifyExposure(input), []);
});

// The sweep itself, not just the grading: apps/web/src/static/index.html and app.css are real shipped
// source under a SCANNED_ROOTS path — this is what proves readRepo() no longer skips them outright, which
// is the half of the fix verifyExposure()-level tests (fed a synthetic sources map) cannot exercise.
test('readRepo sweeps real shipped source that is not TypeScript too, not only .ts', () => {
  const { sources } = readRepo();
  assert.ok('apps/web/src/static/index.html' in sources, 'index.html should be swept');
  assert.ok('apps/web/src/static/app.css' in sources, 'app.css should be swept');
  assert.ok(!('apps/web/src/static/icons/icon-192.png' in sources), 'a binary file should not be read as text');
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
