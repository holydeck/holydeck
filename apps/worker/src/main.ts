import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { readSettingsText } from '@holydeck/app/boot';
import { loadSettings, settingsPath } from '@holydeck/app/settings';

import { HEARTBEAT_INTERVAL_MS, heartbeatPath, heartbeatText } from './heartbeat.js';
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

const beatFile = heartbeatPath(paths);

// No job types are registered yet; the queue arrives with the tasks that own it. Until then the worker
// re-checks its mounts, which is worth doing on its own — a network share can go read-only under a
// running process — and is also what keeps the process alive: with no pending handle at all, Node
// treats the wait below as an unsettled top-level await and exits, which a supervisor sees as a crash.
// The check's result is the heartbeat: a worker whose mounts went away stops writing and goes
// unhealthy, rather than reporting health it no longer has.
const beat = (): void => {
  try {
    assertUsablePaths(isUsable, paths);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return;
  }
  mkdirSync(dirname(beatFile), { recursive: true });
  writeFileSync(beatFile, heartbeatText(new Date().toISOString(), process.pid, paths));
};

beat();
const heartbeat = setInterval(beat, HEARTBEAT_INTERVAL_MS);

await new Promise<void>((resolve) => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      clearInterval(heartbeat);
      resolve();
    });
  }
});
