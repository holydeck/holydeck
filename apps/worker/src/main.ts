import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs';

import { readSettingsText } from '@holydeck/app/boot';
import { loadSettings, settingsPath } from '@holydeck/app/settings';

import { assertUsablePaths, workerPaths } from './runtime.js';

const path = settingsPath(process.env);
const settings = loadSettings({
  fileText: readSettingsText((file) => readFileSync(file, 'utf8'), path),
  env: process.env,
  path,
});

const paths = workerPaths(settings.values);

const isUsable = (candidate: string): boolean => {
  try {
    mkdirSync(candidate, { recursive: true });
    accessSync(candidate, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

// The worker creates the directories it owns and refuses to start on the ones it cannot: a first run
// has an empty volume, and a read-only mount must be a startup failure rather than a failure per job.
assertUsablePaths(isUsable, paths);

process.stdout.write(`worker ready: ${JSON.stringify(paths)}\n`);

// No job types are registered yet; the queue arrives with the tasks that own it. Until then the worker
// re-checks its mounts, which is worth doing on its own — a network share can go read-only under a
// running process — and is also what keeps the process alive: with no pending handle at all, Node
// treats the wait below as an unsettled top-level await and exits, which a supervisor sees as a crash.
const heartbeat = setInterval(() => {
  try {
    assertUsablePaths(isUsable, paths);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
  }
}, 60_000);

await new Promise<void>((resolve) => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      clearInterval(heartbeat);
      resolve();
    });
  }
});
