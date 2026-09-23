import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { checkOwnSettingsMount, readSettingsText } from '@holydeck/app/boot';
import { AUDIT_CATEGORIES, CATEGORY_OF, auditContext, auditReadContext, retentionSweepContext } from '@holydeck/app/audit';
import { backupContext, backupDb } from '@holydeck/app/backups';
import { capabilityDb, capabilitiesOn } from '@holydeck/app/capabilities';
import { mediaContext, mediaLibraryOn, mediaPurgeDb } from '@holydeck/app/media';
import { mediaMigrationStateDb, mediaMigrationStateOn } from '@holydeck/app/media-migration-state';
import { notificationDb, notificationStoreOn } from '@holydeck/app/notification-store';
import { SCHEMA_VERSION } from '@holydeck/app/migrations';
import { queueDb, queueOn, schedulerContext, workerContext } from '@holydeck/app/queue';
import { maintenanceDb, maintenanceOn, releaseOrphanedLease } from '@holydeck/app/maintenance';
import { repositoriesOn, repositoryDb } from '@holydeck/app/repositories';
import { restoreCompatibilityDb, restoreCompatibilityOn } from '@holydeck/app/restore-compatibility';
import { rehearsalDatabaseName, restoreContext, restoreDb } from '@holydeck/app/restores';
import { sessionDb, sessionsOn } from '@holydeck/app/sessions';
import { ensureResticPassword } from '@holydeck/app/settings-admin';
import { loadSettings, settingsPath } from '@holydeck/app/settings';
import { MongoClient } from 'mongodb';

import { HEARTBEAT_INTERVAL_MS, heartbeatPath, heartbeatText } from './heartbeat.js';
import { ffmpegPosterGenerator } from './poster-generator.js';
import { runnerOn } from './runner.js';
import { assertUsablePaths, workerPaths } from './runtime.js';
import { schedulerOn } from './scheduler.js';
import { schedulerStateDb, schedulerStateOn } from './scheduler-state.js';
import { HANDLERS, handlersOn, workToDo } from './work.js';

/** Every action a due backup should treat as "the deployment changed since it last ran" (R7's `dueJobs`). */
const CHANGE_CATEGORIES: ReadonlySet<string> = new Set<(typeof AUDIT_CATEGORIES)[number]>([
  'settings',
  'content',
  'presentation',
]);
const CHANGE_ACTIONS = Object.entries(CATEGORY_OF)
  .filter(([, category]) => CHANGE_CATEGORIES.has(category))
  .map(([action]) => action);

const path = settingsPath(process.env);
checkOwnSettingsMount(path);
const settings = loadSettings({
  fileText: readSettingsText((file) => readFileSync(file, 'utf8'), path),
  env: process.env,
  path,
});

const paths = workerPaths(settings.values);

// The worker keeps no settings-admin watcher of its own (unlike `apps/app`): it re-reads the settings
// file fresh on every call instead, so a storage-root migration (OPS-16) that switches `mediaRoot` while
// this process is already running is seen by the very next job, not held stale until it restarts.
const currentMediaRoot = (): string =>
  loadSettings({
    fileText: readSettingsText((file) => readFileSync(file, 'utf8'), path),
    env: process.env,
    path,
  }).values.mediaRoot;

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
  // OPS-09's worker-process scope: this process's own CPU time since it started and its own resident
  // memory, never the host's. `operational-sources.ts` reads this back off the same file already read
  // for liveness, rather than the worker needing anywhere else to publish it.
  const usage = process.cpuUsage();
  const memory = process.memoryUsage();
  writeFileSync(
    beatFile,
    heartbeatText(new Date().toISOString(), process.pid, paths, {
      cpuUserSeconds: usage.user / 1_000_000,
      cpuSystemSeconds: usage.system / 1_000_000,
      memoryRssMb: Math.round(memory.rss / 1_000_000),
    }),
  );
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
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

if (work.runs === 'nothing') {
  process.stdout.write(`worker claims no job: ${work.reason}\n`);
  await parked();
} else {
  process.stdout.write(`worker claims ${work.kinds.join(', ')}\n`);
  const name = `worker-${process.pid}`;
  const store = new MongoClient(settings.values.mongoUrl);
  await store.connect();
  // The storageKey a write() hands back is bare — never root-prefixed — so a later storage-root migration
  // (OPS-16) leaves every asset uploaded under the old root still readable under the new one. read()/
  // remove() still accept an absolute key: the append-only architecture (ADR 0009) forbids rewriting a
  // storageKey already recorded, so an asset uploaded before this change keeps its old absolute key forever.
  const mediaStorage = {
    async write(root: string, key: string, bytes: Uint8Array): Promise<string> {
      mkdirSync(root, { recursive: true });
      await writeFile(join(root, key), bytes);
      return key;
    },
    async read(root: string, key: string): Promise<Uint8Array> {
      return new Uint8Array(await readFile(isAbsolute(key) ? key : join(root, key)));
    },
    async remove(root: string, key: string): Promise<void> {
      await rm(isAbsolute(key) ? key : join(root, key), { force: true });
    },
  };
  const queue = queueOn(queueDb(store.db()), { now });
  // The repository is encrypted, so it has a password, and a deployment that was never given one gets one
  // generated into its settings file here rather than being asked to invent a secret before its first
  // backup can run. A deployment that mounts no settings directory at all — the development stack, by
  // design — has nowhere to keep one: that is said out loud and then left, and every Restic command
  // refuses for want of a password rather than quietly writing a repository anyone could read.
  const settingsIo = {
    readFile: (file: string) => readFile(file, 'utf8'),
    writeFile: (file: string, text: string) => writeFile(file, text),
    rename,
    env: process.env,
  };
  const configured = await ensureResticPassword(settings, settingsIo).catch((error: unknown) => {
    process.stdout.write(`worker could not settle a backup repository password: ${(error as Error).message}\n`);
    return settings;
  });
  // Restic itself is only touched once a backup job actually claims and runs: a build that never claims
  // `backup-run` never needs the binary present, the same way `ffmpeg` is only ever reached per poster job.
  const restic = { repository: configured.values.resticRepository, password: configured.values.resticPassword };
  // A rehearsal aims the whole of a real restore somewhere it cannot hurt anyone: not only the database
  // the archive is applied to, but the sessions it ends. Pointing the session store at the live
  // deployment would prove the same thing at the price of signing a congregation out mid-service, which
  // is not a price a rehearsal ever gets to charge.
  const rehearsal = store.db(rehearsalDatabaseName(store.db().databaseName));
  const schedulerState = schedulerStateOn(schedulerStateDb(store.db()));
  // The same lease `apps/app`'s `guardMaintenance` reads: both processes read and write the one
  // `maintenance` collection in the production database, so a job held here is a hold the app sees too.
  const maintenance = maintenanceOn(maintenanceDb(store.db()));
  // A lease still active this early is one a previous process never got to release — see
  // `releaseOrphanedLease`'s own comment for why that is always safe here.
  await releaseOrphanedLease(maintenance, (line) => void process.stdout.write(`${line}\n`));
  const mediaMigrationState = mediaMigrationStateOn(mediaMigrationStateDb(store.db()));
  const handlers = handlersOn({
    mediaIngest: {
      context: mediaContext('system', name),
      media: mediaLibraryOn(repositoryDb(store.db()), {
        now,
        queue,
        mediaRoot: currentMediaRoot,
        purge: mediaPurgeDb(store.db()),
        ...mediaStorage,
      }),
      storage: mediaStorage,
      mediaRoot: currentMediaRoot,
      poster: ffmpegPosterGenerator(),
    },
    backupProducer: {
      context: backupContext('system', name),
      schedulerState,
      archive: backupDb(store, store.db()),
      db: repositoryDb(store.db()),
      restic,
      settingsPath: path,
      mediaRoot: settings.values.mediaRoot,
      schemaVersion: SCHEMA_VERSION,
      now,
      report: (line) => void process.stdout.write(`${line}\n`),
    },
    restoreRehearsal: {
      context: restoreContext('system', name),
      db: repositoryDb(store.db()),
      target: restoreDb(rehearsal),
      sessions: sessionsOn(sessionDb(rehearsal), { now }),
      capabilities: capabilitiesOn(capabilityDb(rehearsal), { now }),
      restic,
      schemaVersion: SCHEMA_VERSION,
      now,
      schedulerState,
    },
    restoreApply: {
      context: restoreContext('system', name),
      db: repositoryDb(store.db()),
      target: restoreDb(store.db()),
      sessions: sessionsOn(sessionDb(store.db()), { now }),
      capabilities: capabilitiesOn(capabilityDb(store.db()), { now }),
      // Production only — a rehearsal never leaves `rehearsal`, so no session `apps/app` ever proves is
      // ended by one, and there is nothing here for a rehearsal to record.
      compatibility: restoreCompatibilityOn(restoreCompatibilityDb(store.db()), { now }),
      maintenance,
      restic,
      settingsPath: path,
      mediaRoot: settings.values.mediaRoot,
      now,
      report: (line) => void process.stdout.write(`${line}\n`),
    },
    retentionSweep: {
      context: retentionSweepContext('system', name),
      db: repositoryDb(store.db()),
      autosaveRetentionDays: configured.values.autosaveRetentionDays,
      auditRetentionDays: configured.values.auditRetentionDays,
      notificationStore: notificationStoreOn(notificationDb(store.db()), { now }),
      notificationReadRetentionDays: configured.values.notificationReadRetentionDays,
      now,
      report: (line) => void process.stdout.write(`${line}\n`),
      schedulerState,
    },
    mediaMigration: {
      context: auditContext('system', name),
      db: repositoryDb(store.db()),
      maintenance,
      migrationState: mediaMigrationState,
      loaded: configured,
      settingsIo,
      now,
      report: (line) => void process.stdout.write(`${line}\n`),
    },
  });
  const runner = runnerOn({
    queue,
    context: workerContext(name),
    worker: name,
    handlers,
    now,
    sleep,
    ticker: (everyMs, tick) => {
      const timer = setInterval(tick, everyMs);
      return () => void clearInterval(timer);
    },
    report: (line) => void process.stdout.write(`${line}\n`),
  });
  // R7: the scheduler only ever reads `scheduler_state` and enqueues what is due — each job handler above
  // records its own success. It shares the worker's queue and settings but is otherwise independent of the
  // runner, so the two loops run concurrently and either one stopping the process stops both.
  const auditEvents = repositoriesOn(repositoryDb(store.db())).auditEvents;
  const scheduler = schedulerOn({
    queue,
    state: schedulerState,
    settings: {
      timezone: configured.values.timezone,
      backupDailyAt: configured.values.backupDailyAt,
      backupComponents: configured.values.backupComponents,
      backupMinimumGapMinutes: configured.values.backupMinimumGapMinutes,
      backupRehearsalWeekday: configured.values.backupRehearsalWeekday,
      retentionSweepAt: configured.values.retentionSweepAt,
    },
    context: schedulerContext(name),
    changedSince: async (since) => {
      const filter = since === undefined
        ? { action: { $in: CHANGE_ACTIONS }, outcome: 'allowed' }
        : { action: { $in: CHANGE_ACTIONS }, outcome: 'allowed', at: { $gt: since } };
      return (await auditEvents.count(auditReadContext('system', name), filter)) > 0;
    },
    now: () => new Date(),
    sleep,
    report: (line) => void process.stdout.write(`${line}\n`),
  });
  try {
    await Promise.all([runner.run(stopping.signal), scheduler.run(stopping.signal)]);
  } finally {
    await store.close();
  }
}

clearInterval(heartbeat);
