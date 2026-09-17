// One job record, as the queue stores it and a worker reads it back. The lifecycle rules that can be
// judged from a single record are enforced here — a leased job has something to expire and something to
// prove it is alive, a lease belongs to one worker, an attempt never passes its own retry limit — while
// claiming, reclaiming and retrying are the queue's behaviour and belong with it.

import { FIELD_CODES, isRecord, type FieldReader, type Parsed, type ParseFn, parseObject } from './problems.js';

export const JOB_STATES = ['queued', 'leased', 'succeeded', 'failed'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Every field a job carries, in the order a record reads. Nothing about a job lives outside this list. */
export const JOB_FIELDS = [
  'id',
  'kind',
  'idempotencyKey',
  'payload',
  'state',
  'attempt',
  'retryLimit',
  'queuedAt',
  'workers',
  'leaseExpiresAt',
  'heartbeatAt',
  'lastError',
] as const;

export type JobField = (typeof JOB_FIELDS)[number];

/** Work-specific data, carried with the job rather than inferred from its idempotency key. */
export type JobPayload = Readonly<Record<string, unknown>>;

// An administrator is shown the whole record rather than a chosen part of it: the queue decision asks the
// operator screen to answer which worker holds a job and which work it is, and a projection that dropped
// the kind or the lease holder answered neither. A job holds no secret — its key names work, not a person
// — so there is nothing here to withhold, and one list means a field added later cannot arrive invisible.
export const ADMIN_VISIBLE_FIELDS = JOB_FIELDS;

type JobFields = {
  readonly id: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: JobPayload;
  readonly attempt: number;
  readonly retryLimit: number;
  readonly queuedAt: string;
  readonly workers: readonly string[];
  readonly lastError: string | undefined;
};

/** A leased job has something for its lease to expire at and something to prove it is still alive. */
export type LeasedJob = JobFields & {
  readonly state: 'leased';
  readonly leaseExpiresAt: string;
  readonly heartbeatAt: string;
};

export type UnleasedJob = JobFields & {
  readonly state: Exclude<JobState, 'leased'>;
  readonly leaseExpiresAt: string | undefined;
  readonly heartbeatAt: string | undefined;
};

// The two shapes are separate types rather than one with optional fields, so a caller that has already
// checked the state does not have to defend against an expiry the parser guaranteed is there.
export type JobRecord = LeasedJob | UnleasedJob;

const KIND = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const readKind = (reader: FieldReader): string => {
  const kind = reader.text('kind');
  if (kind !== '' && !KIND.test(kind)) {
    reader.reject('kind', FIELD_CODES.notAllowed, 'must be a lower-case name in words joined by hyphens');
  }
  return kind;
};

// The key names the work it is a key for, so a key copied from another kind of job cannot silently
// suppress the work this one exists to do.
const readIdempotencyKey = (reader: FieldReader, kind: string): string => {
  const key = reader.text('idempotencyKey');
  if (key !== '' && !key.startsWith(`${kind}:`)) {
    reader.reject('idempotencyKey', FIELD_CODES.notAllowed, `must begin with ${kind}:`);
  }
  return key;
};

const parsePayload: ParseFn<JobPayload> = (value, path) =>
  isRecord(value) ? { ok: true, value } : { ok: false, problems: [{ path, code: FIELD_CODES.notAnObject, message: 'must be an object' }] };

// A job may carry no work data of its own, so an absent payload is not the same refusal as one that is
// present but the wrong shape: only the second is a problem this record reports.
const readPayload = (reader: FieldReader): JobPayload => reader.optionalParsed('payload', parsePayload) ?? {};

export function parseJobRecord(value: unknown): Parsed<JobRecord> {
  return parseObject(value, 'job', (reader) => {
    const id = reader.text('id');
    const kind = readKind(reader);
    const idempotencyKey = readIdempotencyKey(reader, kind);
    const payload = readPayload(reader);
    const state = reader.choice('state', JOB_STATES);
    const attempt = reader.wholeNumber('attempt', 1);
    const retryLimit = reader.wholeNumber('retryLimit', 1);
    if (attempt > retryLimit) {
      reader.reject('attempt', FIELD_CODES.notAllowed, `must not be past the retry limit of ${retryLimit}`);
    }
    const queuedAt = reader.time('queuedAt');
    const workers = reader.textList('workers');
    if (workers.length > 1) {
      reader.reject('workers', FIELD_CODES.notAllowed, `must be at most one worker, not ${workers.length}`);
    }
    const fields: JobFields = {
      id,
      kind,
      idempotencyKey,
      payload,
      attempt,
      retryLimit,
      queuedAt,
      workers,
      lastError: reader.optionalText('lastError'),
    };
    if (state === 'leased') {
      return {
        ...fields,
        state,
        leaseExpiresAt: reader.time('leaseExpiresAt'),
        heartbeatAt: reader.time('heartbeatAt'),
      };
    }
    return {
      ...fields,
      state,
      leaseExpiresAt: reader.optionalTime('leaseExpiresAt'),
      heartbeatAt: reader.optionalTime('heartbeatAt'),
    };
  });
}
