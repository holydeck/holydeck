// The loop that turns "what is due" into work: read where the scheduler last left off, ask `dueJobs` what
// follows from that and the clock, and enqueue it. Everything a job actually does — and recording that it
// finished — belongs to that job's own handler (R7); this loop only ever enqueues.

import { dueJobs } from '@holydeck/app/schedule';

import type { DueJobsSettings } from '@holydeck/app/schedule';
import type { Queue } from '@holydeck/app/queue';
import type { SchedulerStateStore } from './scheduler-state.js';

/** How often the scheduler checks what is due. A minute is fine resolution for jobs that fire daily/weekly. */
const TICK_MS = 60_000;

// A due job's own key names its family (`backup-run:2026-09-13`), never a requeued member of it
// (`backup-run:2026-09-13#2`) — `queue.ts`'s `requeueKey` only ever adds one suffix, replacing rather than
// stacking an earlier one, so stripping a single trailing `#<digits>` is enough to recognise a match.
const SERIES = /#\d+$/u;
const sameFamily = (candidate: string, key: string): boolean => candidate.replace(SERIES, '') === key;

export interface SchedulerOptions {
  readonly queue: Pick<Queue, 'enqueue' | 'list' | 'requeue'>;
  readonly state: SchedulerStateStore;
  readonly settings: DueJobsSettings;
  readonly context: unknown;
  /** Whether a content/presentation/settings write was audited since the instant given, or ever if `undefined`. */
  readonly changedSince: (since: string | undefined) => Promise<boolean>;
  readonly now?: () => Date;
  /** Injected so a test drives the loop without waiting out a real minute. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly report: (line: string) => void;
}

export interface Scheduler {
  tick(): Promise<void>;
  run(stop: AbortSignal): Promise<void>;
}

export function schedulerOn(options: SchedulerOptions): Scheduler {
  const now = options.now ?? ((): Date => new Date());

  const tick = async (): Promise<void> => {
    const state = await options.state.read();
    const changedSinceLastBackup = await options.changedSince(state.lastBackupAt);
    const jobs = dueJobs({ now: now(), settings: options.settings, state, changedSinceLastBackup });
    if (jobs.length === 0) return;

    // `enqueue` treats any family member as "already exists" regardless of its state (`queue.ts`), so a job
    // that failed for good would otherwise block every future tick from ever enqueueing that family again —
    // only a `requeue`, which bumps the key, can revive it. Reusing `backupMinimumGapMinutes` as the retry
    // gap for every kind: there is no per-kind retry-gap setting, and this is the same "don't hammer it"
    // cadence the backup gap already expresses.
    const failed = await options.queue.list(options.context, {
      states: ['failed'],
      kinds: [...new Set(jobs.map((job) => job.kind))],
    });
    for (const job of jobs) {
      const stalled = failed.find((candidate) => candidate.kind === job.kind && sameFamily(candidate.idempotencyKey, job.idempotencyKey));
      if (stalled === undefined) {
        await options.queue.enqueue(options.context, {
          kind: job.kind,
          idempotencyKey: job.idempotencyKey,
          payload: job.payload,
        });
        continue;
      }
      const gapElapsed = now().getTime() - Date.parse(stalled.queuedAt) >= options.settings.backupMinimumGapMinutes * 60_000;
      if (gapElapsed) {
        await options.queue.requeue(options.context, { id: stalled.id, idempotencyKey: stalled.idempotencyKey });
      }
    }
  };

  const run = async (stop: AbortSignal): Promise<void> => {
    while (!stop.aborted) {
      // A tick failing (a transient Mongo error from `state.read()`/`changedSince()`/`queue.enqueue()`)
      // must not take the loop down with it: `main.ts` runs this alongside the job runner under one
      // `Promise.all`, so an uncaught rejection here would kill that too. Report it and try again next tick.
      try {
        await tick();
      } catch (error) {
        options.report(`scheduler: tick failed, trying again next tick: ${(error as Error).message}`);
      }
      if (stop.aborted) return;
      await options.sleep(TICK_MS);
    }
  };

  return { tick, run };
}
