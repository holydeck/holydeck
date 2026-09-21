import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { checkOwnSettingsMount, readSettingsText } from '@holydeck/app/boot';
import { backupContext, backupDb } from '@holydeck/app/backups';
import { mediaContext, mediaLibraryOn } from '@holydeck/app/media';
import { SCHEMA_VERSION } from '@holydeck/app/migrations';
import { queueDb, queueOn, workerContext } from '@holydeck/app/queue';
import { repositoryDb } from '@holydeck/app/repositories';
import { rehearsalDatabaseName, restoreContext, restoreDb } from '@holydeck/app/restores';
import { sessionDb, sessionsOn } from '@holydeck/app/sessions';
import { loadSettings, settingsPath } from '@holydeck/app/settings';
import { MongoClient } from 'mongodb';

import { HEARTBEAT_INTERVAL_MS, heartbeatPath, heartbeatText } from './heartbeat.js';
import { ffmpegPosterGenerator } from './poster-generator.js';
import { runnerOn } from './runner.js';
import { assertUsablePaths, workerPaths } from './runtime.js';
import { HANDLERS, handlersOn, workToDo } from './work.js';

const path = settingsPath(process.env);
checkOwnSettingsMount(path);
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
  const mediaStorage = {
    async write(root: string, key: string, bytes: Uint8Array): Promise<string> {
      mkdirSync(root, { recursive: true });
      const path = join(root, key);
      await writeFile(path, bytes);
      return path;
    },
    async read(_root: string, key: string): Promise<Uint8Array> {
      return new Uint8Array(await readFile(key));
    },
  };
  const queue = queueOn(queueDb(store.db()), { now });
  // Restic itself is only touched once a backup job actually claims and runs: a build that never claims
  // `backup-run` never needs the binary present, the same way `ffmpeg` is only ever reached per poster job.
  const restic = { repository: settings.values.resticRepository };
  // A rehearsal aims the whole of a real restore somewhere it cannot hurt anyone: not only the database
  // the archive is applied to, but the sessions it ends. Pointing the session store at the live
  // deployment would prove the same thing at the price of signing a congregation out mid-service, which
  // is not a price a rehearsal ever gets to charge.
  const rehearsal = store.db(rehearsalDatabaseName(store.db().databaseName));
  const handlers = handlersOn(
    {
      context: mediaContext('system', name),
      media: mediaLibraryOn(repositoryDb(store.db()), { now, queue, mediaRoot: settings.values.mediaRoot, ...mediaStorage }),
      storage: mediaStorage,
      mediaRoot: settings.values.mediaRoot,
      poster: ffmpegPosterGenerator(),
    },
    {
      context: backupContext('system', name),
      archive: backupDb(store, store.db()),
      db: repositoryDb(store.db()),
      restic,
      settingsPath: path,
      mediaRoot: settings.values.mediaRoot,
      schemaVersion: SCHEMA_VERSION,
      now,
      report: (line) => void process.stdout.write(`${line}\n`),
    },
    {
      context: restoreContext('system', name),
      db: repositoryDb(store.db()),
      target: restoreDb(rehearsal),
      sessions: sessionsOn(sessionDb(rehearsal), { now }),
      restic,
      schemaVersion: SCHEMA_VERSION,
      now,
    },
  );
  const runner = runnerOn({
    queue,
    context: workerContext(name),
    worker: name,
    handlers,
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
