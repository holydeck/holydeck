import { describe, expect, it } from 'vitest';

import { readJob } from './jobs.js';

const now = '2026-09-13T09:34:40Z';

const leased = () => ({
  id: 'job-2',
  kind: 'transcode',
  idempotencyKey: 'transcode:media-4',
  state: 'leased',
  attempt: 2,
  retryLimit: 5,
  queuedAt: '2026-09-13T09:31:00Z',
  leaseExpiresAt: '2026-09-13T09:35:00Z',
  heartbeatAt: '2026-09-13T09:34:30Z',
  workers: ['worker-a'],
});

const reasons = (record: unknown, at = now) => {
  const read = readJob(record, at);
  expect(read.ok).toBe(false);
  return read.ok ? [] : read.reasons;
};

describe('reading one record out of the queue', () => {
  it('accepts a leased job whose lease has not run out', () => {
    expect(readJob(leased(), now)).toEqual({ ok: true, job: expect.objectContaining({ id: 'job-2' }) });
  });

  it('refuses a record the contract cannot read, naming every problem so it can be quarantined', () => {
    expect(reasons({ ...leased(), attempt: 0, heartbeatAt: 'a while ago' })).toEqual([
      'job.attempt: must be at least 1',
      'job.heartbeatAt: must be a UTC instant such as 2026-09-13T09:30:00Z',
    ]);
  });

  it('refuses a record that is not a record at all', () => {
    expect(reasons('job-2')).toEqual(['job: must be an object']);
  });

  it('refuses a job no worker has leased, because there is nothing here to run', () => {
    const queued = { ...leased(), state: 'queued', leaseExpiresAt: undefined, heartbeatAt: undefined, workers: [] };
    expect(reasons(queued)).toEqual(['job-2: is queued, not leased by this worker']);
  });

  it('refuses a job whose lease has already run out, because it belongs to whoever reclaims it', () => {
    expect(reasons(leased(), '2026-09-13T09:35:30Z')).toEqual([
      'job-2: the lease ran out at 2026-09-13T09:35:00Z',
    ]);
  });

  it('refuses a lease that runs out exactly now, rather than racing the reclaim', () => {
    expect(reasons(leased(), '2026-09-13T09:35:00Z')).toEqual([
      'job-2: the lease ran out at 2026-09-13T09:35:00Z',
    ]);
  });
});
