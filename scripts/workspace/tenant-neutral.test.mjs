import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DISCRIMINATORS,
  REGISTRY,
  declaredDiscriminators,
  readRepo,
  verifyTenantNeutrality,
} from './tenant-neutral.mjs';

const registryText = `export const DISCRIMINATOR_NAMES: readonly string[] = Object.freeze(\n  [\n${DISCRIMINATORS.map(
  (name) => `    '${name}',`,
).join('\n')}\n  ].sort(),\n);\n`;

const clean = () => ({
  sources: {
    'apps/app/src/app.ts': 'export const serviceId = 1;\n',
    'packages/core/src/service.ts': 'export const congregation = "ours";\n',
    [REGISTRY]: registryText,
  },
});

const withSource = (file, text) => {
  const input = clean();
  input.sources[file] = text;
  return input;
};

test('a repository whose records are tenant-neutral has nothing to report', () => {
  assert.deepEqual(verifyTenantNeutrality(clean()), []);
});

test('flags shipped source that names a tenant discriminator, and where', () => {
  const problems = verifyTenantNeutrality(withSource('apps/app/src/store.ts', 'export const id = row.churchId;\n'));
  assert.deepEqual(problems, ['apps/app/src/store.ts: names churchId, which would scope a record to one tenant']);
});

test('flags a discriminator a filter names as a string key', () => {
  const problems = verifyTenantNeutrality(
    withSource('packages/core/src/query.ts', "export const filter = { 'tenant_id': 1 };\n"),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /tenant_id/u);
});

test('reads past the prose, because the rule itself has to be written down somewhere', () => {
  const text = '// No record carries a tenantId or a churchId.\n/* not even an orgId */\nexport const a = 1;\n';
  assert.deepEqual(verifyTenantNeutrality(withSource('apps/app/src/notes.ts', text)), []);
});

test('leaves tests alone, because a test has to name one to prove it is refused', () => {
  const input = withSource('apps/app/src/store.test.ts', "assert.equal(discriminatorIn(['tenantId']), 'tenantId');\n");
  assert.deepEqual(verifyTenantNeutrality(input), []);
});

test('flags a name the registry declares and the census does not know', () => {
  const input = clean();
  input.sources[REGISTRY] = registryText.replace("  ]", "    'parishId',\n  ]");
  assert.deepEqual(verifyTenantNeutrality(input), [
    `${REGISTRY}: declares parishId, which this census does not look for`,
  ]);
});

test('flags a name this census looks for and the registry does not declare', () => {
  const input = clean();
  input.sources[REGISTRY] = registryText.replace(`    '${DISCRIMINATORS[0]}',\n`, '');
  assert.deepEqual(verifyTenantNeutrality(input), [
    `${REGISTRY}: does not declare ${DISCRIMINATORS[0]}, which this census refuses`,
  ]);
});

test('refuses a registry it cannot read, rather than passing a census of nothing', () => {
  const input = clean();
  delete input.sources[REGISTRY];
  assert.deepEqual(verifyTenantNeutrality(input), [`${REGISTRY} is missing, so the refused names cannot be checked`]);
});

test('refuses a census that found no source to read', () => {
  assert.deepEqual(verifyTenantNeutrality({ sources: {} }), [
    `${REGISTRY} is missing, so the refused names cannot be checked`,
    'no TypeScript source was found to check',
  ]);
});

test('reads the names the registry declares', () => {
  assert.deepEqual(declaredDiscriminators(registryText), [...DISCRIMINATORS].sort());
});

test('this repository is tenant-neutral', () => {
  const problems = verifyTenantNeutrality(readRepo());
  assert.deepEqual(problems, []);
});
