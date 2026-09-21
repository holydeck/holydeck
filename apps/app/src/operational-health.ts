// OPER-01: the one Administration page an operator opens when something feels wrong, and what it is
// allowed to say. Seven domains are already measured somewhere else in this product — the worker's
// heartbeat, OFFL-01's storage admission, the T22 queue, the recorded backups, the recorded restore
// rehearsals, the media manifest, and OFFL-03's presentation rehearsal — and every one of them already
// knows whether it is healthy. What none of them can answer is the question the person in front of the
// screen actually has: *what do I do about it*. That answer is this module's, and it is the only thing
// here that is new.
//
// Three rules shape the whole file.
//
// *Every status states an action.* A finding with no action is a colour, and a colour is what an operator
// ignores for three weeks and then discovers on a Sunday. Even a healthy domain says what to do — leave
// it as it is, and here are the numbers that say so — because "nothing to do" is a decision somebody made
// from measurements rather than an absence of information. `OPERATIONAL_CODES` lists every code that can
// be reported, and the test iterates it, so a code added without a recommendation fails a build.
//
// *A fact is a number.* Not one string this module is handed is ever copied into what it produces. A job
// carries its payload and the error the last attempt failed with; a heartbeat carries the paths the worker
// mounted; a manifest carries a Restic repository address; a rehearsal blocker carries a document
// identifier that a deployment is free to make a URL. Every one of those is a private infrastructure
// detail or a place a secret has been found before, so `facts` is typed as numbers and the recommendations
// are composed from those numbers and this module's own words. Redaction by construction rather than by a
// filter that has to keep up: there is nothing here to filter, because nothing is carried across.
//
// *A recommendation is derived.* The numbers are in the sentence, and the sentence changes when they
// change — how much room to free is the measured shortfall, how overdue a backup is is its measured age.
// Two recommendations are derived from more than their own domain: a queue whose jobs are not being
// claimed and a media backlog that is not shrinking mean "start the worker" when the worker is silent and
// something quite different when it is alive and merely busy. That cross-reading is the only place one
// domain's judgement is allowed to reach into another's.
//
// What this module does *not* do is re-grade. OFFL-01's blocker codes, OFFL-03's blocker codes and the
// queue's job states are carried through as counts under their own names and never re-derived — the same
// discipline `preparation-rehearsal.ts` keeps with the renderer's readiness findings. The grouping below
// (four recommendations over OFFL-03's nine blockers) is about how many distinct *repairs* exist, not
// about disagreeing with what the rehearsal found; every original code is still in `facts`.

import { RESTORE_CLASSES } from '@holydeck/contracts/backups';

import { LEASE_LOST } from './queue.js';
import { RECOVERY_OBJECTIVES } from './restores.js';

import type { BackupObjectives } from '@holydeck/contracts/backups';
import type { JobRecord, JobState } from '@holydeck/contracts/jobs';
import type { MediaManifestEntry, MediaProcessingState } from '@holydeck/contracts/media';

import type { RecordedBackup } from './backups.js';

/** The seven statuses OPER-01 names, in the order the surface reports them. */
export const OPERATIONAL_DOMAINS = ['health', 'storage', 'queue', 'backup', 'restore', 'media', 'readiness'] as const;

export type OperationalDomain = (typeof OPERATIONAL_DOMAINS)[number];

/**
 * How a domain stands. `unknown` is deliberately not `ok`: a check that could not be read has told us
 * nothing, and reporting silence as health is the one mistake an operations page must never make — the
 * same distinction `heartbeatProblem` draws between an unhealthy worker and an unreadable clock.
 */
export type OperationalState = 'ok' | 'degraded' | 'unknown' | 'failed';

// Worse than degraded on purpose: something degraded is understood and survivable, something unreadable
// might be either, and an operator should look at the one they cannot see before the one they can.
const STATE_RANK: Readonly<Record<OperationalState, number>> = Object.freeze({ ok: 0, degraded: 1, unknown: 2, failed: 3 });

/** Every finding the surface can report. One code is one repair. */
export const OPERATIONAL_CODES = [
  'health.ok',
  'health.workerSilent',
  'health.workerStale',
  'health.clockSkew',
  'health.unreadable',

  'storage.ok',
  'storage.unreported',
  'storage.unreadable',
  'storage.estimateUnavailable',
  'storage.quotaShortfall',
  'storage.assetSizeUnknown',
  'storage.evictable',
  'storage.persistenceUnsupported',

  'queue.ok',
  'queue.unreadable',
  'queue.failed',
  'queue.leasesLost',
  'queue.stalled',
  'queue.attemptsRunningOut',

  'backup.ok',
  'backup.unreadable',
  'backup.none',
  'backup.overdue',
  'backup.incomplete',

  'restore.ok',
  'restore.unreadable',
  'restore.neverRehearsed',
  'restore.rehearsalOverdue',
  'restore.recoveryTimeAtRisk',
  'restore.recoveryTimeMissed',

  'media.ok',
  'media.unreadable',
  'media.failed',
  'media.backlog',

  'readiness.ok',
  'readiness.unreported',
  'readiness.unreadable',
  'readiness.cacheIncomplete',
  'readiness.snapshotUnusable',
  'readiness.environmentDiverged',
  'readiness.slidesBlocked',
] as const;

export type OperationalCode = (typeof OPERATIONAL_CODES)[number];

/**
 * One thing that is true about a domain, the numbers it was judged from, and what to do about it.
 *
 * `facts` is `number` and not `unknown` for the reason in this module's header: it is what makes leaking a
 * connection string, a mount path or a token into an operator screen a compile error rather than a review
 * finding. Nothing here is localized — the code and the numbers are the durable part, and a surface that
 * shows one in another language owns the wording, exactly as `stage-state.ts` and `preparation-storage.ts`
 * keep that separation. `action` is the English fallback that page starts from, and is never empty.
 */
export interface OperationalFinding {
  readonly code: OperationalCode;
  readonly state: OperationalState;
  readonly facts: Readonly<Record<string, number>>;
  readonly action: string;
}

/** What one domain came to: its worst finding's state and action, over everything found in it. */
export interface OperationalStatus {
  readonly domain: OperationalDomain;
  readonly state: OperationalState;
  readonly action: string;
  readonly findings: readonly OperationalFinding[];
}

export interface OperationalHealthReport {
  /** The instant the readings were taken, as the caller's clock wrote it. */
  readonly at: string;
  readonly state: OperationalState;
  readonly action: string;
  readonly statuses: readonly OperationalStatus[];
}

/** A domain whose source was reached for and refused to answer. See `OperationalState`. */
export const UNREADABLE = 'unreadable';

/** A reading, or the fact that taking it failed. No source's own type is the string `unreadable`. */
export type Observed<T> = T | typeof UNREADABLE;

/**
 * What the worker's heartbeat file holds, plus the bound the worker's own health check judges it against.
 *
 * The bound travels with the reading rather than being a constant here, because `apps/worker` owns it
 * (`HEARTBEAT_STALE_MS`) and `apps/app` does not depend on the worker — copying the number into this file
 * would make two bounds that drift. `pid` and `paths` are declared because the file really does carry
 * them; neither is ever surfaced.
 */
export interface WorkerHeartbeatReading {
  readonly at?: string;
  readonly pid?: number;
  readonly paths?: readonly string[];
  readonly staleAfterMs: number;
}

/**
 * OFFL-01's answer, as a browser reported it. Re-declared rather than imported: `apps/web` is a browser
 * bundle with no export map and nothing server-side depends on it, so this is the shape a presenting
 * machine posts. It is written to be exactly `PreparationPreflight`, so a real one assigns to it and a
 * change there fails here instead of quietly meaning something else.
 */
export type StorageReading =
  | {
      readonly kind: 'admitted';
      readonly estimatedBytes: number;
      readonly requiredBytes: number;
      readonly availableBytes: number;
      readonly persistence: 'granted' | 'refused' | 'unsupported';
      readonly skippedAssetIds: readonly string[];
    }
  | { readonly kind: 'blocked'; readonly blockers: readonly StorageBlockerReading[] };

/** T95's three blocker codes and what each carries. `assetId` is read and deliberately never surfaced. */
export type StorageBlockerReading =
  | { readonly code: 'storage.estimateUnavailable' }
  | {
      readonly code: 'storage.quotaShortfall';
      readonly requiredBytes: number;
      readonly availableBytes: number;
      readonly shortfallBytes: number;
    }
  | { readonly code: 'asset.sizeUnknown'; readonly assetId: string };

/** OFFL-03's nine blocker codes, carried through under their own names. */
export type RehearsalBlockerReadingCode =
  | 'cache.incomplete'
  | 'snapshot.noDocuments'
  | 'document.frameHashUnknown'
  | 'document.notCached'
  | 'document.unreadable'
  | 'render.failed'
  | 'render.unverifiable'
  | 'render.diverged'
  | 'render.blocked';

/**
 * One rehearsal blocker as a browser reported it. Everything but the code is optional and unread: a
 * document identifier, a digest and a renderer's error name are what the presenting machine knows, and
 * none of them is this surface's to repeat.
 */
export interface RehearsalBlockerReading {
  readonly code: RehearsalBlockerReadingCode;
  readonly documentId?: string;
  readonly pendingAssetIds?: readonly string[];
  readonly reason?: string;
  readonly recordedFrameHash?: string;
  readonly renderedFrameHash?: string;
  readonly findings?: readonly unknown[];
}

/** OFFL-03's report, as a browser reported it — written to accept a real `RehearsalReport`. */
export interface ReadinessReading {
  readonly kind: 'rehearsed' | 'blocked';
  readonly rehearsedSlideIds: readonly string[];
  readonly blockers: readonly RehearsalBlockerReading[];
}

/**
 * What the queue can say about itself: the whole-collection counts `Queue.summary` answers with, and a
 * page of recent jobs from `Queue.list`. The counts are authoritative and the page is a sample — which is
 * why a finding drawn from the page says how many jobs it looked at.
 *
 * `oldestQueuedAt` is the one thing the page cannot answer and the stall check most needs. `Queue.list`
 * sorts newest-first over a page of at most 500, so the moment more than one page of jobs is queued the
 * oldest waiting job — precisely the one a stall is made of — falls off the end of the sample, and a
 * surface built only on the page would report a growing backlog as a healthy queue. Whoever wires this up
 * must fill it from a dedicated ascending query for the oldest `queued` row (`sort: { queuedAt: 1 }`,
 * limit 1) and never from `Queue.list`'s page. It is optional because a caller that cannot answer it
 * should say so by leaving it out rather than by passing the page's best guess: every sentence below
 * then names the sample it was drawn from instead of making a claim about the whole queue.
 */
export interface QueueReading {
  readonly counts: Readonly<Record<JobState, number>>;
  readonly jobs: readonly JobRecord[];
  readonly oldestQueuedAt?: string;
}

/** One recorded restore rehearsal, as the `restores` record class holds it (BACK-02). */
export interface RecordedRehearsal {
  readonly at: string;
  readonly objectives: BackupObjectives;
}

/**
 * Everything the surface was able to measure. The five server-side domains are always attempted, so their
 * only two answers are a reading or `UNREADABLE`; the two a browser owns may also be absent, because no
 * presenting machine has reported yet — which is a different thing to say and a different thing to do.
 */
export interface OperationalReadings {
  readonly at: string;
  readonly health: Observed<WorkerHeartbeatReading>;
  readonly queue: Observed<QueueReading>;
  readonly backup: Observed<readonly RecordedBackup[]>;
  readonly restore: Observed<readonly RecordedRehearsal[]>;
  readonly media: Observed<readonly MediaManifestEntry[]>;
  readonly storage?: Observed<StorageReading>;
  readonly readiness?: Observed<ReadinessReading>;
}

/**
 * How long a job may sit unclaimed before the queue is worth an operator's attention. This module's own
 * figure and provisional, in the same sense as `ESTIMATE_TOLERANCE_RATIO`: the work v1 queues is media
 * ingest, poster generation and backups, and none of those is minutes of waiting away from being wrong —
 * but nothing has measured a real congregation's Saturday evening yet.
 */
export const QUEUE_WAIT_WARNING_MINUTES = 10;

/**
 * How long a deployment may go without rehearsing a restore. Weekly, because that is the cadence
 * `restores.ts` designed for — its isolation decision turns on a rehearsal being cheap enough to run every
 * week — and a backup nobody has restored in a month is a backup nobody knows is worth anything.
 */
export const REHEARSAL_INTERVAL_MINUTES = 7 * 24 * 60;

/**
 * How close a measured recovery time may come to its objective before it is worth saying out loud. A
 * rehearsal past its objective is refused outright by `rehearseRestore`, so the only warning an operator
 * can act on is the one that comes before that happens.
 */
export const RECOVERY_TIME_WARNING_RATIO = 0.75;

const MINUTE_MS = 60_000;
const MEGABYTE = 1_000_000;

const msSince = (at: string, then: string): number | undefined => {
  const ms = Date.parse(at) - Date.parse(then);
  return Number.isNaN(ms) ? undefined : ms;
};

/** Whole minutes, never negative: a record dated in the future is new, not aged backwards. */
const minutesSince = (at: string, then: string): number | undefined => {
  const ms = msSince(at, then);
  return ms === undefined ? undefined : Math.max(0, Math.floor(ms / MINUTE_MS));
};

const seconds = (ms: number): number => Math.round(ms / 1000);

/** Rounded down, so free room is never overstated. */
const megabytesFree = (bytes: number): number => Math.floor(bytes / MEGABYTE);

/** Rounded up, so what somebody is asked to clear is never understated. */
const megabytesNeeded = (bytes: number): number => Math.ceil(bytes / MEGABYTE);

const finding = (
  code: OperationalCode,
  state: OperationalState,
  facts: Record<string, number>,
  action: string,
): OperationalFinding => Object.freeze({ code, state, facts: Object.freeze(facts), action });

/** Every domain's answer when its source refused to answer: the same shape, the same one repair. */
const unreadable = (domain: OperationalDomain, code: OperationalCode): OperationalFinding =>
  finding(
    code,
    'unknown',
    {},
    `Check the application log and reload: this surface could not read ${domain} at all, so nothing below it is a statement about ${domain}.`,
  );

const newestOf = <T>(rows: readonly T[], timeOf: (row: T) => string): T | undefined => {
  let newest: T | undefined;
  for (const row of rows) {
    if (newest === undefined || Date.parse(timeOf(row)) > Date.parse(timeOf(newest))) newest = row;
  }
  return newest;
};

// ---------------------------------------------------------------------------------------------------
// Health: whether the machinery that runs everything else is alive at all.

/**
 * Whether the worker is known to have stopped — which is a narrower thing than "the health domain is not
 * ok". A skewed clock and an unreadable heartbeat file are both reasons to doubt the health reading, and
 * neither is a reason to tell somebody to start a worker that may well already be running. Only silence
 * and staleness say nothing is claiming work.
 */
const workerStopped = (findings: readonly OperationalFinding[]): boolean =>
  findings.some((one) => one.code === 'health.workerSilent' || one.code === 'health.workerStale');

const healthFindings = (reading: Observed<WorkerHeartbeatReading>, at: string): readonly OperationalFinding[] => {
  if (reading === UNREADABLE) return [unreadable('health', 'health.unreadable')];
  const bound = seconds(reading.staleAfterMs);
  if (reading.at === undefined) {
    return [
      finding(
        'health.workerSilent',
        'failed',
        { staleAfterSeconds: bound },
        'Start the worker: it has never written a heartbeat, so nothing is running media, posters or backups.',
      ),
    ];
  }
  const ms = msSince(at, reading.at);
  if (ms === undefined) return [unreadable('health', 'health.unreadable')];
  if (ms > reading.staleAfterMs) {
    return [
      finding(
        'health.workerStale',
        'failed',
        { ageSeconds: seconds(ms), staleAfterSeconds: bound },
        `Restart the worker: its last heartbeat is ${seconds(ms)}s old and a healthy one is at most ${bound}s old.`,
      ),
    ];
  }
  if (ms < -reading.staleAfterMs) {
    return [
      finding(
        'health.clockSkew',
        'degraded',
        { aheadSeconds: seconds(-ms), staleAfterSeconds: bound },
        `Put the worker and this machine on the same clock: its last heartbeat is dated ${seconds(-ms)}s ahead of this one, so every age on this page is a guess.`,
      ),
    ];
  }
  return [
    finding(
      'health.ok',
      'ok',
      { ageSeconds: Math.max(0, seconds(ms)), staleAfterSeconds: bound },
      `Leave the worker as it is: its last heartbeat is ${Math.max(0, seconds(ms))}s old, inside the ${bound}s bound.`,
    ),
  ];
};

// ---------------------------------------------------------------------------------------------------
// Storage: whether the presenting machine can hold the service it is about to present.

const storageFindings = (reading: Observed<StorageReading> | undefined): readonly OperationalFinding[] => {
  if (reading === undefined) {
    return [
      finding(
        'storage.unreported',
        'unknown',
        {},
        'Open the preparation screen on the presenting machine once: no browser has reported what room it has, so no offline service can be promised.',
      ),
    ];
  }
  if (reading === UNREADABLE) return [unreadable('storage', 'storage.unreadable')];

  if (reading.kind === 'admitted') {
    const free = megabytesFree(reading.availableBytes);
    if (reading.persistence === 'refused') {
      return [
        finding(
          'storage.evictable',
          'degraded',
          { availableMegabytes: free },
          `Allow persistent storage on the presenting machine, or re-cache on the day: ${free} MB is free but this browser refused to keep the cache.`,
        ),
      ];
    }
    if (reading.persistence === 'unsupported') {
      return [
        finding(
          'storage.persistenceUnsupported',
          'degraded',
          { estimatedMegabytes: megabytesNeeded(reading.estimatedBytes) },
          `Plan to re-cache on the day, or present from a browser that can keep storage: this one cannot be asked, so the ${megabytesNeeded(reading.estimatedBytes)} MB cached may be evicted.`,
        ),
      ];
    }
    return [
      finding(
        'storage.ok',
        'ok',
        { availableMegabytes: free, requiredMegabytes: megabytesNeeded(reading.requiredBytes) },
        `Leave the presenting machine as it is: ${free} MB free covers the ${megabytesNeeded(reading.requiredBytes)} MB this service needs, and the browser will keep it.`,
      ),
    ];
  }

  const found: OperationalFinding[] = [];
  let sizeUnknown = 0;
  let unrecognized = 0;
  for (const blocker of reading.blockers) {
    switch (blocker.code) {
      case 'storage.quotaShortfall': {
        const clear = megabytesNeeded(blocker.shortfallBytes);
        found.push(
          finding(
            'storage.quotaShortfall',
            'failed',
            {
              shortfallMegabytes: clear,
              requiredMegabytes: megabytesNeeded(blocker.requiredBytes),
              availableMegabytes: megabytesFree(blocker.availableBytes),
            },
            `Free at least ${clear} MB on the presenting machine: caching this service needs ${megabytesNeeded(blocker.requiredBytes)} MB and ${megabytesFree(blocker.availableBytes)} MB is free.`,
          ),
        );
        break;
      }
      case 'storage.estimateUnavailable':
        found.push(
          finding(
            'storage.estimateUnavailable',
            'failed',
            {},
            'Present from a browser that reports its storage: this one measured neither its quota nor its usage, so there is no admission decision to make.',
          ),
        );
        break;
      case 'asset.sizeUnknown':
        sizeUnknown += 1;
        break;
      default:
        unrecognized += 1;
    }
  }
  if (sizeUnknown > 0) {
    found.push(
      finding(
        'storage.assetSizeUnknown',
        'failed',
        { assetCount: sizeUnknown },
        `Re-pin the service: ${sizeUnknown} mandatory asset(s) have no recorded size, so no room can be reserved for them.`,
      ),
    );
  }
  // A blocked preflight this build cannot explain is reported as unread rather than quietly passing:
  // "blocked, for a reason newer than this page" must never come out the same colour as "ready".
  if (unrecognized > 0 || found.length === 0) found.push(unreadable('storage', 'storage.unreadable'));
  return found;
};

// ---------------------------------------------------------------------------------------------------
// Queue: whether the work that has been asked for is actually being done.

const queueFindings = (reading: Observed<QueueReading>, at: string, running: boolean): readonly OperationalFinding[] => {
  if (reading === UNREADABLE) return [unreadable('queue', 'queue.unreadable')];
  const { counts, jobs } = reading;
  const found: OperationalFinding[] = [];

  if (counts.failed > 0) {
    found.push(
      finding(
        'queue.failed',
        'failed',
        { failedCount: counts.failed },
        `Requeue or retire ${counts.failed} failed job(s) from the jobs page: a job that used up its attempts never retries on its own.`,
      ),
    );
  }

  const leasesLost = jobs.filter((one) => one.lastError === LEASE_LOST).length;
  if (leasesLost > 0) {
    found.push(
      finding(
        'queue.leasesLost',
        'degraded',
        { leasesLostCount: leasesLost, sampledCount: jobs.length },
        `Find out why the worker stops mid-job: ${leasesLost} of the ${jobs.length} most recent job(s) lost their lease instead of finishing.`,
      ),
    );
  }

  // The longest wait, and whether that number is the whole queue's or only this page's. A dedicated
  // oldest-queued answer settles it outright; failing that, the page settles it only when the page holds
  // every queued job there is. Anything else and the real oldest is off-page, so each sentence below says
  // what it actually looked at rather than claiming the queue is fine because the visible part of it is.
  const waiting = jobs.filter((one) => one.state === 'queued');
  const sampled = waiting.reduce<number | undefined>((longest, one) => {
    const age = minutesSince(at, one.queuedAt);
    if (age === undefined) return longest;
    return longest === undefined || age > longest ? age : longest;
  }, undefined);
  const whole = reading.oldestQueuedAt === undefined ? undefined : minutesSince(at, reading.oldestQueuedAt);
  const waited = whole ?? sampled;
  const complete = whole !== undefined || waiting.length === counts.queued;
  const sample: Record<string, number> = complete ? {} : { sampledCount: jobs.length };

  if (waited !== undefined && waited > QUEUE_WAIT_WARNING_MINUTES) {
    const oldest = complete
      ? `the oldest has waited ${waited} minutes`
      : `one of the ${jobs.length} most recent has waited ${waited} minutes`;
    found.push(
      running
        ? finding(
            'queue.stalled',
            'degraded',
            { waitMinutes: waited, queuedCount: counts.queued, ...sample },
            `Check the worker runs the kinds of job that are waiting: ${counts.queued} job(s) are queued and ${oldest} with a worker alive.`,
          )
        : finding(
            'queue.stalled',
            'failed',
            { waitMinutes: waited, queuedCount: counts.queued, ...sample },
            `Start the worker: ${counts.queued} job(s) are queued, ${oldest}, and nothing is claiming them.`,
          ),
    );
  }

  const lastChance = jobs.filter(
    (one) => (one.state === 'queued' || one.state === 'leased') && one.attempt >= one.retryLimit,
  );
  if (lastChance.length > 0) {
    const limit = lastChance.reduce((most, one) => Math.max(most, one.retryLimit), 0);
    found.push(
      finding(
        'queue.attemptsRunningOut',
        'degraded',
        { jobCount: lastChance.length, retryLimit: limit, sampledCount: jobs.length },
        `Fix what these jobs keep failing on before the next attempt: ${lastChance.length} of the ${jobs.length} most recent job(s) are on their last of ${limit} attempts, and the next failure retires them.`,
      ),
    );
  }

  if (found.length > 0) return found;
  return [
    finding(
      'queue.ok',
      'ok',
      { queuedCount: counts.queued, leasedCount: counts.leased, succeededCount: counts.succeeded, ...sample },
      complete
        ? `Leave the queue as it is: ${counts.queued} waiting and ${counts.leased} running, none failed and none waiting longer than ${QUEUE_WAIT_WARNING_MINUTES} minutes.`
        : `Look at the jobs page before trusting this: ${counts.queued} waiting and ${counts.leased} running, none failed, and none of the ${jobs.length} most recent job(s) has waited longer than ${QUEUE_WAIT_WARNING_MINUTES} minutes — but the queue is longer than that page, so the oldest waiting job was not measured.`,
    ),
  ];
};

// ---------------------------------------------------------------------------------------------------
// Backup: whether there is anything recent to recover from.

const backupFindings = (reading: Observed<readonly RecordedBackup[]>, at: string): readonly OperationalFinding[] => {
  if (reading === UNREADABLE) return [unreadable('backup', 'backup.unreadable')];
  if (reading.length === 0) {
    return [
      finding(
        'backup.none',
        'failed',
        {},
        'Run a backup now: this deployment has never recorded one, so there is nothing at all to recover from.',
      ),
    ];
  }
  const newest = newestOf(reading, (row) => row.production.manifest.createdAt);
  const age = newest === undefined ? undefined : minutesSince(at, newest.production.manifest.createdAt);
  if (newest === undefined || age === undefined) return [unreadable('backup', 'backup.unreadable')];

  const found: OperationalFinding[] = [];
  const objective = RECOVERY_OBJECTIVES.rpoMinutes;
  if (age > objective) {
    found.push(
      finding(
        'backup.overdue',
        'failed',
        { ageMinutes: age, objectiveMinutes: objective },
        `Run a backup now: the newest is ${age} minutes old against the ${objective}-minute recovery point this deployment records against.`,
      ),
    );
  }
  const inventoried = RESTORE_CLASSES.filter((name) =>
    newest.production.manifest.contents.some((content) => content.class === name),
  ).length;
  if (inventoried < RESTORE_CLASSES.length) {
    found.push(
      finding(
        'backup.incomplete',
        'degraded',
        { inventoriedCount: inventoried, expectedCount: RESTORE_CLASSES.length },
        `Check the backup job's mounts and repository: the newest run inventoried ${inventoried} of the ${RESTORE_CLASSES.length} classes a restore puts back, so a recovery from it would be partial.`,
      ),
    );
  }
  if (found.length > 0) return found;
  return [
    finding(
      'backup.ok',
      'ok',
      { ageMinutes: age, runCount: reading.length, objectiveMinutes: objective },
      `Leave the backup schedule as it is: the newest of ${reading.length} recorded run(s) is ${age} minutes old, inside the ${objective}-minute recovery point.`,
    ),
  ];
};

// ---------------------------------------------------------------------------------------------------
// Restore: whether any of those backups is known to be worth anything.

const restoreFindings = (reading: Observed<readonly RecordedRehearsal[]>, at: string): readonly OperationalFinding[] => {
  if (reading === UNREADABLE) return [unreadable('restore', 'restore.unreadable')];
  if (reading.length === 0) {
    return [
      finding(
        'restore.neverRehearsed',
        'failed',
        {},
        'Rehearse a restore: no backup has ever been restored here, so none of them is known to restore at all.',
      ),
    ];
  }
  const newest = newestOf(reading, (row) => row.at);
  const age = newest === undefined ? undefined : minutesSince(at, newest.at);
  if (newest === undefined || age === undefined) return [unreadable('restore', 'restore.unreadable')];

  const found: OperationalFinding[] = [];
  if (age > REHEARSAL_INTERVAL_MINUTES) {
    found.push(
      finding(
        'restore.rehearsalOverdue',
        'degraded',
        { ageMinutes: age, intervalMinutes: REHEARSAL_INTERVAL_MINUTES },
        `Rehearse a restore: the last one was ${age} minutes ago against a ${REHEARSAL_INTERVAL_MINUTES}-minute cadence, and the backups taken since are unproven.`,
      ),
    );
  }
  const measured = newest.objectives.measured.rtoMinutes;
  const objective = newest.objectives.rtoMinutes;
  if (measured > objective) {
    found.push(
      finding(
        'restore.recoveryTimeMissed',
        'failed',
        { measuredMinutes: measured, objectiveMinutes: objective },
        `Shorten the restore before it is needed: the last rehearsal took ${measured} minutes against a ${objective}-minute recovery time objective.`,
      ),
    );
  } else if (measured >= objective * RECOVERY_TIME_WARNING_RATIO) {
    found.push(
      finding(
        'restore.recoveryTimeAtRisk',
        'degraded',
        { measuredMinutes: measured, objectiveMinutes: objective },
        `Watch the restore time: the last rehearsal used ${measured} of the ${objective} minutes a recovery is allowed, so a slower day misses it.`,
      ),
    );
  }
  if (found.length > 0) return found;
  return [
    finding(
      'restore.ok',
      'ok',
      { ageMinutes: age, measuredMinutes: measured, objectiveMinutes: objective },
      `Leave the rehearsal cadence as it is: the last restore was ${age} minutes ago and took ${measured} of the ${objective} minutes allowed.`,
    ),
  ];
};

// ---------------------------------------------------------------------------------------------------
// Media: whether what was uploaded is usable in a service.

const mediaFindings = (
  reading: Observed<readonly MediaManifestEntry[]>,
  running: boolean,
): readonly OperationalFinding[] => {
  if (reading === UNREADABLE) return [unreadable('media', 'media.unreadable')];
  const counted = (state: MediaProcessingState): number =>
    reading.filter((entry) => entry.processingState === state).length;
  const ready = counted('ready');
  const failed = counted('failed');
  const pending = counted('pending');
  const processing = counted('processing');
  const found: OperationalFinding[] = [];

  if (failed > 0) {
    found.push(
      finding(
        'media.failed',
        'failed',
        { failedCount: failed, readyCount: ready },
        `Re-upload or requeue ${failed} media item(s) whose processing failed: they cannot be shown, and ${ready} other item(s) are ready.`,
      ),
    );
  }

  const waiting = pending + processing;
  if (waiting > 0) {
    found.push(
      running
        ? finding(
            'media.backlog',
            'degraded',
            { waitingCount: waiting, pendingCount: pending, processingCount: processing },
            `Wait for the worker before pinning a service that uses them: ${waiting} media item(s) are still being processed, ${processing} of them under way.`,
          )
        : finding(
            'media.backlog',
            'failed',
            { waitingCount: waiting, pendingCount: pending, processingCount: processing },
            `Start the worker: ${waiting} media item(s) are waiting to be processed and nothing is processing them.`,
          ),
    );
  }

  if (found.length > 0) return found;
  return [
    finding(
      'media.ok',
      'ok',
      { readyCount: ready },
      `Leave media as it is: all ${ready} item(s) are processed and usable in a service.`,
    ),
  ];
};

// ---------------------------------------------------------------------------------------------------
// Presentation readiness: whether the prepared service will actually draw on the day.

/**
 * OFFL-03's nine blockers, grouped by the repair they ask for rather than re-graded. The counts under
 * their original codes travel in `facts`, so nothing the rehearsal said is lost by the grouping.
 */
const READINESS_REPAIRS = Object.freeze({
  'cache.incomplete': 'readiness.cacheIncomplete',
  'document.notCached': 'readiness.cacheIncomplete',
  'snapshot.noDocuments': 'readiness.snapshotUnusable',
  'document.frameHashUnknown': 'readiness.snapshotUnusable',
  'document.unreadable': 'readiness.snapshotUnusable',
  'render.failed': 'readiness.snapshotUnusable',
  'render.diverged': 'readiness.environmentDiverged',
  'render.unverifiable': 'readiness.environmentDiverged',
  'render.blocked': 'readiness.slidesBlocked',
} as const satisfies Readonly<Record<RehearsalBlockerReadingCode, OperationalCode>>);

const readinessAction = (code: OperationalCode, count: number, assets: number, documents: number): string => {
  switch (code) {
    case 'readiness.cacheIncomplete':
      return `Finish caching on the presenting machine before taking it offline: ${assets} asset(s) and ${documents} document(s) the snapshot pinned are not cached there.`;
    case 'readiness.environmentDiverged':
      return `Match the presenting browser and its fonts to the machine the snapshot was pinned from: ${count} document(s) did not render here the way they were recorded.`;
    case 'readiness.slidesBlocked':
      return `Fix the ${count} slide(s) the renderer refuses: they are as blocked online as they are offline, so this is a layout to repair rather than a cache.`;
    default:
      return `Re-pin the service: ${count} part(s) of the snapshot cannot be rehearsed at all, so nothing proves it will draw on the day.`;
  }
};

const readinessFindings = (reading: Observed<ReadinessReading> | undefined): readonly OperationalFinding[] => {
  if (reading === undefined) {
    return [
      finding(
        'readiness.unreported',
        'unknown',
        {},
        'Rehearse the service on the presenting machine: no rehearsal has been reported, and an unrehearsed snapshot may not be presented offline.',
      ),
    ];
  }
  if (reading === UNREADABLE) return [unreadable('readiness', 'readiness.unreadable')];

  const counts = new Map<OperationalCode, { count: number; assets: number; facts: Record<string, number> }>();
  let unrecognized = 0;
  for (const blocker of reading.blockers) {
    const code: OperationalCode | undefined = READINESS_REPAIRS[blocker.code];
    if (code === undefined) {
      unrecognized += 1;
      continue;
    }
    const group = counts.get(code) ?? { count: 0, assets: 0, facts: {} };
    group.count += 1;
    group.assets += blocker.pendingAssetIds?.length ?? 0;
    group.facts[blocker.code] = (group.facts[blocker.code] ?? 0) + 1;
    counts.set(code, group);
  }

  const found: OperationalFinding[] = [];
  for (const [code, group] of counts) {
    found.push(
      finding(
        code,
        'failed',
        { ...group.facts, blockerCount: group.count, assetCount: group.assets },
        readinessAction(code, group.count, group.assets, group.facts['document.notCached'] ?? 0),
      ),
    );
  }
  // The same reasoning as a blocked preflight this build cannot explain: a rehearsal that refused for a
  // reason newer than this page is unread, never rehearsed.
  if (unrecognized > 0 || (reading.kind === 'blocked' && found.length === 0)) {
    found.push(unreadable('readiness', 'readiness.unreadable'));
  }
  if (found.length > 0) return found;
  return [
    finding(
      'readiness.ok',
      'ok',
      { slideCount: reading.rehearsedSlideIds.length },
      `Leave the prepared service as it is: all ${reading.rehearsedSlideIds.length} slide(s) rehearsed on the presenting machine and matched what was pinned.`,
    ),
  ];
};

// ---------------------------------------------------------------------------------------------------

const worstOf = (findings: readonly OperationalFinding[]): OperationalFinding =>
  findings.reduce((worst, candidate) => (STATE_RANK[candidate.state] > STATE_RANK[worst.state] ? candidate : worst));

const statusOf = (domain: OperationalDomain, findings: readonly OperationalFinding[]): OperationalStatus => {
  const worst = worstOf(findings);
  return Object.freeze({ domain, state: worst.state, action: worst.action, findings: Object.freeze(findings) });
};

const named = (statuses: readonly OperationalStatus[]): string => statuses.map((status) => status.domain).join(', ');

/**
 * What to do about the whole deployment. Derived from which domains came out how, and it quotes the worst
 * domain's own recommendation rather than restating it: there is one sentence for "the first thing to do",
 * and this is a pointer to it rather than a second copy that can drift from it.
 */
const overallAction = (statuses: readonly OperationalStatus[], state: OperationalState): string => {
  const failed = statuses.filter((status) => status.state === 'failed');
  const unknown = statuses.filter((status) => status.state === 'unknown');
  const degraded = statuses.filter((status) => status.state === 'degraded');
  const total = statuses.length;
  if (state === 'failed') {
    return `Start with ${named(failed)}: ${failed[0]?.action ?? ''}`;
  }
  if (state === 'unknown') {
    return `Restore this surface's view of ${named(unknown)} before trusting this page: ${unknown.length} of ${total} checks could not be read, and an unread check is not a passed one.`;
  }
  if (state === 'degraded') {
    return `Nothing is down; clear ${named(degraded)} before the next service: ${degraded[0]?.action ?? ''}`;
  }
  return `Nothing to do: all ${total} checks were measured and all ${total} passed.`;
};

/**
 * Grades seven already-measured domains into one Administration surface.
 *
 * Pure, and deliberately so: everything that touches a database, a filesystem or a browser has already
 * happened by the time this is called, which is what lets every branch below — including the ones a
 * healthy deployment never takes — be reached from a fixture rather than from a broken Sunday.
 */
export function operationalHealthOf(readings: OperationalReadings): OperationalHealthReport {
  const { at } = readings;
  const health = healthFindings(readings.health, at);
  const running = !workerStopped(health);

  const statuses: readonly OperationalStatus[] = Object.freeze([
    statusOf('health', health),
    statusOf('storage', storageFindings(readings.storage)),
    statusOf('queue', queueFindings(readings.queue, at, running)),
    statusOf('backup', backupFindings(readings.backup, at)),
    statusOf('restore', restoreFindings(readings.restore, at)),
    statusOf('media', mediaFindings(readings.media, running)),
    statusOf('readiness', readinessFindings(readings.readiness)),
  ]);

  const state = statuses.reduce<OperationalState>(
    (worst, status) => (STATE_RANK[status.state] > STATE_RANK[worst] ? status.state : worst),
    'ok',
  );
  return Object.freeze({ at, state, action: overallAction(statuses, state), statuses });
}

/**
 * Where each reading comes from. One narrow function per domain, the way `RehearsalClients` takes the
 * three browser capabilities a rehearsal needs and nothing else: this module never learns what a database
 * or a Restic repository is, and a test supplies all of it.
 *
 * `storage` and `readiness` are optional because a presenting machine may not have reported yet.
 */
export interface OperationalSources {
  readonly now: () => string;
  readonly worker: () => Promise<WorkerHeartbeatReading>;
  readonly queue: () => Promise<QueueReading>;
  readonly backups: () => Promise<readonly RecordedBackup[]>;
  readonly rehearsals: () => Promise<readonly RecordedRehearsal[]>;
  readonly media: () => Promise<readonly MediaManifestEntry[]>;
  readonly storage?: () => Promise<StorageReading | undefined>;
  readonly readiness?: () => Promise<ReadinessReading | undefined>;
}

/**
 * One source's answer, or the fact that it had none.
 *
 * The thrown error is dropped rather than reported, and that is the point: a database refusing a
 * connection says so in a message holding a host, a port and sometimes a user, and an operations page is
 * the last place that belongs. Which domain went dark is what an operator acts on; the message is in the
 * application log, where it is already written and already private.
 */
const read = async <T>(source: () => Promise<T>): Promise<T | typeof UNREADABLE> => {
  try {
    return await source();
  } catch {
    return UNREADABLE;
  }
};

const readOptional = async <T>(
  source: (() => Promise<T | undefined>) | undefined,
): Promise<T | typeof UNREADABLE | undefined> => (source === undefined ? undefined : read(source));

/** Takes all seven readings — one failure costing one domain and no other — and grades them. */
export async function observeOperationalHealth(sources: OperationalSources): Promise<OperationalHealthReport> {
  const [health, queue, backup, restore, media, storage, readiness] = await Promise.all([
    read(sources.worker),
    read(sources.queue),
    read(sources.backups),
    read(sources.rehearsals),
    read(sources.media),
    readOptional(sources.storage),
    readOptional(sources.readiness),
  ]);
  return operationalHealthOf({ at: sources.now(), health, queue, backup, restore, media, storage, readiness });
}
