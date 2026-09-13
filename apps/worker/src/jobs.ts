// The boundary between the queue and the work. A record the worker cannot read, or one whose lease is
// not the worker's to hold, is refused with the reasons written out: a job that is quarantined with a
// reason can be fixed, while one that is attempted anyway fails somewhere nobody is watching.

import { type LeasedJob, parseJobRecord } from '@holydeck/contracts/jobs';

export type Runnable = { readonly ok: true; readonly job: LeasedJob };
export type NotRunnable = { readonly ok: false; readonly reasons: readonly string[] };

export function readJob(record: unknown, now: string): Runnable | NotRunnable {
  const parsed = parseJobRecord(record);
  if (!parsed.ok) {
    return { ok: false, reasons: parsed.problems.map((problem) => `${problem.path}: ${problem.message}`) };
  }
  const job = parsed.value;
  if (job.state !== 'leased') {
    return { ok: false, reasons: [`${job.id}: is ${job.state}, not leased by this worker`] };
  }
  // A lease that has run out belongs to whichever worker reclaims it next. Running it anyway is how the
  // same job executes twice, which is the one thing the lease exists to prevent.
  if (Date.parse(job.leaseExpiresAt) <= Date.parse(now)) {
    return { ok: false, reasons: [`${job.id}: the lease ran out at ${job.leaseExpiresAt}`] };
  }
  return { ok: true, job };
}
