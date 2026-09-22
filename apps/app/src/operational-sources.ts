// Builds the `OperationalSources` `operational-health.ts` grades (OPS-09). Every function here is a
// thin reader over state this product already keeps somewhere else — the worker's heartbeat file, the
// queue's own collection, the recorded backups and restore rehearsals, the media manifest — and none of
// it judges anything; judging is `operational-health.ts`'s job alone; see research-notes.md's Task 10-10
// section for why this covers exactly five required and zero optional sources, not the broader Mongo/
// corpus/disk/process design the spec's own prose and this plan's "Do" section describe (Ruling 1).

import { readFile } from 'node:fs/promises';

import { JOBS_COLLECTION } from './queue.js';
import { RESTORE_RECORD } from './restores.js';
import { recordedBackups } from './backups.js';
import { repositoriesOn } from './repositories.js';

import type { BackupObjectives } from '@holydeck/contracts/backups';
import type { MediaLibrary } from './media.js';
import type { OperationalSources, QueueReading, RecordedRehearsal, WorkerHeartbeatReading } from './operational-health.js';
import type { Queue } from './queue.js';
import type { RepositoryDb } from './repositories.js';

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

export interface OperationalSourcesOptions {
  readonly db: RepositoryDb;
  readonly queue: Pick<Queue, 'summary' | 'list'>;
  readonly media: Pick<MediaLibrary, 'list'>;
  readonly dataDir: string;
  readonly now?: () => string;
}

/**
 * `storage`/`readiness` are left off entirely rather than wired to always-`undefined` functions: no
 * server-side store exists yet for either OFFL-01's or OFFL-03's browser reports (Ruling 5), and
 * `observeOperationalHealth`'s `readOptional` already treats a missing source as "not yet reported"
 * rather than a fault.
 */
export function operationalSourcesOn(options: OperationalSourcesOptions, context: unknown): OperationalSources {
  const { db, queue, media, dataDir, now = () => new Date().toISOString() } = options;
  return {
    now,
    worker: () => workerHeartbeatReading(dataDir),
    queue: () => queueReading(db, queue, context),
    backups: () => recordedBackups(db, context),
    rehearsals: () => recordedRehearsals(db, context),
    media: () => media.list(context).then((rows) => rows.map((row) => row.manifest)),
  };
}
