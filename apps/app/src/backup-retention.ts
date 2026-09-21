// How long backups are kept, and — the part that is easy to get wrong — what a unit of keeping is.
//
// Spec BACK-01 asks for combined keep rules with explicit snapshot grouping and cross-component
// dependency protection, so that what survives a prune is a valid restore set. That rules out the
// obvious implementation. One backup run is spread across several Restic snapshots (the Mongo dump,
// settings, media), and pruning snapshot-by-snapshot against a per-snapshot rule would happily keep two
// of a run's three and forget the third — leaving a manifest that still looks like a backup and is not
// one. So the unit here is the run: a run is kept or forgotten whole, its snapshots follow that decision
// rather than making their own, and a snapshot a kept run still names is never forgotten even when the
// run that also names it is going. Nothing about the rules is Restic's `forget --keep-daily`: that policy
// would be applied per snapshot, which is exactly the grouping this exists to avoid.

import type { RecordedBackup } from './backups.js';

/**
 * Counted in periods that have a run, not in calendar periods: `daily: 7` keeps the newest run of each of
 * the seven most recent days that have one, rather than of the last seven days on the wall. The two agree
 * for a deployment that backs up nightly and differ for one that has just started or has been off for a
 * week — and where they differ, this reading is the one that does not quietly prune a sparse history down
 * to nothing. It is also what every backup tool's keep-rules mean, so nobody has to learn a second sense.
 */
export interface RetentionPolicy {
  readonly daily: number;
  readonly weekly: number;
  readonly monthly: number;
}

export const RETENTION: RetentionPolicy = Object.freeze({ daily: 7, weekly: 4, monthly: 12 });

export interface RetentionDecision {
  readonly keep: readonly RecordedBackup[];
  readonly forget: readonly RecordedBackup[];
  /** Snapshots no kept run still depends on — the only ones it is safe to prune from the repository. */
  readonly snapshotsToForget: readonly string[];
}

const DAY_MS = 86_400_000;

const dayKey = (at: string): string => new Date(Date.parse(at)).toISOString().slice(0, 10);

const monthKey = (at: string): string => new Date(Date.parse(at)).toISOString().slice(0, 7);

/**
 * The ISO week, in UTC. A Sunday and the Monday after it are different weeks however few hours apart they
 * are, which is the whole reason a weekly rule is not "one run every seventh day".
 */
const weekKey = (at: string): string => {
  const date = new Date(Date.parse(at));
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  // The Thursday of this week decides which year the week belongs to, which is what makes the turn of a
  // year a week boundary rather than an off-by-one.
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - mondayOffset + 3);
  const year = new Date(thursday).getUTCFullYear();
  const firstThursday = Date.UTC(year, 0, 4);
  const firstMonday = firstThursday - ((new Date(firstThursday).getUTCDay() + 6) % 7) * DAY_MS;
  const week = Math.floor((thursday - firstMonday) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
};

/** The newest run of each of the most recent `allowance` periods, given runs already in newest-first order. */
const claimedBy = (
  runs: readonly RecordedBackup[],
  period: (at: string) => string,
  allowance: number,
): ReadonlySet<string> => {
  const claimed = new Set<string>();
  const periods = new Set<string>();
  for (const run of runs) {
    if (periods.size >= allowance) break;
    const key = period(run.at);
    if (periods.has(key)) continue;
    periods.add(key);
    claimed.add(run.backupId);
  }
  return claimed;
};

/**
 * Splits recorded runs into the ones a rule still claims and the ones nothing does, and names the
 * snapshots that are then genuinely unreferenced. Pure: deciding what to forget and forgetting it are
 * separate, so the decision can be asserted without a repository and carried out without a policy.
 */
export function retentionFor(
  runs: readonly RecordedBackup[],
  policy: RetentionPolicy = RETENTION,
): RetentionDecision {
  const ordered = [...runs].sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  const claimed = new Set<string>([
    ...claimedBy(ordered, dayKey, policy.daily),
    ...claimedBy(ordered, weekKey, policy.weekly),
    ...claimedBy(ordered, monthKey, policy.monthly),
  ]);

  const keep = ordered.filter((run) => claimed.has(run.backupId));
  const forget = ordered.filter((run) => !claimed.has(run.backupId));

  // Cross-component dependency protection: a snapshot two runs share survives the older run going, so a
  // prune can never take a component the surviving run's restore set still points at.
  const needed = new Set(keep.flatMap((run) => run.snapshots));
  const snapshotsToForget = [...new Set(forget.flatMap((run) => run.snapshots))].filter(
    (snapshot) => !needed.has(snapshot),
  );

  return { keep, forget, snapshotsToForget };
}
