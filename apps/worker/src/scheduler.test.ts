import { describe, expect, test } from 'vitest';

import { schedulerOn } from './scheduler.js';

import type { SchedulerOptions } from './scheduler.js';
import type { JobRecord } from '@holydeck/contracts/jobs';
import type { SchedulerState } from '@holydeck/app/schedule';

interface Call {
  readonly op: string;
  readonly input: unknown;
}

/** Settings that leave every job undue: every threshold is at the end of the day, no rehearsal today. */
const QUIET_SETTINGS = {
  timezone: 'UTC',
  backupDailyAt: '23:59',
  backupComponents: ['mongo', 'settings', 'media'],
  backupMinimumGapMinutes: 60,
  backupRehearsalWeekday: 'monday' as const,
  retentionSweepAt: '23:59',
};

const NOW = new Date('2026-09-13T12:00:00.000Z'); // a Sunday

/** A permanently-retired job, as `queue.list` would report one back to the scheduler. */
const failedJob = (overrides: {
  readonly id?: string;
  readonly kind?: string;
  readonly idempotencyKey?: string;
  readonly queuedAt?: string;
} = {}): JobRecord => ({
  id: overrides.id ?? 'job-failed-1',
  kind: overrides.kind ?? 'backup-run',
  idempotencyKey: overrides.idempotencyKey ?? 'backup-run:2026-09-13',
  payload: {},
  state: 'failed',
  attempt: 5,
  retryLimit: 5,
  queuedAt: overrides.queuedAt ?? '2026-09-12T00:00:00.000Z',
  workers: ['worker-1'],
  leaseExpiresAt: undefined,
  heartbeatAt: undefined,
  lastError: 'boom',
});

const open = (
  overrides: {
    readonly state?: SchedulerState;
    readonly changedSince?: (since: string | undefined) => Promise<boolean>;
    readonly settings?: SchedulerOptions['settings'];
    readonly sleep?: (ms: number) => Promise<void>;
    readonly report?: (line: string) => void;
    readonly list?: (context: unknown, input?: unknown) => Promise<readonly JobRecord[]>;
  } = {},
) => {
  const calls: Call[] = [];
  const waits: number[] = [];
  const reports: string[] = [];
  const state = overrides.state ?? {};
  const changedSinceCalls: (string | undefined)[] = [];
  const changedSince =
    overrides.changedSince ??
    (async (since: string | undefined): Promise<boolean> => {
      changedSinceCalls.push(since);
      return false;
    });
  const scheduler = schedulerOn({
    queue: {
      enqueue: async (_context, input) => {
        calls.push({ op: 'enqueue', input });
        return { id: 'job-1', created: true };
      },
      list: overrides.list ?? (async () => []),
      requeue: async (_context, input) => {
        calls.push({ op: 'requeue', input });
        return failedJob({ idempotencyKey: `${input.idempotencyKey}#2` });
      },
    },
    state: { read: async () => state, markBackup: async () => {}, markRestoreRehearsal: async () => {}, markRetentionSweep: async () => {} },
    settings: overrides.settings ?? QUIET_SETTINGS,
    context: { actor: 'system', permissions: ['queue.enqueue', 'queue.read', 'queue.requeue'], correlationId: 'scheduler-test' },
    changedSince,
    now: () => NOW,
    sleep:
      overrides.sleep ??
      (async (ms) => {
        waits.push(ms);
      }),
    report: overrides.report ?? ((line) => reports.push(line)),
  });
  return { scheduler, calls, waits, changedSinceCalls, reports };
};

describe('a tick', () => {
  test('enqueues the one job dueJobs reports, exactly as it reports it', async () => {
    const world = open({ settings: { ...QUIET_SETTINGS, backupDailyAt: '00:00' } });

    await world.scheduler.tick();

    expect(world.calls).toEqual([
      {
        op: 'enqueue',
        input: {
          kind: 'backup-run',
          idempotencyKey: 'backup-run:2026-09-13',
          payload: { components: QUIET_SETTINGS.backupComponents, trigger: 'scheduled' },
        },
      },
    ]);
  });

  test('enqueues nothing when dueJobs finds nothing due', async () => {
    const world = open();

    await world.scheduler.tick();

    expect(world.calls).toEqual([]);
  });

  test("asks changedSince about the state's current lastBackupAt", async () => {
    const world = open({ state: { lastBackupAt: '2026-09-12T00:00:00.000Z' } });

    await world.scheduler.tick();

    expect(world.changedSinceCalls).toEqual(['2026-09-12T00:00:00.000Z']);
  });
});

describe('running until it is told to stop', () => {
  test('stops looping once the signal is aborted', async () => {
    const stop = new AbortController();
    let ticks = 0;
    const world = open({
      changedSince: async () => {
        ticks += 1;
        if (ticks === 2) stop.abort();
        return false;
      },
    });

    await world.scheduler.run(stop.signal);

    expect(ticks).toBe(2);
    expect(world.waits).toEqual([60_000]);
  });

  test('claims nothing at all when it has already been stopped', async () => {
    const stop = new AbortController();
    stop.abort();
    const world = open();

    await world.scheduler.run(stop.signal);

    expect(world.changedSinceCalls).toEqual([]);
    expect(world.waits).toEqual([]);
  });

  test('reports a tick that throws and keeps looping instead of dying with it', async () => {
    const stop = new AbortController();
    let calls = 0;
    const world = open({
      changedSince: async () => {
        calls += 1;
        if (calls === 1) throw new Error('mongo blipped');
        stop.abort();
        return false;
      },
    });

    await world.scheduler.run(stop.signal);

    expect(calls).toBe(2);
    expect(world.waits).toEqual([60_000]);
    expect(world.reports).toEqual([expect.stringContaining('mongo blipped')]);
  });
});

describe('retrying a job whose earlier attempt failed for good', () => {
  const SETTINGS = { ...QUIET_SETTINGS, backupDailyAt: '00:00', backupMinimumGapMinutes: 60 };

  test('requeues a same-family failed job once the retry gap has elapsed, instead of enqueuing a fresh one', async () => {
    const failed = failedJob({ idempotencyKey: 'backup-run:2026-09-13', queuedAt: '2026-09-13T09:00:00.000Z' });
    const world = open({ settings: SETTINGS, list: async () => [failed] });

    await world.scheduler.tick();

    expect(world.calls).toEqual([{ op: 'requeue', input: { id: failed.id, idempotencyKey: failed.idempotencyKey } }]);
  });

  test('waits rather than requeuing a same-family failed job before the retry gap has elapsed', async () => {
    const failed = failedJob({ idempotencyKey: 'backup-run:2026-09-13', queuedAt: '2026-09-13T11:30:00.000Z' });
    const world = open({ settings: SETTINGS, list: async () => [failed] });

    await world.scheduler.tick();

    expect(world.calls).toEqual([]);
  });

  test('a failed job of a different kind does not block enqueuing the one that is due', async () => {
    const failed = failedJob({ kind: 'restore-run', idempotencyKey: 'restore-run:2026-09-13' });
    const world = open({ settings: SETTINGS, list: async () => [failed] });

    await world.scheduler.tick();

    expect(world.calls).toEqual([
      {
        op: 'enqueue',
        input: {
          kind: 'backup-run',
          idempotencyKey: 'backup-run:2026-09-13',
          payload: { components: QUIET_SETTINGS.backupComponents, trigger: 'scheduled' },
        },
      },
    ]);
  });

  test('matches a failed job already carrying a requeue suffix as the same family', async () => {
    const failed = failedJob({ idempotencyKey: 'backup-run:2026-09-13#2', queuedAt: '2026-09-13T09:00:00.000Z' });
    const world = open({ settings: SETTINGS, list: async () => [failed] });

    await world.scheduler.tick();

    expect(world.calls).toEqual([{ op: 'requeue', input: { id: failed.id, idempotencyKey: 'backup-run:2026-09-13#2' } }]);
  });
});
