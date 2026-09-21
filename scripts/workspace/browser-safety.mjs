// Browser-safety gate for the shared contracts. FND-04 asks for contracts that "contain no Node-only
// imports", and the honest reading of that is a property of a graph rather than of a file: a package
// with a clean first line can still pull `node:fs` in through a dependency three levels down. Two
// rules make the graph checkable here. Shipped source may not import a Node builtin at all, and a
// browser-safe workspace may only take another browser-safe workspace as a runtime dependency — so
// every path out of the package ends somewhere this file has already read. Test files are exempt on
// purpose: a test runs in Node and never reaches a browser, and excluding them is what lets a test
// read a file from disk without weakening the rule about the code that ships.

import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { fromRepoRoot } from './pipeline.mjs';

export const BROWSER_SAFE_WORKSPACES = [
  'packages/contracts',
  'packages/localization',
  'packages/renderer',
  'apps/web',
];

// Node's own builtin list, in the bare spelling that predates the `node:` prefix. The prefixed form
// needs no list at all, which is why it is handled separately.
export const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https',
  'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty',
  'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

const readStringLiteral = (text, start, quote) => {
  let value = '';
  let index = start + 1;
  while (index < text.length && text[index] !== quote) {
    if (text[index] === '\\') {
      value += text[index + 1] ?? '';
      index += 2;
      continue;
    }
    value += text[index];
    index += 1;
  }
  return { value, end: index + 1 };
};

// Splits source into code and string-literal tokens, dropping comments. A regular expression over the
// raw text cannot tell an import from the word "import" inside a string or a comment, and both appear
// in this repository's own explanatory prose.
const tokenize = (text) => {
  const tokens = [];
  let code = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const following = text[index + 1];
    if (character === '/' && following === '/') {
      const newline = text.indexOf('\n', index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    if (character === '/' && following === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? text.length : close + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const literal = readStringLiteral(text, index, character);
      tokens.push({ kind: 'code', value: code }, { kind: 'string', value: literal.value });
      code = '';
      index = literal.end;
      continue;
    }
    code += character;
    index += 1;
  }
  tokens.push({ kind: 'code', value: code });
  return tokens;
};

const SPECIFIER_POSITION = /(?:\bfrom|\bimport\s*\(|\bimport|\brequire\s*\()\s*$/u;

/** Every module specifier the source actually imports, in source order. */
export function importsOf(text) {
  const tokens = tokenize(text);
  const specifiers = [];
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== 'string') continue;
    if (SPECIFIER_POSITION.test(tokens[index - 1]?.value ?? '')) specifiers.push(token.value);
  }
  return specifiers;
}

/** The specifier itself when it names a Node builtin, otherwise undefined. */
export function nodeOnlyImport(specifier) {
  if (specifier.startsWith('node:')) return specifier;
  return NODE_BUILTINS.has(specifier.split('/')[0]) ? specifier : undefined;
}

const resolveRelative = (file, specifier) => {
  const segments = file.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.') continue;
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join('/').replace(/\.js$/u, '.ts');
};

const workspacePackageName = (dir) => `@holydeck/${dir.split('/').at(-1)}`;

/**
 * Grades the browser-safe workspaces. `sources` is keyed by workspace directory and then by
 * repository-relative file path; `manifests` is keyed by workspace directory.
 */
export function verifyBrowserSafety({ sources, manifests }) {
  const problems = [];
  const safeNames = BROWSER_SAFE_WORKSPACES.map(workspacePackageName);

  for (const dir of BROWSER_SAFE_WORKSPACES) {
    const files = sources[dir] ?? {};
    const paths = Object.keys(files);
    if (paths.length === 0) problems.push(`${dir}/src holds no TypeScript source to check`);

    const manifestText = manifests[dir];
    if (manifestText === undefined) {
      problems.push(`${dir}/package.json is missing`);
    } else {
      for (const name of Object.keys(JSON.parse(manifestText).dependencies ?? {})) {
        if (!safeNames.includes(name)) {
          problems.push(`${dir}/package.json depends on ${name} at run time, which is not a browser-safe workspace`);
        }
      }
    }

    for (const file of paths) {
      if (file.endsWith('.test.ts')) continue;
      for (const specifier of importsOf(files[file])) {
        const builtin = nodeOnlyImport(specifier);
        if (builtin !== undefined) {
          problems.push(`${file}: imports ${builtin}, which exists only in Node`);
          continue;
        }
        if (!specifier.startsWith('.')) continue;
        if (files[resolveRelative(file, specifier)] === undefined) {
          problems.push(`${file}: imports ${specifier}, which is outside ${dir}/src`);
        }
      }
    }
  }

  return problems;
}

export function readRepo() {
  const sources = {};
  const manifests = {};
  for (const dir of BROWSER_SAFE_WORKSPACES) {
    sources[dir] = {};
    let entries;
    try {
      entries = readdirSync(fromRepoRoot(`${dir}/src`), { recursive: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const relative = entry.split(/[\\/]/u).join('/');
      if (!relative.endsWith('.ts')) continue;
      sources[dir][`${dir}/src/${relative}`] = readFileSync(fromRepoRoot(`${dir}/src/${relative}`), 'utf8');
    }
    try {
      manifests[dir] = readFileSync(fromRepoRoot(`${dir}/package.json`), 'utf8');
    } catch {
      manifests[dir] = undefined;
    }
  }
  return { sources, manifests };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = verifyBrowserSafety(readRepo());
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}
