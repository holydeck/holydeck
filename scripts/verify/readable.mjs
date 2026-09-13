// Does every staged JSON and YAML file still parse?
//
// It is the cheapest check in the repository and it catches the commit that costs the most: a manifest, a
// lockfile-adjacent config or a workflow with one comma out of place, which turns every later run red
// somewhere far away from the edit that caused it.

import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';

/** Every document in the file, because a YAML file may hold several — pnpm writes its lockfile that way. */
function readYaml(text) {
  for (const document of parseAllDocuments(text)) {
    const [error] = document.errors;
    if (error !== undefined) throw error;
  }
}

export function unreadable(paths, read) {
  const problems = [];
  for (const path of paths) {
    // JSON is nearly a subset of YAML, so a .json file read as YAML would pass with a trailing comma
    // that every JSON reader after this one refuses. Each file is held to its own format.
    const parseAs = path.endsWith('.json') ? JSON.parse : readYaml;
    try {
      parseAs(read(path));
    } catch (error) {
      problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}

const paths = process.argv.slice(2);
if (paths.length > 0) {
  const problems = unreadable(paths, (path) => readFileSync(path, 'utf8'));
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exitCode = 1;
  }
}
