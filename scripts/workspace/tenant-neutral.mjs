// Repo-wide tenant-neutrality census. FND-07 asks for durable records that carry no tenant
// discriminator, and the repository-wide reading of that is the only useful one: `apps/app` can refuse a
// `churchId` at its repositories all day while another workspace quietly writes one through the driver.
// So this reads every shipped TypeScript file and refuses the names outright, and it grades its own list
// against the registry in `apps/app/src/records.ts` in both directions — a name one of them knows and the
// other does not is a hole, whichever side it is on.
//
// Two exemptions, both deliberate. Test files may name a discriminator, because that is how they prove
// one is refused. And the registry itself declares the names, which is the one place they belong.
//
// Prose is read past: a comment explaining the rule, or a message that says "tenant-scoped", is not a
// field. A string is only a finding when the whole literal is one of the names, which is how a filter
// key or a projection would be written.

import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { fromRepoRoot } from './pipeline.mjs';

export const REGISTRY = 'apps/app/src/records.ts';

export const SCANNED_ROOTS = ['apps', 'packages'];

export const DISCRIMINATORS = [
  'churchId',
  'church_id',
  'congregationId',
  'congregation_id',
  'customerId',
  'customer_id',
  'orgId',
  'org_id',
  'organisationId',
  'organizationId',
  'siteId',
  'site_id',
  'tenant',
  'tenantId',
  'tenant_id',
  'workspaceId',
  'workspace_id',
];

/** Splits source into the code that runs and the string literals it holds, dropping comments. */
export function splitSource(text) {
  const strings = [];
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
      let value = '';
      index += 1;
      while (index < text.length && text[index] !== character) {
        if (text[index] === '\\') {
          value += text[index + 1] ?? '';
          index += 2;
          continue;
        }
        value += text[index];
        index += 1;
      }
      strings.push(value);
      index += 1;
      continue;
    }
    code += character;
    index += 1;
  }
  return { code, strings };
}

const wholeName = (name) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'u');

/** The first discriminator the source names as a field, or nothing when it names none. */
export function discriminatorNamed(text, names = DISCRIMINATORS) {
  const { code, strings } = splitSource(text);
  for (const name of names) {
    if (wholeName(name).test(code)) return name;
    // A filter key or a projection is written as the whole literal; a sentence that mentions the name is not.
    if (strings.some((literal) => literal.trim().split('.')[0] === name)) return name;
  }
  return undefined;
}

/** The names the registry declares, read out of its source rather than imported: this file is not TypeScript. */
export function declaredDiscriminators(registryText) {
  const after = registryText.split('DISCRIMINATOR_NAMES')[1] ?? '';
  // The list of names, rather than the `string[]` in the type that precedes it.
  const open = after.search(/\[\s*'/u);
  if (open === -1) return [];
  const names = after.slice(open, after.indexOf(']', open));
  return [...names.matchAll(/'([^']+)'/gu)].map((match) => match[1]).sort();
}

/** Grades the census. `sources` is keyed by repository-relative file path. */
export function verifyTenantNeutrality({ sources }) {
  const problems = [];
  const registryText = sources[REGISTRY];
  if (registryText === undefined) {
    problems.push(`${REGISTRY} is missing, so the refused names cannot be checked`);
  } else {
    const declared = declaredDiscriminators(registryText);
    for (const name of declared) {
      if (!DISCRIMINATORS.includes(name)) problems.push(`${REGISTRY}: declares ${name}, which this census does not look for`);
    }
    for (const name of DISCRIMINATORS) {
      if (!declared.includes(name)) problems.push(`${REGISTRY}: does not declare ${name}, which this census refuses`);
    }
  }

  const files = Object.keys(sources).sort();
  if (files.length === 0) problems.push('no TypeScript source was found to check');
  for (const file of files) {
    if (file === REGISTRY || file.endsWith('.test.ts')) continue;
    const named = discriminatorNamed(sources[file]);
    if (named !== undefined) {
      problems.push(`${file}: names ${named}, which would scope a record to one tenant`);
    }
  }
  return problems;
}

export function readRepo() {
  const sources = {};
  for (const root of SCANNED_ROOTS) {
    for (const workspace of readdirSync(fromRepoRoot(root), { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue;
      const dir = `${root}/${workspace.name}/src`;
      let entries = [];
      try {
        entries = readdirSync(fromRepoRoot(dir), { recursive: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        const relative = entry.split(/[\\/]/u).join('/');
        if (!relative.endsWith('.ts')) continue;
        sources[`${dir}/${relative}`] = readFileSync(fromRepoRoot(`${dir}/${relative}`), 'utf8');
      }
    }
  }
  return { sources };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = verifyTenantNeutrality(readRepo());
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}
