// Builds the `OperationalSources` `operational-health.ts` grades (OPS-09). Every function here is a
// thin reader over state this product already keeps somewhere else — the worker's heartbeat file, the
// queue's own collection, the recorded backups and restore rehearsals, the media manifest, the durable
// store's own ping and stats, the corpus client `app.ts` already built, a `statfs` of the media root,
// this process's own `cpuUsage`/`memoryUsage`, and a fresh media-cleanup scan — and none of it judges
// anything; judging is `operational-health.ts`'s job alone. `storage`/`readiness` are still left off
// entirely below: no server-side store exists yet for either OFFL-01's or OFFL-03's browser reports, and
// `observeOperationalHealth`'s `readOptional` already treats a missing source as "not yet reported"
// rather than a fault — see research-notes.md's Task 10-10 section for that ruling, which review-10
// left standing; the narrower ruling that stopped this file at five sources did not, and this file now
// covers the other four OPS-09 asks for.

import { readFile, statfs } from 'node:fs/promises';

import { JOBS_COLLECTION } from './queue.js';
import { referencedByFor } from './media-cleanup-routes.js';
import { RESTORE_RECORD } from './restores.js';
import { recordedBackups } from './backups.js';
import { repositoriesOn } from './repositories.js';

import type { BackupObjectives } from '@holydeck/contracts/backups';
import type { RequestContext } from './context.js';
import type { corpusClient } from './corpus.js';
import type { MediaLibrary } from './media.js';
import type {
  CorpusReading,
  DatabaseReading,
  DiskReading,
  MediaCleanupReading,
  OperationalSources,
  ProcessReading,
  QueueReading,
  RecordedRehearsal,
  WorkerHeartbeatReading,
} from './operational-health.js';
import type { Queue } from './queue.js';
import type { RepositoryDb } from './repositories.js';

/**
 * The two admin commands OPS-09's database reading needs, and nothing else this application does with
 * its durable store — narrow on purpose, the same way `RepositoryDb` is, and structurally satisfied by
 * the raw `mongodb` driver's own `Db` without a cast: both methods here take a strict subset of what
 * `Db.command`/`Db.stats` accept.
 */
export interface MongoHealthDb {
  command(document: Record<string, unknown>): Promise<Record<string, unknown>>;
  stats(): Promise<Record<string, unknown>>;
}

/**
 * Must match `apps/worker/src/heartbeat.ts`'s own `HEARTBEAT_STALE_MS` (confirmed equal by reading that
 * file). Not imported from there: `apps/worker` already depends on `@holydeck/app`
 * (`workerPaths()` needs `Settings`), so the reverse dependency would make the workspace graph
 * cyclic. See research-notes.md's Task 10-10 Ruling 2 for the accepted drift risk.
 */
const WORKER_HEARTBEAT_STALE_MS = 45_000;

async function workerHeartbeatReading(dataDir: string): Promise<WorkerHeartbeatReading> {
  const path = `${dataDir}/worker/heartbeat.json`;
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    // No file is what a worker that has never completed its first mount check leaves behind — a real
    // state (`health.workerSilent`), not a failure to read (`health.unreadable`).
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { staleAfterMs: WORKER_HEARTBEAT_STALE_MS };
    throw error;
  }
  const parsed = JSON.parse(text) as { readonly at?: unknown; readonly pid?: unknown; readonly paths?: unknown };
  const at = typeof parsed.at === 'string' ? parsed.at : undefined;
  const pid = typeof parsed.pid === 'number' ? parsed.pid : undefined;
  const paths = Array.isArray(parsed.paths) ? parsed.paths.filter((entry): entry is string => typeof entry === 'string') : undefined;
  return { at, pid, paths, staleAfterMs: WORKER_HEARTBEAT_STALE_MS };
}

/**
 * `counts`/`jobs` forward `Queue.summary`/`Queue.list` as-is. `oldestQueuedAt` cannot come from either —
 * `operational-health.ts`'s own doc comment on `QueueReading` forbids deriving it from `Queue.list`'s
 * page — so it is read directly off the queue's own collection (`queue.ts` keeps jobs outside the
 * `Repository` layer entirely; see research-notes.md's Task 10-10 Ruling 3).
 */
async function queueReading(db: RepositoryDb, queue: Pick<Queue, 'summary' | 'list'>, context: unknown): Promise<QueueReading> {
  const [counts, jobs, oldest] = await Promise.all([
    queue.summary(context),
    queue.list(context),
    db.collection(JOBS_COLLECTION).find({ state: 'queued' }, { sort: { queuedAt: 1 }, limit: 1 }).toArray(),
  ]);
  const oldestQueuedAt = typeof oldest[0]?.['queuedAt'] === 'string' ? (oldest[0]['queuedAt'] as string) : undefined;
  return { counts, jobs, oldestQueuedAt };
}

/**
 * `RecordedRehearsal { at, objectives }`, read straight off the `restores` record class the same way
 * `backups.ts`'s own `recordedBackups` reads `backups` — kept local rather than exported from
 * `restores.ts`, which this task does not otherwise touch (Ruling 4).
 */
async function recordedRehearsals(db: RepositoryDb, context: unknown): Promise<readonly RecordedRehearsal[]> {
  const rows = await repositoriesOn(db)[RESTORE_RECORD].read(context, {});
  return rows
    .map((row) => ({ at: String(row['at']), objectives: row['objectives'] as unknown as BackupObjectives }))
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
}

/**
 * A ping and a `dbStats` against the durable store, timed the same way `corpusReading` times its own
 * request. A failed ping is `{ reachable: false }`, caught locally, because a database that will not
 * answer at all is an expected shape (`database.unreachable`) and not a reason to fail this reading the
 * way an unexpected exception would (`database.unreadable`); a failed `stats()` after a successful ping
 * is left to throw, on the same reasoning `diskReading` below uses for `statfs`.
 */
async function databaseReading(db: MongoHealthDb): Promise<DatabaseReading> {
  const startedAt = Date.now();
  try {
    await db.command({ ping: 1 });
  } catch {
    return { reachable: false };
  }
  const latencyMs = Date.now() - startedAt;
  const stats = await db.stats();
  const storageBytes = typeof stats['storageSize'] === 'number' ? stats['storageSize'] : 0;
  return { reachable: true, latencyMs, storageBytes };
}

/**
 * `translations()` needs no parameters, making it the cheapest reachability probe the corpus client
 * offers. `corpus.ts`'s own `ask()` helper never throws — every failure, configured or not, network or
 * malformed response, comes back as a `CorpusResult` refusal — so `!answer.ok` is read as
 * `{ reachable: false }` here, and `corpus.unreadable` stays a backstop for a genuinely unexpected
 * exception rather than a path this function means to take.
 */
async function corpusReading(
  client: Pick<ReturnType<typeof corpusClient>, 'translations'>,
  configured: boolean,
): Promise<CorpusReading> {
  if (!configured) return { configured: false };
  const startedAt = Date.now();
  const answer = await client.translations();
  if (!answer.ok) return { configured: true, reachable: false };
  return { configured: true, reachable: true, latencyMs: Date.now() - startedAt };
}

/**
 * The same `statfs` call OPS-13's own upload guard in `media-routes.ts` already makes against
 * `mediaRoot`, read here instead of caught: that route fails one upload closed on a `statfs` error, but
 * this reading has no single request to fail closed for, so an unreadable filesystem propagates and
 * becomes `disk.unreadable` via the generic `read()` wrapper, the same way `workerHeartbeatReading`
 * above only catches the one error it has a real state for and re-throws everything else.
 */
async function diskReading(mediaRoot: string, reserveBytes: number): Promise<DiskReading> {
  const disk = await statfs(mediaRoot);
  return { freeBytes: disk.bavail * disk.bsize, reserveBytes };
}

/** Mirrors `apps/worker/src/main.ts`'s own heartbeat computation exactly, scoped to this process alone. */
async function appProcessReading(): Promise<ProcessReading> {
  const usage = process.cpuUsage();
  const memory = process.memoryUsage();
  return {
    cpuUserSeconds: usage.user / 1_000_000,
    cpuSystemSeconds: usage.system / 1_000_000,
    memoryRssMb: Math.round(memory.rss / 1_000_000),
  };
}

/**
 * A fresh `purgeReport` scan, the same one `media-cleanup-routes.ts` runs for its own report endpoint,
 * reusing its `referencedByFor` builder rather than duplicating it. `context` is the same opaque request
 * context every other source above already threads through — `media.purgeReport` needs only the
 * `MEDIA_ASSET_PERMISSIONS.read` this file's caller already grants it — narrowed to `actor`/
 * `correlationId` only for `referencedByFor`'s own, differently-scoped `slideGroupContext`.
 */
async function mediaCleanupReading(
  media: Pick<MediaLibrary, 'purgeReport'>,
  db: RepositoryDb | undefined,
  now: () => string,
  graceDays: number,
  context: unknown,
): Promise<MediaCleanupReading> {
  const { actor, correlationId } = context as RequestContext;
  const referencedBy = await referencedByFor(db, now, actor, correlationId);
  const { items } = await media.purgeReport(context, { graceDays, referencedBy });
  const eligible = items.filter((item) => item.category === 'eligible');
  return { eligibleCount: eligible.length, reclaimableBytes: eligible.reduce((sum, item) => sum + item.bytes, 0) };
}

export interface OperationalSourcesOptions {
  readonly db: RepositoryDb;
  readonly queue: Pick<Queue, 'summary' | 'list'>;
  readonly media: Pick<MediaLibrary, 'list' | 'purgeReport'>;
  readonly dataDir: string;
  readonly mongoDb: MongoHealthDb;
  readonly corpus: Pick<ReturnType<typeof corpusClient>, 'translations'>;
  readonly corpusConfigured: boolean;
  readonly mediaRoot: string;
  readonly mediaFreeSpaceReserveBytes: number;
  readonly mediaCleanupGraceDays: number;
  readonly now?: () => string;
}

/**
 * `storage`/`readiness` are left off entirely rather than wired to always-`undefined` functions: no
 * server-side store exists yet for either OFFL-01's or OFFL-03's browser reports (Ruling 5), and
 * `observeOperationalHealth`'s `readOptional` already treats a missing source as "not yet reported"
 * rather than a fault.
 */
export function operationalSourcesOn(options: OperationalSourcesOptions, context: unknown): OperationalSources {
  const {
    db,
    queue,
    media,
    dataDir,
    mongoDb,
    corpus,
    corpusConfigured,
    mediaRoot,
    mediaFreeSpaceReserveBytes,
    mediaCleanupGraceDays,
    now = () => new Date().toISOString(),
  } = options;
  return {
    now,
    worker: () => workerHeartbeatReading(dataDir),
    queue: () => queueReading(db, queue, context),
    backups: () => recordedBackups(db, context),
    rehearsals: () => recordedRehearsals(db, context),
    media: () => media.list(context).then((rows) => rows.map((row) => row.manifest)),
    database: () => databaseReading(mongoDb),
    corpus: () => corpusReading(corpus, corpusConfigured),
    disk: () => diskReading(mediaRoot, mediaFreeSpaceReserveBytes),
    process: () => appProcessReading(),
    mediaCleanup: () => mediaCleanupReading(media, db, now, mediaCleanupGraceDays, context),
  };
}
