// What the development stack runs to ask whether the built client is usable: node health.mjs.
// A watching build keeps running through a compile error, so this reads what the build recorded.

import { readFile } from 'node:fs/promises';

import { BUILD_STAMP, buildStampProblem } from './src/build-stamp.ts';

const file = new URL(`dist/${BUILD_STAMP}`, import.meta.url);
const problem = buildStampProblem(await readFile(file, 'utf8').then((text) => text, () => undefined));

if (problem !== undefined) {
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}
