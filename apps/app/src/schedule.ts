import type { Weekday } from './settings.js';

export interface JobRequest {
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
}

export interface SchedulerState {
  readonly lastBackupAt?: string;
  readonly lastRestoreRehearsalAt?: string;
  readonly lastRetentionSweepAt?: string;
}

export interface DueJobsSettings {
  readonly timezone: string;
  readonly backupDailyAt: string;
  readonly backupComponents: readonly string[];
  readonly backupMinimumGapMinutes: number;
  readonly backupRehearsalWeekday: Weekday;
  readonly retentionSweepAt: string;
}

export interface DueJobsInput {
  readonly now: Date;
  readonly settings: DueJobsSettings;
  readonly state: SchedulerState;
  /** True when a content/presentation/settings write was audited since `state.lastBackupAt`. */
  readonly changedSinceLastBackup: boolean;
}

export interface LocalParts {
  readonly date: string;
  readonly minutesOfDay: number;
  readonly weekday: Weekday;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'long',
    });
    FORMATTERS.set(timezone, formatter);
  }
  return formatter;
}

export function localParts(now: Date, timezone: string): LocalParts {
  const parts = formatterFor(timezone).formatToParts(now);
  const of = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${of('year')}-${of('month')}-${of('day')}`,
    minutesOfDay: Number(of('hour')) * 60 + Number(of('minute')),
    weekday: of('weekday').toLowerCase() as Weekday,
  };
}

function minutesOfDay(hhmm: string): number {
  const [hour, minute] = hhmm.split(':').map(Number);
  if (hour === undefined || minute === undefined) return 0;
  return hour * 60 + minute;
}

function isToday(at: string | undefined, timezone: string, today: string): boolean {
  return at !== undefined && localParts(new Date(at), timezone).date === today;
}

/**
 * Every job currently due, computed fresh each call from `now` and `state` alone. A caller may call
 * this once per tick and enqueue everything it returns; the queue's own idempotency key is the final
 * safety net if it is ever called twice for the same instant.
 *
 * DST: this reads local wall-clock parts through `Intl`, never arithmetic on `now`, so a threshold
 * that falls inside a spring-forward gap hour simply never matches that day — the next tick past the
 * gap catches it, at most a few hours late, once, because the guard below is "local date changed
 * since last success," not "time-of-day just crossed the threshold." A fall-back repeated hour
 * cannot cause a second fire within the same calendar date for the same reason.
 */
export function dueJobs(input: DueJobsInput): readonly JobRequest[] {
  const { now, settings, state } = input;
  const today = localParts(now, settings.timezone);
  const jobs: JobRequest[] = [];

  const scheduledKey = `backup-run:${today.date}`;
  // Keyed to the backup this gap is measured from, not the calendar date: unlike the scheduled backup,
  // which is deliberately capped at once a day, a change-triggered one has to be able to fire more than
  // once in a day whenever content keeps changing — sharing the scheduled key would let only the first of
  // those through. Keying off `lastBackupAt` itself is what keeps two schedulers ticking at once from
  // enqueueing two: they read the same state and agree on the same key from it, and the key changes on
  // its own the moment either of them succeeds and moves the baseline forward.
  const changedKey = `backup-run:changed:${state.lastBackupAt ?? 'never'}`;
  const backupAlreadyRanToday = isToday(state.lastBackupAt, settings.timezone, today.date);
  const pastDailyTime = today.minutesOfDay >= minutesOfDay(settings.backupDailyAt);
  const gapElapsed =
    state.lastBackupAt === undefined ||
    now.getTime() - Date.parse(state.lastBackupAt) >= settings.backupMinimumGapMinutes * 60_000;
  const scheduledBackupDue = !backupAlreadyRanToday && pastDailyTime;
  const changeTriggeredBackupDue = input.changedSinceLastBackup && gapElapsed;
  if (scheduledBackupDue) {
    jobs.push({
      kind: 'backup-run',
      idempotencyKey: scheduledKey,
      payload: { components: settings.backupComponents, trigger: 'scheduled' },
    });
  } else if (changeTriggeredBackupDue) {
    jobs.push({
      kind: 'backup-run',
      idempotencyKey: changedKey,
      payload: { components: settings.backupComponents, trigger: 'changed' },
    });
  }

  const rehearsalDue =
    today.weekday === settings.backupRehearsalWeekday &&
    pastDailyTime &&
    backupAlreadyRanToday &&
    !isToday(state.lastRestoreRehearsalAt, settings.timezone, today.date);
  if (rehearsalDue) {
    jobs.push({ kind: 'restore-run', idempotencyKey: `restore-run:${today.date}`, payload: {} });
  }

  const sweepDue =
    today.minutesOfDay >= minutesOfDay(settings.retentionSweepAt) &&
    !isToday(state.lastRetentionSweepAt, settings.timezone, today.date);
  if (sweepDue) {
    jobs.push({ kind: 'retention-sweep', idempotencyKey: `retention-sweep:${today.date}`, payload: {} });
  }

  return jobs;
}
