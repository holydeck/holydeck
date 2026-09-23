// The job that grades the audit trail against its own declared window (OPS-07): finds which rows are
// old enough to be considered, asks `retention.ts`'s own `sweep` to grade them, and writes down what it
// found. Notification read-state expiry deletes rows through its own store; the audit trail remains
// append-only — `retention.ts`'s own header says wiring an actual delete is later work it
// deliberately leaves undone (no `Repository` class exposes update or delete at all, ADR 0009). Grading
// and auditing the outcome is everything OPS-07's literal text asks of this job.
//
// autosave-revision is not graded yet: which rows are still referenced by a live song or service is
// content-model research this task defers — see the `report()` line below and the maintainer TODO it
// names. It is still swept, as an explicit empty batch, so the trail's own `retention.sweep` entry always
// names both classes rather than silently omitting the deferred one. `audit-entry` alone already
// satisfies OPS-07's literal text that "a sweep runs."

import { auditOn } from '@holydeck/app/audit';
import { repositoriesOn } from '@holydeck/app/repositories';
import { policyFor, sweep } from '@holydeck/app/retention';

import type { NotificationStore } from '@holydeck/app/notification-store';
import type { RepositoryDb } from '@holydeck/app/repositories';
import type { RetentionCandidate } from '@holydeck/app/retention';
import type { SchedulerStateStore } from './scheduler-state.js';
import type { Handler } from './runner.js';

export interface RetentionSweepOptions {
  readonly context: unknown;
  readonly db: RepositoryDb;
  /** `settings.values.autosaveRetentionDays` (Task 10-3) — carried in, this handler reads no settings itself. */
  readonly autosaveRetentionDays: number;
  /** `settings.values.auditRetentionDays` (Task 10-3). */
  readonly auditRetentionDays: number;
  readonly notificationStore: NotificationStore;
  readonly notificationReadRetentionDays: number;
  readonly now: () => string;
  readonly report?: (line: string) => void;
  /** Where this job records that it finished (R7): the scheduler only reads this, never writes it. */
  readonly schedulerState: SchedulerStateStore;
}

const MS_PER_DAY = 86_400_000;
const PAGE_LIMIT = 500;
const MAX_PAGES = 50;

const stopped = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error('retention sweep stopped after its lease was lost');
};

/**
 * Every audit row older than `cutoff`, oldest first, paginated in bounded pages so a trail years deep is
 * never read into memory at once. Stops at `MAX_PAGES` and reports if it did — a sweep that ran out of
 * page budget picks up the rest next run rather than blocking the job queue indefinitely.
 */
async function auditEntryCandidates(
  db: RepositoryDb,
  context: unknown,
  cutoff: string,
  nowMs: number,
  report: ((line: string) => void) | undefined,
): Promise<RetentionCandidate[]> {
  const auditEvents = repositoriesOn(db).auditEvents;
  const candidates: RetentionCandidate[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (; pages < MAX_PAGES; pages += 1) {
    const filter = cursor === undefined ? { at: { $lt: cutoff } } : { at: { $gt: cursor, $lt: cutoff } };
    const rows = await auditEvents.read(context, filter, { limit: PAGE_LIMIT, sort: { at: 1 } });
    for (const row of rows) {
      // `_id` already carries the trail's own `audit:` prefix (see audit.ts's `_id: \`audit:${newId()}\``)
      // — never re-add it here, or a candidate's id would read `audit:audit:...`.
      const id = String(row['_id']);
      const at = String(row['at']);
      candidates.push({ id, class: 'audit-entry', ageDays: Math.floor((nowMs - Date.parse(at)) / MS_PER_DAY), protectedBy: [] });
      cursor = at;
    }
    if (rows.length < PAGE_LIMIT) break;
  }
  if (pages >= MAX_PAGES) {
    report?.(`retention sweep: audit-entry gathering hit its ${MAX_PAGES}-page cap — more remains for next run`);
  }
  return candidates;
}

export function retentionSweepOn(options: RetentionSweepOptions): Handler {
  return async (_job, signal) => {
    const overrides = {
      'autosave-revision': options.autosaveRetentionDays,
      'audit-entry': options.auditRetentionDays,
    };
    const nowIso = options.now();
    const nowMs = Date.parse(nowIso);
    const auditPolicy = policyFor('audit-entry', overrides);
    const cutoff = new Date(nowMs - auditPolicy.retentionDays * MS_PER_DAY).toISOString();

    const auditCandidates = await auditEntryCandidates(options.db, options.context, cutoff, nowMs, options.report);
    stopped(signal);
    const auditOutcome = sweep(auditCandidates, overrides);

    options.report?.('retention sweep: autosave-revision sweep deferred — see maintainer TODO');
    const autosaveOutcome = sweep([]);
    const notificationCutoff = new Date(nowMs - options.notificationReadRetentionDays * MS_PER_DAY).toISOString();
    const expiredNotifications = await options.notificationStore.expireRead(notificationCutoff);

    const trail = auditOn(options.db, { now: options.now });
    await trail.record(options.context, {
      action: 'retention.sweep',
      subject:
        `audit-entry: ${auditOutcome.removable.length} removable, ${auditOutcome.retained.length} retained; ` +
        `autosave-revision: ${autosaveOutcome.removable.length} removable, ${autosaveOutcome.retained.length} retained (deferred); ` +
        `notifications: ${expiredNotifications} expired`,
      outcome: 'allowed',
    });

    await options.schedulerState.markRetentionSweep(options.now());
  };
}
