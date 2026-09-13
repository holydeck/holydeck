import { describe, expect, test } from 'vitest';

import { runnerOn } from './runner.js';

import type { JobRecord, LeasedJob } from '@holydeck/contracts/jobs';
import type { Handler, RunnerQueue, Ticker } from './runner.js';

const WORKER = 'worker-1';
const EARLIER = '2026-09-13T09:00:00.000Z';
const NOW = '2026-09-13T09:00:10.000Z';
const LATER = '2026-09-13T09:00:40.000Z';

const leased = (fields: Partial<LeasedJob> = {}): LeasedJob => ({
  id: 'job-1',
  kind: 'prepare',
  idempotencyKey: 'prepare:service-1',
  state: 'leased',
  attempt: 1,
  retryLimit: 5,
  queuedAt: EARLIER,
  workers: [WORKER],
  leaseExpiresAt: LATER,
  heartbeatAt: NOW,
  lastError: undefined,
  ...fields,
});

const settled = (job: LeasedJob, state: 'succeeded' | 'failed', lastError?: string): JobRecord => ({
  ...job,
  state,
  workers: [],
  leaseExpiresAt: undefined,
  heartbeatAt: undefined,
  lastError,
});

interface Call {
  readonly op: string;
  readonly input: unknown;
}

interface Answers {
  readonly claim?: readonly (LeasedJob | undefined)[];
  readonly heartbeat?: readonly (boolean | Error)[];
  readonly recover?: readonly (readonly JobRecord[])[];
}

/** A queue that answers what the test scripted and records what it was asked, so one tick can be read back. */
const stub = (answers: Answers = {}) => {
  const calls: Call[] = [];
  const left = new Map<string, unknown[]>(Object.entries(answers).map(([op, list]) => [op, [...(list as unknown[])]]));
  const take = <T>(op: string, fallback: T): T => {
    const list = left.get(op) ?? [];
    if (list.length === 0) return fallback;
    const answer = list.shift() as T;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const queue: RunnerQueue = {
    async claim(_context, input) {
      calls.push({ op: 'claim', input });
      return take<LeasedJob | undefined>('claim', undefined);
    },
    async heartbeat(_context, input) {
      calls.push({ op: 'heartbeat', input });
      return take('heartbeat', true);
    },
    async succeed(_context, input) {
      calls.push({ op: 'succeed', input });
      return settled(leased(), 'succeeded');
    },
    async fail(_context, input) {
      calls.push({ op: 'fail', input });
      return settled(leased(), 'failed', (input as { error: string }).error);
    },
    async recover(_context, options) {
      calls.push({ op: 'recover', input: options });
      return take<readonly JobRecord[]>('recover', []);
    },
  };
  return { queue, calls, ops: (): string[] => calls.map((call) => call.op) };
};

/** A handler that parks until the test lets it finish, which is the only time a lease is worth renewing. */
const parked = () => {
  let release: (() => void) | undefined;
  let given: AbortSignal | undefined;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const handler: Handler = async (_job, signal) => {
    given = signal;
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
      signal.addEventListener('abort', () => resolve());
    });
  };
  return { handler, started, finish: (): void => release?.(), signal: (): AbortSignal | undefined => given };
};

interface Beat {
  readonly everyMs: number;
  readonly tick: () => void;
  cancelled: boolean;
}

const open = (answers: Answers = {}, handlers: Record<string, Handler> = { prepare: async () => {} }) => {
  const scripted = stub(answers);
  const beats: Beat[] = [];
  const waits: number[] = [];
  const lines: string[] = [];
  const ticker: Ticker = (everyMs, tick) => {
    const beat: Beat = { everyMs, tick, cancelled: false };
    beats.push(beat);
    return (): void => {
      beat.cancelled = true;
    };
  };
  const runner = runnerOn({
    queue: scripted.queue,
    context: { actor: 'system', permissions: ['jobs.run', 'jobs.read'], correlationId: 'worker-test' },
    worker: WORKER,
    handlers,
    now: () => NOW,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ticker,
    report: (line) => lines.push(line),
  });
  return { runner, beats, waits, lines, ...scripted };
};

describe('what a runner claims', () => {
  test('claims the kinds it has a handler for, under its own name', async () => {
    const world = open({}, { prepare: async () => {}, 'render-slide': async () => {} });
    expect(world.runner.kinds).toEqual(['prepare', 'render-slide']);

    await world.runner.once();
    expect(world.calls[0]).toEqual({
      op: 'claim',
      input: { worker: WORKER, kinds: ['prepare', 'render-slide'] },
    });
  });

  // A claim names the kinds of work the worker runs. A runner with none would claim every kind and run
  // none of them, which is how a job is leased by a process that was never going to do it.
  test('refuses to be built with no handler at all', () => {
    expect(() => open({}, {})).toThrow(/runs no kind of job/u);
  });
});

describe('one job', () => {
  test('runs the handler and tells the queue the attempt succeeded', async () => {
    const world = open({ claim: [leased()] });

    expect(await world.runner.once()).toBe('ran');
    expect(world.ops()).toEqual(['claim', 'succeed']);
    expect(world.calls[1]?.input).toEqual({ worker: WORKER, id: 'job-1' });
    expect(world.lines).toEqual(['prepare job-1: done on attempt 1']);
  });

  test('tells the queue what the handler threw, so an operator reads the reason', async () => {
    const world = open(
      { claim: [leased()] },
      {
        prepare: async () => {
          throw new Error('the service has no slides');
        },
      },
    );

    expect(await world.runner.once()).toBe('failed');
    expect(world.calls[1]).toEqual({
      op: 'fail',
      input: { worker: WORKER, id: 'job-1', error: 'the service has no slides' },
    });
    expect(world.lines).toEqual(['prepare job-1: attempt 1 failed: the service has no slides']);
  });

  test('renews the lease while the handler is still running, and stops once it is done', async () => {
    const held = parked();
    const world = open({ claim: [leased()] }, { prepare: held.handler });

    const running = world.runner.once();
    await held.started;
    const beat = world.beats[0];
    expect(beat?.everyMs).toBe(10_000);
    beat?.tick();
    expect(world.calls[1]).toEqual({ op: 'heartbeat', input: { worker: WORKER, id: 'job-1' } });

    held.finish();
    expect(await running).toBe('ran');
    expect(beat?.cancelled).toBe(true);
    expect(world.ops()).toEqual(['claim', 'heartbeat', 'succeed']);
  });

  test('renews once at a time, because a slow answer is not a reason to ask twice', async () => {
    const held = parked();
    const world = open({ claim: [leased()] }, { prepare: held.handler });

    const running = world.runner.once();
    await held.started;
    const beat = world.beats[0];
    beat?.tick();
    beat?.tick();
    expect(world.ops()).toEqual(['claim', 'heartbeat']);

    held.finish();
    await running;
  });

  test('aborts the handler when the lease is gone, and records nothing', async () => {
    const held = parked();
    const world = open({ claim: [leased()], heartbeat: [false] }, { prepare: held.handler });

    const running = world.runner.once();
    await held.started;
    world.beats[0]?.tick();

    expect(await running).toBe('lost');
    expect(held.signal()?.aborted).toBe(true);
    expect(world.ops()).toEqual(['claim', 'heartbeat']);
    expect(world.lines).toEqual([
      'prepare job-1: the lease is gone, so this attempt is not this worker’s to record',
    ]);
  });

  // A lease that cannot be renewed is a lease that expires, so the honest thing is to stop now rather
  // than to finish work another worker is about to start.
  test('aborts the handler when the renewal itself was refused', async () => {
    const held = parked();
    const world = open(
      { claim: [leased()], heartbeat: [new Error('the database is not answering')] },
      { prepare: held.handler },
    );

    const running = world.runner.once();
    await held.started;
    world.beats[0]?.tick();

    expect(await running).toBe('lost');
    expect(world.lines).toEqual([
      'prepare job-1: the lease could not be renewed: the database is not answering',
      'prepare job-1: the lease is gone, so this attempt is not this worker’s to record',
    ]);
  });

  test('reports the lease as gone even when the handler threw on its way out', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const world = open(
      { claim: [leased()], heartbeat: [false] },
      {
        prepare: async (_job, signal) => {
          entered();
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
          throw new Error('stopped halfway');
        },
      },
    );

    const running = world.runner.once();
    await started;
    world.beats[0]?.tick();

    expect(await running).toBe('lost');
    expect(world.ops()).toEqual(['claim', 'heartbeat']);
  });

  // The queue hands back a lease it has just written, so an expired one here means this worker's clock
  // and the queue's have drifted apart. Another worker will reclaim it; recording an attempt would not.
  test('leaves a job whose lease has already run out to whichever worker reclaims it', async () => {
    const world = open({ claim: [leased({ leaseExpiresAt: EARLIER })] });

    expect(await world.runner.once()).toBe('lost');
    expect(world.ops()).toEqual(['claim']);
    expect(world.lines).toEqual([`job-1: the lease ran out at ${EARLIER}`]);
  });

  test('fails a job of a kind this worker runs no handler for', async () => {
    const world = open({ claim: [leased({ kind: 'transcode', idempotencyKey: 'transcode:media-1' })] });

    expect(await world.runner.once()).toBe('failed');
    expect(world.calls[1]).toEqual({
      op: 'fail',
      input: { worker: WORKER, id: 'job-1', error: 'this worker runs no handler for a transcode job' },
    });
  });
});

describe('an idle tick', () => {
  test('sweeps the leases no worker is holding any more, and says how many', async () => {
    const world = open({ claim: [undefined], recover: [[settled(leased(), 'failed', 'gone')]] });

    expect(await world.runner.once()).toBe('idle');
    expect(world.ops()).toEqual(['claim', 'recover']);
    expect(world.lines).toEqual(['released 1 lease no worker was holding any more']);
  });

  test('counts more than one the way a reader reads it', async () => {
    const gone = [settled(leased(), 'failed', 'gone'), settled(leased({ id: 'job-2' }), 'failed', 'gone')];
    const world = open({ claim: [undefined], recover: [gone] });

    await world.runner.once();
    expect(world.lines).toEqual(['released 2 leases no worker was holding any more']);
  });

  test('says nothing when there was nothing to sweep', async () => {
    const world = open({ claim: [undefined] });

    expect(await world.runner.once()).toBe('idle');
    expect(world.lines).toEqual([]);
  });
});

describe('running until it is told to stop', () => {
  test('claims nothing at all when it has already been stopped', async () => {
    const world = open({ claim: [leased()] });
    const stop = new AbortController();
    stop.abort();

    await world.runner.run(stop.signal);
    expect(world.ops()).toEqual([]);
  });

  test('runs one job after another until the signal says to stop', async () => {
    const stop = new AbortController();
    const world = open(
      { claim: [leased(), leased({ id: 'job-2' })] },
      {
        prepare: async (job) => {
          if (job.id === 'job-2') stop.abort();
        },
      },
    );

    await world.runner.run(stop.signal);
    expect(world.ops()).toEqual(['claim', 'succeed', 'claim', 'succeed']);
  });

  test('waits before asking again when there was nothing to claim', async () => {
    const stop = new AbortController();
    const world = open({ claim: [undefined, leased()] }, { prepare: async () => stop.abort() });

    await world.runner.run(stop.signal);
    expect(world.waits).toEqual([1_000]);
  });

  // A database that came back is a database worth asking again: exiting the loop would need a restart
  // for a fault that healed itself.
  test('keeps running after the queue refused a call', async () => {
    const stop = new AbortController();
    let asked = 0;
    const world = open({}, { prepare: async () => {} });
    const refusing: RunnerQueue = {
      ...world.queue,
      async claim(context, input) {
        asked += 1;
        if (asked === 1) throw new Error('the database is not answering');
        stop.abort();
        return world.queue.claim(context, input);
      },
    };
    const runner = runnerOn({
      queue: refusing,
      context: { actor: 'system', permissions: ['jobs.run'], correlationId: 'worker-test' },
      worker: WORKER,
      handlers: { prepare: async () => {} },
      now: () => NOW,
      sleep: async () => {},
      ticker: () => (): void => {},
      report: (line) => world.lines.push(line),
    });

    await runner.run(stop.signal);
    expect(asked).toBe(2);
    expect(world.lines[0]).toBe('the queue refused a call: the database is not answering');
  });
});
