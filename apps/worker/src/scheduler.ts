// The loop that turns "what is due" into work: read where the scheduler last left off, ask `dueJobs` what
// follows from that and the clock, and enqueue it. Everything a job actually does — and recording that it
// finished — belongs to that job's own handler (R7); this loop only ever enqueues.

import { dueJobs } from '@holydeck/app/schedule';

import type { DueJobsSettings } from '@holydeck/app/schedule';
import type { Queue } from '@holydeck/app/queue';
import type { SchedulerStateStore } from './scheduler-state.js';

/** How often the scheduler checks what is due. A minute is fine resolution for jobs that fire daily/weekly. */
const TICK_MS = 60_000;

export interface SchedulerOptions {
  readonly queue: Pick<Queue, 'enqueue'>;
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
    for (const job of jobs) {
      await options.queue.enqueue(options.context, {
        kind: job.kind,
        idempotencyKey: job.idempotencyKey,
        payload: job.payload,
      });
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
