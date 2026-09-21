// The public-exposure review, DEPL-02's other half. scripts/stack/verify.mjs proves nothing outside the
// deployment can reach the corpus, the worker or MongoDB; this proves nothing shipped with the deployment
// — a configuration file, a document, or the source that composes a log line or an error message — names
// where they actually run. A Compose service name like `mongo` or `server` is not that: it answers to
// nothing outside this stack's own network and says nothing about the machine the stack is deployed on.
// What this refuses is the address of real infrastructure: a private IPv4 address, or a hostname carrying
// a suffix that only resolves on somebody's own network.
//
// Two kinds of file, because "shipped" means two different things. The configuration and documentation
// this repository ships are named outright, the same way terminology.mjs's GUARDED_FILES are, because
// there is a fixed, small set of them and each is read whole. The source that could compose a log line or
// an error message is not fixed, so it is swept the way tenant-neutral.mjs sweeps records: every shipped
// text source file under apps and packages, tests excluded, because a test has to be able to name a
// realistic-looking address to prove the redaction it is testing actually removes one. "Test" is not only
// `*.test.ts` here — there is no `.test.html`/`.test.css` convention in this repository to lean on, so any
// file whose name ends `.test.<extension>` is excluded, whatever the extension.

import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { fromRepoRoot } from './pipeline.mjs';

/** Every configuration file and document this repository ships with the deployment. */
export const SHIPPED_FILES = [
  'README.md',
  'RELEASING.md',
  'SECURITY.md',
  'MAINTENANCE.md',
  'CHANGELOG.md',
  'compose.yaml',
  'compose.dev.yaml',
  'compose.test.yaml',
  'apps/app/Dockerfile',
  'apps/corpus/Dockerfile',
  'apps/corpus/compose.example.yaml',
  'apps/web/Dockerfile.dev',
  'apps/cli/README.md',
];

export const SCANNED_ROOTS = ['apps', 'packages'];

// The shipped source extensions worth reading as text. Binary files (the web app's icons, for instance)
// cannot leak a hostname in a way this census could read, so they are never opened at all.
const SCANNED_EXTENSIONS = ['.ts', '.html', '.css', '.md'];

// A file this census leaves alone because it is a test, not shipped behavior — for any extension, not
// only `.ts`, since a `.test.html` or `.test.css` file would need the same room a `.test.ts` file gets.
const isTestLike = (file) => /\.test\.[^./]+$/u.test(file);

// RFC1918 for the private ranges, plus 169.254.0.0/16 — link-local, and on most clouds the address that
// answers with instance credentials for anyone who asks. A public address is not this deployment's own
// infrastructure to protect, and loopback (127.0.0.1, ::1) is the address every stack's own healthcheck
// names on purpose.
const PRIVATE_IPV4 =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3})\b/gu;

// IPv6's own private ranges: fd00::/8 (unique local) and fe80::/10 (link-local) — the same class of
// address PRIVATE_IPV4 refuses, just in the other family. This is not a general IPv6 grammar, the same
// way PRIVATE_IPV4 is not one for dotted-quad addresses; it matches the compressed and uncompressed forms
// these two ranges are actually written in. Loopback (::1) and a public IPv6 address start with neither
// prefix, so both stay unflagged without any extra exclusion.
const PRIVATE_IPV6 = /\b(?:fd[0-9a-f]{2}|fe[89ab][0-9a-f]):[0-9a-f:]*[0-9a-f]\b/giu;

// A hostname carrying a suffix that only resolves on somebody's own network. A label has to sit
// immediately before the dot, which is what keeps a path like `~/.local/share` out of this: nothing
// there is a hostname, and nothing there has a label before the dot either.
const INTERNAL_HOSTNAME = /[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.(?:internal|local|lan|corp|intra|home)\b/gu;

/** Every private address or internal hostname a piece of text names, with where it says it. */
export function infraDetailsIn(text) {
  const found = [];
  const lines = text.split('\n');
  for (const [at, line] of lines.entries()) {
    for (const pattern of [PRIVATE_IPV4, PRIVATE_IPV6, INTERNAL_HOSTNAME]) {
      for (const match of line.matchAll(pattern)) {
        found.push({ line: at + 1, column: match.index + 1, said: match[0] });
      }
    }
  }
  return found;
}

/** Grades the review. `documents` and `sources` are each keyed by repository-relative file path. */
export function verifyExposure({ documents, sources }) {
  const problems = [];
  for (const file of SHIPPED_FILES) {
    const text = documents[file];
    if (text === undefined) {
      problems.push(`${file}: ships with the deployment and was not found`);
      continue;
    }
    for (const found of infraDetailsIn(text)) {
      problems.push(`${file}:${found.line}:${found.column}: names ${found.said}, a private infrastructure detail`);
    }
  }

  const files = Object.keys(sources).sort();
  for (const file of files) {
    if (isTestLike(file)) continue;
    for (const found of infraDetailsIn(sources[file])) {
      problems.push(`${file}:${found.line}:${found.column}: names ${found.said}, a private infrastructure detail`);
    }
  }
  return problems;
}

export function readRepo() {
  const documents = {};
  for (const file of SHIPPED_FILES) {
    try {
      documents[file] = readFileSync(fromRepoRoot(file), 'utf8');
    } catch {
      continue;
    }
  }

  const sources = {};
  for (const root of SCANNED_ROOTS) {
    for (const workspace of readdirSync(fromRepoRoot(root), { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const dir = `${root}/${workspace.name}/src`;
      let entries;
      try {
        entries = readdirSync(fromRepoRoot(dir), { recursive: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        const relative = entry.split(/[\\/]/u).join('/');
        if (!SCANNED_EXTENSIONS.some((extension) => relative.endsWith(extension))) continue;
        sources[`${dir}/${relative}`] = readFileSync(fromRepoRoot(`${dir}/${relative}`), 'utf8');
      }
    }
  }

  return { documents, sources };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = verifyExposure(readRepo());
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}
