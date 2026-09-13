import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { readSettingsText } from '@holydeck/app/boot';
import { queueDb, queueOn, workerContext } from '@holydeck/app/queue';
import { loadSettings, settingsPath } from '@holydeck/app/settings';
import { MongoClient } from 'mongodb';

import { HEARTBEAT_INTERVAL_MS, heartbeatPath, heartbeatText } from './heartbeat.js';
import { runnerOn } from './runner.js';
import { assertUsablePaths, workerPaths } from './runtime.js';
import { HANDLERS, workToDo } from './work.js';

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

// Whatever else it is doing, the worker re-checks its mounts — a network share can go read-only under a
// running process — and the check's result is the heartbeat: a worker whose mounts went away stops
// writing and goes unhealthy, rather than reporting health it no longer has. It is also what keeps a
// parked process alive: with no pending handle at all, Node treats the wait below as an unsettled
// top-level await and exits, which a supervisor sees as a crash.
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

// One signal stops whichever of the two the worker is doing, and stopping means finishing the attempt in
// hand rather than dropping it: a lease released by its holder is a job the next worker runs at once,
// where a lease abandoned is one that waits out its expiry first.
const stopping = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void stopping.abort());
}

const parked = (): Promise<void> =>
  new Promise((resolve) => {
    stopping.signal.addEventListener('abort', () => resolve(), { once: true });
  });

const work = workToDo(HANDLERS, settings.values.mongoUrl);
const now = (): string => new Date().toISOString();

if (work.runs === 'nothing') {
  process.stdout.write(`worker claims no job: ${work.reason}\n`);
  await parked();
} else {
  process.stdout.write(`worker claims ${work.kinds.join(', ')}\n`);
  const name = `worker-${process.pid}`;
  const store = new MongoClient(settings.values.mongoUrl);
  await store.connect();
  const runner = runnerOn({
    queue: queueOn(queueDb(store.db()), { now }),
    context: workerContext(name),
    worker: name,
    handlers: HANDLERS,
    now,
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    ticker: (everyMs, tick) => {
      const timer = setInterval(tick, everyMs);
      return () => void clearInterval(timer);
    },
    report: (line) => void process.stdout.write(`${line}\n`),
  });
  try {
    await runner.run(stopping.signal);
  } finally {
    await store.close();
  }
}

clearInterval(heartbeat);
