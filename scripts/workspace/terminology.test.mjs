import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GUARDED_FILES, bareNounsIn, readRepo, verifyTerminology } from './terminology.mjs';

/** Every guarded file, saying nothing the glossary refuses. One of them is then replaced per test. */
const clean = () => ({
  sources: Object.fromEntries(GUARDED_FILES.map((file) => [file, '// A Slide Layout holds boxes.\n'])),
});

const withSource = (text, file = GUARDED_FILES[0]) => {
  const input = clean();
  input.sources[file] = text;
  return input;
};

test('a set of files written to the glossary has nothing to report', () => {
  assert.deepEqual(verifyTerminology(clean()), []);
});

test('names the file, the line and the column the bare noun is said at', () => {
  const text = '// A Slide Layout holds boxes.\n// A template holds boxes too.\n';
  const problems = verifyTerminology(withSource(text));
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(`^${GUARDED_FILES[0]}:2:6: says "template", and the term is`, 'u'));
});

test('leaves the two compounds the glossary allows, however they are spelled', () => {
  const text = 'const kinds = ["Service Template", "service_template", "serviceTemplate", "Slide Layout"];\n';
  assert.deepEqual(verifyTerminology(withSource(text)), []);
});

test('catches the bare noun inside an identifier, which is where it does most of its damage', () => {
  const problems = verifyTerminology(withSource('export const layoutTemplateId = 1;\n'));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Template/u);
});

test('catches it however it is cased, and on whichever line it is said', () => {
  const said = bareNounsIn('const TEMPLATES = [];\n// nothing here\nconst one = "Template";\n');
  assert.deepEqual(said, [
    { line: 1, column: 7, said: 'TEMPLATE' },
    { line: 3, column: 14, said: 'Template' },
  ]);
});

test('reports a guarded file that is not there, which is how a rename stops a guard quietly', () => {
  const input = clean();
  delete input.sources[GUARDED_FILES[0]];
  assert.deepEqual(verifyTerminology(input), [`${GUARDED_FILES[0]}: is held to the glossary and was not found`]);
});

test('every file this repository holds to the glossary keeps it', () => {
  assert.deepEqual(verifyTerminology(readRepo()), []);
});
