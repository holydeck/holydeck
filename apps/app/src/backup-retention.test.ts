import { describe, expect, test } from 'vitest';

import { RETENTION, retentionFor } from './backup-retention.js';

import type { RecordedBackup } from './backups.js';

/** One recorded run, named after the day it ran so a failing expectation reads as a date. */
const run = (at: string, snapshots: readonly string[] = [`snap-${at}`]): RecordedBackup => ({
  backupId: `backup-${at}`,
  at,
  snapshots,
  production: {
    manifest: { id: `backup-${at}`, createdAt: at, schemaVersion: 19, contents: [], excludedSecrets: [] },
    consistency: { pointInTime: true, method: 'a session read at one snapshot cluster time' },
  },
});

const idsOf = (runs: readonly RecordedBackup[]): readonly string[] => runs.map((one) => one.backupId);

const at = (day: string, hour = '02'): string => `${day}T${hour}:00:00.000Z`;

describe('what a backup retention policy ships as', () => {
  test('is seven daily, four weekly and twelve monthly', () => {
    expect(RETENTION).toEqual({ daily: 7, weekly: 4, monthly: 12 });
  });

  test('decides nothing when nothing has run', () => {
    expect(retentionFor([])).toEqual({ keep: [], forget: [], snapshotsToForget: [] });
  });
});

describe('keeping the newest run of a period', () => {
  test('keeps one run per day and forgets the others that day', () => {
    const runs = [run(at('2026-09-19', '02')), run(at('2026-09-19', '14')), run(at('2026-09-19', '20'))];
    const decided = retentionFor(runs, { daily: 7, weekly: 0, monthly: 0 });
    expect(idsOf(decided.keep)).toEqual([`backup-${at('2026-09-19', '20')}`]);
    expect(decided.forget).toHaveLength(2);
  });

  test('keeps the newest run of each of the last so-many days', () => {
    const days = ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'];
    const decided = retentionFor(days.map((day) => run(at(day))), { daily: 2, weekly: 0, monthly: 0 });
    expect(idsOf(decided.keep)).toEqual([`backup-${at('2026-09-19')}`, `backup-${at('2026-09-18')}`]);
    expect(idsOf(decided.forget)).toHaveLength(3);
  });

  // Weeks are ISO weeks in UTC: a Sunday and the Monday after it are different weeks, however close they
  // are in hours, which is the whole reason a weekly rule is not "every seventh day".
  test('keeps the newest run of each of the last so-many weeks', () => {
    const runs = [
      run(at('2026-09-19')), // Saturday, week 38
      run(at('2026-09-16')), // Wednesday, week 38
      run(at('2026-09-13')), // Sunday, week 37
      run(at('2026-09-07')), // Monday, week 37
      run(at('2026-09-06')), // Sunday, week 36
    ];
    const decided = retentionFor(runs, { daily: 0, weekly: 2, monthly: 0 });
    expect(idsOf(decided.keep)).toEqual([`backup-${at('2026-09-19')}`, `backup-${at('2026-09-13')}`]);
  });

  test('keeps the newest run of each of the last so-many months', () => {
    const runs = [run(at('2026-09-19')), run(at('2026-09-01')), run(at('2026-08-30')), run(at('2026-07-04'))];
    const decided = retentionFor(runs, { daily: 0, weekly: 0, monthly: 2 });
    expect(idsOf(decided.keep)).toEqual([`backup-${at('2026-09-19')}`, `backup-${at('2026-08-30')}`]);
  });

  test('keeps a run once however many rules claim it', () => {
    const decided = retentionFor([run(at('2026-09-19'))]);
    expect(decided.keep).toHaveLength(1);
    expect(decided.forget).toEqual([]);
  });

  test('reads the runs newest-first whatever order they arrived in', () => {
    const runs = [run(at('2026-09-17')), run(at('2026-09-19')), run(at('2026-09-18'))];
    const decided = retentionFor(runs, { daily: 1, weekly: 0, monthly: 0 });
    expect(idsOf(decided.keep)).toEqual([`backup-${at('2026-09-19')}`]);
  });
});

describe('a run is kept or forgotten whole', () => {
  // The point of grouping: a backup's restore set is spread across several snapshots, and forgetting one
  // of them leaves a manifest pointing at an archive that cannot be restored — worse than no backup,
  // because it still looks like one.
  test('forgets every snapshot a forgotten run was spread across', () => {
    const runs = [
      run(at('2026-09-19'), ['snap-mongo-new', 'snap-settings-new', 'snap-media-new']),
      run(at('2026-09-18'), ['snap-mongo-old', 'snap-settings-old', 'snap-media-old']),
    ];
    const decided = retentionFor(runs, { daily: 1, weekly: 0, monthly: 0 });
    expect([...decided.snapshotsToForget].sort()).toEqual(['snap-media-old', 'snap-mongo-old', 'snap-settings-old']);
  });

  test('never forgets a snapshot a kept run still depends on', () => {
    const runs = [
      run(at('2026-09-19'), ['snap-mongo-new', 'snap-media-unchanged']),
      run(at('2026-09-18'), ['snap-mongo-old', 'snap-media-unchanged']),
    ];
    const decided = retentionFor(runs, { daily: 1, weekly: 0, monthly: 0 });
    expect(decided.snapshotsToForget).toEqual(['snap-mongo-old']);
  });

  test('forgets nothing while every run is one a rule still claims', () => {
    const runs = [run(at('2026-09-19')), run(at('2026-09-18')), run(at('2026-09-17'))];
    const decided = retentionFor(runs);
    expect(decided.forget).toEqual([]);
    expect(decided.snapshotsToForget).toEqual([]);
  });

  // Thirteen months of runs, one a month: the daily and weekly rules each claim a handful of the newest,
  // the monthly rule claims twelve, and the thirteenth is the first run nothing claims at all.
  const MONTHLY_RUNS = [
    '2026-09-01',
    '2026-08-01',
    '2026-07-01',
    '2026-06-01',
    '2026-05-01',
    '2026-04-01',
    '2026-03-01',
    '2026-02-01',
    '2026-01-01',
    '2025-12-01',
    '2025-11-01',
    '2025-10-01',
    '2025-09-01',
  ];

  test('forgets the run the oldest rule has just stopped reaching', () => {
    const decided = retentionFor(MONTHLY_RUNS.map((day) => run(at(day))));
    expect(idsOf(decided.keep)).toHaveLength(12);
    expect(idsOf(decided.forget)).toEqual([`backup-${at('2025-09-01')}`]);
    expect(decided.snapshotsToForget).toEqual([`snap-${at('2025-09-01')}`]);
  });

  test('leaves a run carrying no snapshot of its own nothing to forget', () => {
    const runs = MONTHLY_RUNS.map((day) => run(at(day), day === '2025-09-01' ? [] : [`snap-${at(day)}`]));
    const decided = retentionFor(runs);
    expect(idsOf(decided.forget)).toEqual([`backup-${at('2025-09-01')}`]);
    expect(decided.snapshotsToForget).toEqual([]);
  });

  // The safe half of counting periods that have a run rather than calendar periods: a deployment that
  // backed up twice and then stopped still has both, instead of being pruned down to nothing while
  // nobody was looking.
  test('forgets nothing at all when there are fewer runs than the rules reach for', () => {
    const decided = retentionFor([run(at('2026-09-19')), run(at('2020-01-02'))]);
    expect(decided.forget).toEqual([]);
  });
});
