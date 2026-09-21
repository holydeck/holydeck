import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BROWSER_SAFE_WORKSPACES,
  importsOf,
  nodeOnlyImport,
  readRepo,
  verifyBrowserSafety,
} from './browser-safety.mjs';

const clean = () => ({
  sources: {
    'packages/contracts': {
      'packages/contracts/src/http.ts': "import { ok } from './problems.js';\nexport const a = ok;\n",
      'packages/contracts/src/problems.ts': 'export const ok = 1;\n',
      'packages/contracts/src/http.test.ts': "import { readFileSync } from 'node:fs';\nreadFileSync;\n",
    },
    'packages/localization': {
      'packages/localization/src/messages.ts': "import { n } from './format.js';\nexport const c = n;\n",
      'packages/localization/src/format.ts': 'export const n = 2;\n',
    },
    'packages/renderer': {
      'packages/renderer/src/render.ts': "import { ok } from '@holydeck/contracts/problems';\nexport const e = ok;\n",
    },
    'apps/web': {
      'apps/web/src/api.ts': "import { ok } from '@holydeck/contracts/problems';\nexport const b = ok;\n",
      'apps/web/src/shell.ts': "import { t } from '@holydeck/localization/messages';\nexport const d = t;\n",
    },
  },
  manifests: {
    'packages/contracts': '{"name":"@holydeck/contracts"}',
    'packages/localization': '{"name":"@holydeck/localization"}',
    'packages/renderer': '{"name":"@holydeck/renderer","dependencies":{"@holydeck/contracts":"workspace:*"}}',
    'apps/web':
      '{"name":"@holydeck/web","dependencies":{"@holydeck/contracts":"workspace:*","@holydeck/localization":"workspace:*"}}',
  },
});

const withSource = (file, text) => {
  const input = clean();
  input.sources['packages/contracts'][file] = text;
  return input;
};

test('the browser-safe workspaces are the ones shipped code reaches the browser through', () => {
  assert.deepEqual(BROWSER_SAFE_WORKSPACES, [
    'packages/contracts',
    'packages/localization',
    'packages/renderer',
    'apps/web',
  ]);
});

test('every kind of import is collected, including the ones a naive scan misses', () => {
  const text = [
    "import { a } from 'node:fs';",
    "import type { B } from './b.js';",
    "import defaultExport from 'c';",
    "export { d } from './d.js';",
    "export * from './e.js';",
    "const f = await import('node:path');",
    "const notAnImport = 'import { g } from \"node:os\"';",
    "// import { h } from 'node:vm';",
    "/* import { i } from 'node:zlib'; */",
  ].join('\n');
  assert.deepEqual(importsOf(text), ['node:fs', './b.js', 'c', './d.js', './e.js', 'node:path']);
});

test('a Node builtin is recognised however it is spelled', () => {
  assert.equal(nodeOnlyImport('node:fs'), 'node:fs');
  assert.equal(nodeOnlyImport('fs/promises'), 'fs/promises');
  assert.equal(nodeOnlyImport('path'), 'path');
  assert.equal(nodeOnlyImport('node:test'), 'node:test');
  assert.equal(nodeOnlyImport('vitest'), undefined);
  assert.equal(nodeOnlyImport('./problems.js'), undefined);
  assert.equal(nodeOnlyImport('@holydeck/contracts/http'), undefined);
});

test('a clean pair of workspaces raises nothing', () => {
  assert.deepEqual(verifyBrowserSafety(clean()), []);
});

test('a prefixed Node import in shipped source is refused', () => {
  assert.deepEqual(verifyBrowserSafety(withSource('packages/contracts/src/live.ts', "import { readFileSync } from 'node:fs';\n")), [
    'packages/contracts/src/live.ts: imports node:fs, which exists only in Node',
  ]);
});

test('a bare Node import in shipped source is refused', () => {
  assert.deepEqual(verifyBrowserSafety(withSource('packages/contracts/src/live.ts', "import { join } from 'path';\n")), [
    'packages/contracts/src/live.ts: imports path, which exists only in Node',
  ]);
});

test('a Node builtin reached through a dynamic import is refused', () => {
  assert.deepEqual(verifyBrowserSafety(withSource('packages/contracts/src/live.ts', "export const l = () => import('node:crypto');\n")), [
    'packages/contracts/src/live.ts: imports node:crypto, which exists only in Node',
  ]);
});

test('a test file may use Node, because a test never reaches a browser', () => {
  assert.deepEqual(verifyBrowserSafety(withSource('packages/contracts/src/live.test.ts', "import { readFileSync } from 'node:fs';\n")), []);
});

test('a relative import that leaves the workspace is refused, because the gate cannot see where it goes', () => {
  assert.deepEqual(
    verifyBrowserSafety(withSource('packages/contracts/src/live.ts', "import { x } from '../../core/src/storage.js';\n")),
    ['packages/contracts/src/live.ts: imports ../../core/src/storage.js, which is outside packages/contracts/src'],
  );
});

test('a relative import of a file that does not exist is refused', () => {
  assert.deepEqual(verifyBrowserSafety(withSource('packages/contracts/src/live.ts', "import { x } from './absent.js';\n")), [
    'packages/contracts/src/live.ts: imports ./absent.js, which is outside packages/contracts/src',
  ]);
});

test('a runtime dependency outside the workspace is refused, because the gate cannot read its transitive imports', () => {
  const input = clean();
  input.manifests['packages/contracts'] = '{"name":"@holydeck/contracts","dependencies":{"yaml":"^2.9.0"}}';
  assert.deepEqual(verifyBrowserSafety(input), [
    'packages/contracts/package.json depends on yaml at run time, which is not a browser-safe workspace',
  ]);
});

test('a runtime dependency on a workspace nothing keeps browser-safe is refused', () => {
  const input = clean();
  input.manifests['packages/contracts'] = '{"name":"@holydeck/contracts","dependencies":{"@holydeck/core":"workspace:*"}}';
  assert.deepEqual(verifyBrowserSafety(input), [
    'packages/contracts/package.json depends on @holydeck/core at run time, which is not a browser-safe workspace',
  ]);
});

test('a workspace with no source at all is refused rather than passing for having nothing to check', () => {
  const input = clean();
  input.sources['apps/web'] = {};
  assert.deepEqual(verifyBrowserSafety(input), ['apps/web/src holds no TypeScript source to check']);
});

test('a workspace with no manifest is refused', () => {
  const input = clean();
  delete input.manifests['apps/web'];
  assert.deepEqual(verifyBrowserSafety(input), ['apps/web/package.json is missing']);
});

test('the repository itself keeps every browser-safe workspace free of Node', () => {
  assert.deepEqual(verifyBrowserSafety(readRepo()), []);
});
