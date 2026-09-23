import { describe, expect, it } from 'vitest';

import { dueJobs } from './schedule.js';
import type { DueJobsSettings } from './schedule.js';

const SETTINGS: DueJobsSettings = {
  timezone: 'UTC',
  backupDailyAt: '03:00',
  backupComponents: ['settings', 'content'],
  backupMinimumGapMinutes: 120,
  backupRehearsalWeekday: 'sunday',
  retentionSweepAt: '04:00',
};

describe('dueJobs', () => {
  it('returns nothing before the daily backup time with an empty state', () => {
    const now = new Date('2026-09-14T02:59:00.000Z');

    expect(dueJobs({ now, settings: SETTINGS, state: {}, changedSinceLastBackup: false })).toEqual([]);
  });

  it('requests a scheduled backup at the daily backup time', () => {
    const now = new Date('2026-09-14T03:00:00.000Z');

    expect(dueJobs({ now, settings: SETTINGS, state: {}, changedSinceLastBackup: false })).toEqual([
      {
        kind: 'backup-run',
        idempotencyKey: 'backup-run:2026-09-14',
        payload: { components: ['settings', 'content'], trigger: 'scheduled' },
      },
    ]);
  });

  it('does not request a backup again after one completed on the same local date', () => {
    const now = new Date('2026-09-14T03:00:00.000Z');

    expect(
      dueJobs({
        now,
        settings: SETTINGS,
        state: { lastBackupAt: '2026-09-14T01:00:00.000Z' },
        changedSinceLastBackup: false,
      }),
    ).toEqual([]);
  });

  it('requests a backup after the daily time when the last backup was yesterday', () => {
    const now = new Date('2026-09-15T03:00:00.000Z');

    expect(
      dueJobs({
        now,
        settings: SETTINGS,
        state: { lastBackupAt: '2026-09-14T03:00:00.000Z' },
        changedSinceLastBackup: false,
      }),
    ).toEqual([
      {
        kind: 'backup-run',
        idempotencyKey: 'backup-run:2026-09-15',
        payload: { components: ['settings', 'content'], trigger: 'scheduled' },
      },
    ]);
  });

  it('requests a changed backup before the daily time after the minimum gap, keyed off the last backup', () => {
    const now = new Date('2026-09-15T02:00:00.000Z');

    for (const [state, key] of [
      [{}, 'backup-run:changed:never'],
      [{ lastBackupAt: '2026-09-14T23:00:00.000Z' }, 'backup-run:changed:2026-09-14T23:00:00.000Z'],
    ] as const) {
      expect(dueJobs({ now, settings: SETTINGS, state, changedSinceLastBackup: true })).toEqual([
        {
          kind: 'backup-run',
          idempotencyKey: key,
          payload: { components: ['settings', 'content'], trigger: 'changed' },
        },
      ]);
    }
  });

  it('requests another changed backup later the same day once the gap has elapsed again', () => {
    // Unlike the scheduled backup, capped at once per local date, a change-triggered one must be able to
    // fire again the same day the gap allows it — even past today's own scheduled backup.
    const now = new Date('2026-09-14T06:00:00.000Z');

    expect(
      dueJobs({
        now,
        settings: SETTINGS,
        state: { lastBackupAt: '2026-09-14T03:00:00.000Z', lastRetentionSweepAt: '2026-09-14T04:00:00.000Z' },
        changedSinceLastBackup: true,
      }),
    ).toEqual([
      {
        kind: 'backup-run',
        idempotencyKey: 'backup-run:changed:2026-09-14T03:00:00.000Z',
        payload: { components: ['settings', 'content'], trigger: 'changed' },
      },
    ]);
  });

  it('rate-limits a changed backup when the previous local date backup is too recent', () => {
    const now = new Date('2026-09-15T00:30:00.000Z');

    expect(
      dueJobs({
        now,
        settings: SETTINGS,
        state: { lastBackupAt: '2026-09-14T23:45:00.000Z' },
        changedSinceLastBackup: true,
      }),
    ).toEqual([]);
  });

  it('requests a restore only on the configured weekday after today’s backup and daily time', () => {
    const sundayBeforeDailyTime = new Date('2026-09-13T02:59:00.000Z');
    const sundayAfterDailyTime = new Date('2026-09-13T03:00:00.000Z');
    const otherWeekdays = [
      [new Date('2026-09-14T03:00:00.000Z'), '2026-09-14T01:00:00.000Z'],
      [new Date('2026-09-15T03:00:00.000Z'), '2026-09-15T01:00:00.000Z'],
      [new Date('2026-09-16T03:00:00.000Z'), '2026-09-16T01:00:00.000Z'],
      [new Date('2026-09-17T03:00:00.000Z'), '2026-09-17T01:00:00.000Z'],
      [new Date('2026-09-18T03:00:00.000Z'), '2026-09-18T01:00:00.000Z'],
      [new Date('2026-09-19T03:00:00.000Z'), '2026-09-19T01:00:00.000Z'],
    ] as const;

    expect(
      dueJobs({
        now: sundayBeforeDailyTime,
        settings: SETTINGS,
        state: { lastBackupAt: '2026-09-13T01:00:00.000Z' },
        changedSinceLastBackup: false,
      }),
    ).not.toContainEqual(expect.objectContaining({ kind: 'restore-run' }));
    expect(
      dueJobs({
        now: sundayAfterDailyTime,
        settings: SETTINGS,
        state: { lastBackupAt: '2026-09-13T01:00:00.000Z' },
        changedSinceLastBackup: false,
      }),
    ).toContainEqual({ kind: 'restore-run', idempotencyKey: 'restore-run:2026-09-13', payload: {} });
    expect(
      dueJobs({
        now: sundayAfterDailyTime,
        settings: SETTINGS,
        state: {
          lastBackupAt: '2026-09-13T01:00:00.000Z',
          lastRestoreRehearsalAt: '2026-09-13T03:00:00.000Z',
        },
        changedSinceLastBackup: false,
      }),
    ).not.toContainEqual(expect.objectContaining({ kind: 'restore-run' }));
    for (const [now, lastBackupAt] of otherWeekdays) {
      expect(
        dueJobs({ now, settings: SETTINGS, state: { lastBackupAt }, changedSinceLastBackup: false }),
      ).not.toContainEqual(expect.objectContaining({ kind: 'restore-run' }));
    }
  });

  it('does not request a restore before today’s backup completes', () => {
    const now = new Date('2026-09-13T03:00:00.000Z');

    expect(
      dueJobs({
        now,
        settings: SETTINGS,
        state: { lastBackupAt: '2026-09-12T03:00:00.000Z' },
        changedSinceLastBackup: false,
      }),
    ).not.toContainEqual(expect.objectContaining({ kind: 'restore-run' }));
  });

  it('requests a retention sweep at its daily time once per local date', () => {
    const beforeSweep = new Date('2026-09-14T03:59:00.000Z');
    const atSweep = new Date('2026-09-14T04:00:00.000Z');
    const afterSweep = new Date('2026-09-14T04:01:00.000Z');
    const nextDay = new Date('2026-09-15T04:00:00.000Z');
    const backupAndRestoreCompleted = {
      lastBackupAt: '2026-09-14T03:00:00.000Z',
      lastRestoreRehearsalAt: '2026-09-14T03:00:00.000Z',
    };

    expect(
      dueJobs({ now: beforeSweep, settings: SETTINGS, state: backupAndRestoreCompleted, changedSinceLastBackup: false }),
    ).toEqual([]);
    expect(
      dueJobs({ now: atSweep, settings: SETTINGS, state: backupAndRestoreCompleted, changedSinceLastBackup: false }),
    ).toEqual([{ kind: 'retention-sweep', idempotencyKey: 'retention-sweep:2026-09-14', payload: {} }]);
    expect(
      dueJobs({
        now: afterSweep,
        settings: SETTINGS,
        state: { ...backupAndRestoreCompleted, lastRetentionSweepAt: '2026-09-14T04:00:00.000Z' },
        changedSinceLastBackup: false,
      }),
    ).toEqual([]);
    expect(
      dueJobs({
        now: nextDay,
        settings: SETTINGS,
        state: {
          lastBackupAt: '2026-09-15T03:00:00.000Z',
          lastRetentionSweepAt: '2026-09-14T04:00:00.000Z',
        },
        changedSinceLastBackup: false,
      }),
    ).toEqual([{ kind: 'retention-sweep', idempotencyKey: 'retention-sweep:2026-09-15', payload: {} }]);
  });

  it('can return multiple job kinds due together in the same call', () => {
    // Rehearsal requires today's backup to have completed first (see the preceding test), so
    // "all three at once" is impossible from a single state; this covers both due-together pairs
    // the ordering invariant does allow: backup+sweep before today's backup runs, then
    // rehearsal+sweep once it has.
    const now = new Date('2026-09-13T04:00:00.000Z');

    expect(dueJobs({ now, settings: SETTINGS, state: {}, changedSinceLastBackup: false })).toEqual([
      {
        kind: 'backup-run',
        idempotencyKey: 'backup-run:2026-09-13',
        payload: { components: ['settings', 'content'], trigger: 'scheduled' },
      },
      { kind: 'retention-sweep', idempotencyKey: 'retention-sweep:2026-09-13', payload: {} },
    ]);

    expect(
      dueJobs({
        now,
        settings: SETTINGS,
        state: { lastBackupAt: '2026-09-13T03:30:00.000Z' },
        changedSinceLastBackup: false,
      }),
    ).toEqual([
      { kind: 'restore-run', idempotencyKey: 'restore-run:2026-09-13', payload: {} },
      { kind: 'retention-sweep', idempotencyKey: 'retention-sweep:2026-09-13', payload: {} },
    ]);
  });

  it('uses the local date in backup keys and same-day checks in UTC+14', () => {
    const now = new Date('2026-09-13T13:00:00.000Z');
    const settings: DueJobsSettings = { ...SETTINGS, timezone: 'Pacific/Kiritimati' };

    expect(dueJobs({ now, settings, state: {}, changedSinceLastBackup: false })).toEqual([
      {
        kind: 'backup-run',
        idempotencyKey: 'backup-run:2026-09-14',
        payload: { components: ['settings', 'content'], trigger: 'scheduled' },
      },
    ]);
    expect(
      dueJobs({
        now,
        settings,
        state: {
          lastBackupAt: '2026-09-13T11:00:00.000Z',
          lastRestoreRehearsalAt: '2026-09-13T11:00:00.000Z',
        },
        changedSinceLastBackup: false,
      }),
    ).toEqual([]);
  });

  it('catches up once after a spring-forward daily threshold in New York', () => {
    const beforeSpringForward = new Date('2026-03-08T06:59:00.000Z');
    const afterSpringForward = new Date('2026-03-08T07:00:00.000Z');
    const subsequentTick = new Date('2026-03-08T07:01:00.000Z');
    const settings: DueJobsSettings = {
      ...SETTINGS,
      timezone: 'America/New_York',
      backupDailyAt: '02:30',
      backupRehearsalWeekday: 'monday',
      retentionSweepAt: '23:59',
    };

    expect(dueJobs({ now: beforeSpringForward, settings, state: {}, changedSinceLastBackup: false })).toEqual([]);
    expect(dueJobs({ now: afterSpringForward, settings, state: {}, changedSinceLastBackup: false })).toEqual([
      {
        kind: 'backup-run',
        idempotencyKey: 'backup-run:2026-03-08',
        payload: { components: ['settings', 'content'], trigger: 'scheduled' },
      },
    ]);
    expect(
      dueJobs({
        now: subsequentTick,
        settings,
        state: { lastBackupAt: '2026-03-08T07:00:00.000Z' },
        changedSinceLastBackup: false,
      }),
    ).toEqual([]);
  });
});
