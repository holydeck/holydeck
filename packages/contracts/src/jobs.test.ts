import { describe, expect, it } from 'vitest';

import { ADMIN_VISIBLE_FIELDS, JOB_FIELDS, JOB_STATES, parseJobRecord } from './jobs.js';
import { FIELD_CODES } from './problems.js';

// The jobs recorded in contracts/fixtures/jobs.v1.json, written out here because the product repository
// holds no phase artifacts, with the lifecycle fields a record carries that a behaviour recording omits.
const queued = () => ({
  id: 'job-1',
  kind: 'prepare',
  idempotencyKey: 'prepare:service-1:rev-5',
  state: 'queued',
  attempt: 1,
  retryLimit: 5,
  queuedAt: '2026-09-13T09:30:00Z',
  workers: [],
});

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
  lastError: 'the first attempt lost its lease',
});

const codes = (value: unknown) => {
  const parsed = parseJobRecord(value);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}=${problem.code}`);
};

const without = (value: Record<string, unknown>, ...fields: readonly string[]): Record<string, unknown> => {
  const copy = { ...value };
  for (const field of fields) delete copy[field];
  return copy;
};

describe('what a queue is allowed to hold', () => {
  it('names the four states the queue declares', () => {
    expect(JOB_STATES).toEqual(['queued', 'leased', 'succeeded', 'failed']);
  });

  it('names every field a job carries, so a reader of one has the whole list', () => {
    expect(JOB_FIELDS).toEqual([
      'id',
      'kind',
      'idempotencyKey',
      'state',
      'attempt',
      'retryLimit',
      'queuedAt',
      'workers',
      'leaseExpiresAt',
      'heartbeatAt',
      'lastError',
    ]);
  });

  // An operator screen that hides part of a job is a screen a failure can hide behind: the kind names
  // which work is stuck and the worker list names what to restart, and neither is inferable from the rest.
  it('shows an administrator every field a job carries, and a record carries exactly those', () => {
    expect(ADMIN_VISIBLE_FIELDS).toEqual(JOB_FIELDS);
    for (const record of [queued(), leased()]) {
      const parsed = parseJobRecord(record);
      expect(parsed.ok).toBe(true);
      expect(Object.keys(parsed.ok ? parsed.value : {}).sort()).toEqual([...JOB_FIELDS].sort());
    }
  });
});

describe('reading one job record', () => {
  it('parses a queued job that no worker has touched', () => {
    expect(parseJobRecord(queued())).toEqual({ ok: true, value: queued() });
  });

  it('parses a leased job with the expiry and the heartbeat its lease is judged by', () => {
    expect(parseJobRecord(leased())).toEqual({ ok: true, value: leased() });
  });

  it('parses a finished job without asking for lease fields it no longer has', () => {
    const succeeded = { ...queued(), state: 'succeeded', attempt: 2 };
    expect(parseJobRecord(succeeded)).toEqual({ ok: true, value: succeeded });
  });

  it('refuses a record that is not a record', () => {
    expect(parseJobRecord([])).toEqual({
      ok: false,
      problems: [{ path: 'job', code: FIELD_CODES.notAnObject, message: 'must be an object' }],
    });
  });

  it('refuses a job with no idempotency key, because a reclaimed lease would run the work twice', () => {
    expect(codes(without(queued(), 'idempotencyKey'))).toEqual([`job.idempotencyKey=${FIELD_CODES.required}`]);
  });

  it('refuses a key that does not name the work it is a key for', () => {
    expect(codes({ ...queued(), idempotencyKey: 'transcode:media-4' })).toEqual([
      `job.idempotencyKey=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses a kind that is not a name, and a state the queue never declared', () => {
    expect(codes({ ...queued(), kind: 'Prepare Service', state: 'parked' })).toEqual([
      `job.kind=${FIELD_CODES.notAllowed}`,
      `job.idempotencyKey=${FIELD_CODES.notAllowed}`,
      `job.state=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses an attempt or a retry limit that never counted anything', () => {
    expect(codes({ ...queued(), attempt: 0, retryLimit: 0 })).toEqual([
      `job.attempt=${FIELD_CODES.tooSmall}`,
      `job.retryLimit=${FIELD_CODES.tooSmall}`,
    ]);
  });

  it('refuses an attempt past the retry limit, which is a job that should have stopped', () => {
    expect(codes({ ...queued(), attempt: 6, retryLimit: 5 })).toEqual([`job.attempt=${FIELD_CODES.notAllowed}`]);
  });

  it('refuses a leased job with no expiry and no heartbeat, reporting both', () => {
    expect(codes(without(leased(), 'leaseExpiresAt', 'heartbeatAt'))).toEqual([
      `job.leaseExpiresAt=${FIELD_CODES.required}`,
      `job.heartbeatAt=${FIELD_CODES.required}`,
    ]);
  });

  it('refuses a job leased to two workers at once, because a lease is exclusive', () => {
    expect(codes({ ...leased(), workers: ['worker-a', 'worker-b'] })).toEqual([
      `job.workers=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses a worker list that is not a list of workers', () => {
    expect(codes({ ...queued(), workers: 'worker-a' })).toEqual([`job.workers=${FIELD_CODES.notAList}`]);
  });

  it('refuses a lease expiry that is not an instant', () => {
    expect(codes({ ...leased(), leaseExpiresAt: 'in five minutes' })).toEqual([
      `job.leaseExpiresAt=${FIELD_CODES.notATime}`,
    ]);
  });
});
