// What `docker compose` runs to ask the worker whether it is alive: node dist/health.js, exit 0 or 1.
//
// It reads the same settings the worker does, so it looks for the heartbeat where the worker writes it
// even when a deployment moves the data directory. The judgement itself is in heartbeat.ts.

import { readFileSync } from 'node:fs';

import { readSettingsText } from '@holydeck/app/boot';
import { loadSettings, settingsPath } from '@holydeck/app/settings';

import { heartbeatPath, heartbeatProblem } from './heartbeat.js';
import { workerPaths } from './runtime.js';

const path = settingsPath(process.env);
const settings = loadSettings({
  fileText: readSettingsText((file) => readFileSync(file, 'utf8'), path),
  env: process.env,
  path,
});

const file = heartbeatPath(workerPaths(settings.values));

const heartbeat = (): string | undefined => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

const problem = heartbeatProblem(heartbeat(), new Date().toISOString());
if (problem !== undefined) {
  process.stderr.write(`${file}: ${problem}\n`);
  process.exit(1);
}
