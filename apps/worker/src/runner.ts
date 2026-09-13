// The loop that turns a lease into work: claim one job, run the handler that knows how to do it, renew
// the lease while it runs, and tell the queue how it ended.
//
// Everything the loop cannot decide for itself is passed in — the clock, the wait between claims, the
// timer the renewals run on — because a runner that reaches for a real timer is a runner that can only
// be tested by waiting. What it decides itself is the part worth testing: an attempt is recorded only
// while this worker still holds the lease, and a job whose lease is gone is left to whoever reclaims it,
// which is the one rule that keeps a restart from running the same work twice.

import { readJob } from './jobs.js';

import type { Queue } from '@holydeck/app/queue';
import type { LeasedJob } from '@holydeck/contracts/jobs';

/** The part of the queue a runner uses. It runs jobs; putting them there is somebody else's call. */
export type RunnerQueue = Pick<Queue, 'claim' | 'heartbeat' | 'succeed' | 'fail' | 'recover'>;

/**
 * One kind of work. The signal is aborted when the lease is gone, which is a handler's cue to stop: the
 * job is about to be another worker's, and work done past that point is work done twice.
 */
export type Handler = (job: LeasedJob, signal: AbortSignal) => Promise<void>;

/** Starts a repeating call and answers with the way to stop it. Injected so a test drives the renewals. */
export type Ticker = (everyMs: number, tick: () => void) => () => void;

/** How long to wait before asking again when there was nothing to claim. */
export const DEFAULT_IDLE_MS = 1_000;

/** How often to renew a lease. A third of the queue's own lease, so two renewals may be lost before it is. */
export const DEFAULT_BEAT_MS = 10_000;

/** How many abandoned leases one idle tick releases. */
export const DEFAULT_SWEEP = 25;

export interface RunnerOptions {
  readonly queue: RunnerQueue;
  readonly context: unknown;
  readonly worker: string;
  readonly handlers: Readonly<Record<string, Handler>>;
  readonly now: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly ticker: Ticker;
  readonly report: (line: string) => void;
  readonly idleMs?: number;
  readonly beatMs?: number;
  readonly sweep?: number;
}

/** How one tick ended, which is what a test reads and what the loop decides whether to wait on. */
export type Attempt = 'ran' | 'failed' | 'lost' | 'idle';

export interface Runner {
  readonly kinds: readonly string[];
  once(): Promise<Attempt>;
  run(stopping: AbortSignal): Promise<void>;
}

const LEASE_GONE = 'the lease is gone, so this attempt is not this worker’s to record';

export function runnerOn(options: RunnerOptions): Runner {
  const { queue, context, worker, handlers, now, sleep, ticker, report } = options;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const beatMs = options.beatMs ?? DEFAULT_BEAT_MS;
  const sweep = options.sweep ?? DEFAULT_SWEEP;
  const kinds = Object.keys(handlers);
  // A claim names the kinds of work the worker runs. A runner with none would lease jobs it was never
  // going to do, which is worse than not running at all.
  if (kinds.length === 0) {
    throw new Error('a runner runs no kind of job until a handler is registered for one');
  }

  const attempt = async (job: LeasedJob, handler: Handler): Promise<Attempt> => {
    const label = `${job.kind} ${job.id}`;
    const holding = new AbortController();
    let renewing = false;
    const renew = async (): Promise<void> => {
      // A renewal still in flight is the answer to this tick as much as to the last one.
      if (renewing || holding.signal.aborted) return;
      renewing = true;
      try {
        if (!(await queue.heartbeat(context, { worker, id: job.id }))) holding.abort();
      } catch (error) {
        report(`${label}: the lease could not be renewed: ${(error as Error).message}`);
        holding.abort();
      } finally {
        renewing = false;
      }
    };

    const stopRenewing = ticker(beatMs, () => void renew());
    let failure: string | undefined;
    try {
      await handler(job, holding.signal);
    } catch (error) {
      failure = (error as Error).message;
    } finally {
      stopRenewing();
    }

    if (holding.signal.aborted) {
      report(`${label}: ${LEASE_GONE}`);
      return 'lost';
    }
    if (failure !== undefined) {
      report(`${label}: attempt ${job.attempt} failed: ${failure}`);
      await queue.fail(context, { worker, id: job.id, error: failure });
      return 'failed';
    }
    await queue.succeed(context, { worker, id: job.id });
    report(`${label}: done on attempt ${job.attempt}`);
    return 'ran';
  };

  // Nothing to claim is the moment to look for leases nobody is holding any more: a worker that died
  // holding one of a kind this worker does not run would otherwise stay leased until somebody noticed.
  const idle = async (): Promise<Attempt> => {
    const released = await queue.recover(context, { limit: sweep });
    if (released.length > 0) {
      report(`released ${released.length} ${released.length === 1 ? 'lease' : 'leases'} no worker was holding any more`);
    }
    return 'idle';
  };

  const once = async (): Promise<Attempt> => {
    const job = await queue.claim(context, { worker, kinds });
    if (job === undefined) return idle();

    // The queue hands back a lease it has just written, so one that has already run out here means this
    // clock and the queue's have drifted apart. Another worker reclaims it; an attempt recorded now would
    // be recorded against a lease this worker no longer holds.
    const runnable = readJob(job, now());
    if (!runnable.ok) {
      report(runnable.reasons.join('; '));
      return 'lost';
    }
    const handler = handlers[job.kind];
    if (handler === undefined) {
      const error = `this worker runs no handler for a ${job.kind} job`;
      report(`${job.kind} ${job.id}: ${error}`);
      await queue.fail(context, { worker, id: job.id, error });
      return 'failed';
    }
    return attempt(runnable.job, handler);
  };

  return {
    kinds,
    once,
    async run(stopping) {
      while (!stopping.aborted) {
        let ended: Attempt;
        try {
          ended = await once();
        } catch (error) {
          // A database that came back is a database worth asking again, so a refusal waits rather than ends.
          report(`the queue refused a call: ${(error as Error).message}`);
          ended = 'idle';
        }
        if (ended === 'idle' && !stopping.aborted) await sleep(idleMs);
      }
    },
  };
}
