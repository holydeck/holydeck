import { describe, expect, it } from 'vitest';

import {
  guardRemoval,
  policyFor,
  RETENTION_POLICIES,
  RetentionError,
  retentionOverridesOf,
  revisionRetentionClass,
  sweep,
} from './retention.js';

import type { RetentionCandidate, RetentionClass } from './retention.js';

const thrown = (call: () => unknown): RetentionError => {
  try {
    call();
  } catch (error) {
    if (error instanceof RetentionError) return error;
    throw error;
  }
  throw new Error('the call was allowed');
};

const candidate = (overrides: Partial<RetentionCandidate>): RetentionCandidate => ({
  id: 'candidate-1',
  class: 'autosave-revision',
  ageDays: 999,
  protectedBy: [],
  ...overrides,
});

describe('RETENTION_POLICIES', () => {
  it('declares a window for every class, so a sweep never finds one undeclared', () => {
    const classes = RETENTION_POLICIES.map((policy) => policy.class).toSorted();
    expect(classes).toEqual(
      [
        'audit-entry',
        'autosave-revision',
        'conflict',
        'current-revision',
        'latest-autosave',
        'manual-checkpoint',
        'prepared-snapshot',
        'run-event',
      ] satisfies RetentionClass[],
    );
    for (const policy of RETENTION_POLICIES) {
      expect(policy.retentionDays, `${policy.class}'s window`).toBeGreaterThan(0);
    }
  });

  it('marks exactly the four permanent revision classes plus prepared snapshots and run events protected', () => {
    const protectedClasses = RETENTION_POLICIES.filter((policy) => policy.protected).map((policy) => policy.class).toSorted();
    expect(protectedClasses).toEqual(
      ['conflict', 'current-revision', 'latest-autosave', 'manual-checkpoint', 'prepared-snapshot', 'run-event'].toSorted(),
    );
  });
});

describe('policyFor', () => {
  it('returns the static default with no overrides given', () => {
    expect(policyFor('audit-entry').retentionDays).toBe(365);
  });

  it('applies an auditRetentionDays override', () => {
    expect(policyFor('audit-entry', { auditRetentionDays: 90 }).retentionDays).toBe(90);
  });

  it('applies an autosaveRetentionDays override', () => {
    expect(policyFor('autosave-revision', { autosaveRetentionDays: 7 }).retentionDays).toBe(7);
  });

  it('ignores an override for a class that has none', () => {
    expect(policyFor('manual-checkpoint', { auditRetentionDays: 90 }).retentionDays).toBe(3650);
  });

  it('still throws no-policy for an unmapped class', () => {
    expect(() => policyFor('not-a-class', { auditRetentionDays: 90 })).toThrow();
  });
});

describe('the retention windows an administrator sets', () => {
  it('lets a shortened autosave window remove what the default would still keep', () => {
    const young = candidate({ id: 'young', class: 'autosave-revision', ageDays: 10 });
    expect(sweep([young]).removable).toEqual([]);
    expect(sweep([young], { autosaveRetentionDays: 7 }).removable).toEqual(['young']);
  });

  it('lets a lengthened audit window keep what the default would remove', () => {
    const entry = candidate({ id: 'entry', class: 'audit-entry', ageDays: 400 });
    expect(sweep([entry]).removable).toEqual(['entry']);
    expect(sweep([entry], { auditRetentionDays: 730 }).retained).toEqual([expect.objectContaining({ id: 'entry', reason: 'too-recent' })]);
    expect(() => guardRemoval(entry, { auditRetentionDays: 730 })).toThrow(RetentionError);
  });

  it('reads both windows straight off the settings', () => {
    expect(retentionOverridesOf({ auditRetentionDays: 90, autosaveRetentionDays: 14 })).toEqual({
      auditRetentionDays: 90,
      autosaveRetentionDays: 14,
    });
  });
});

describe('a referenced or historical entity cannot be destructively removed', () => {
  it('refuses a protected class with a named error, whatever its age', () => {
    const error = thrown(() => guardRemoval(candidate({ class: 'prepared-snapshot', ageDays: 9000 })));
    expect(error.name).toBe('RetentionError');
    expect(error.kind).toBe('protected-class');
  });

  it('refuses a referenced record with a named error, whatever its class', () => {
    const error = thrown(() =>
      guardRemoval(candidate({ class: 'autosave-revision', ageDays: 9000, protectedBy: ['prepared-snapshot:svc-1'] })),
    );
    expect(error.kind).toBe('referenced');
    expect(error.message).toContain('prepared-snapshot:svc-1');
  });

  it('refuses a record younger than its own class window, named apart from the other two refusals', () => {
    const error = thrown(() => guardRemoval(candidate({ class: 'autosave-revision', ageDays: 1 })));
    expect(error.kind).toBe('too-recent');
  });

  it('refuses a class with no declared policy rather than defaulting to allowed', () => {
    expect(() => policyFor('not-a-real-class')).toThrow(RetentionError);
    try {
      policyFor('not-a-real-class');
    } catch (error) {
      expect((error as RetentionError).kind).toBe('no-policy');
    }
  });

  it('allows exactly the case none of the three refusals apply: unprotected, unreferenced, past its window', () => {
    expect(() => guardRemoval(candidate({ class: 'autosave-revision', ageDays: 40 }))).not.toThrow();
  });
});

describe('archive and retention preserve prepared snapshots and run history', () => {
  it('survive a retention pass that expires an unreferenced, superseded autosave beside them', () => {
    const outcome = sweep([
      candidate({ id: 'snapshot-1', class: 'prepared-snapshot', ageDays: 9000 }),
      candidate({ id: 'run-1', class: 'run-event', ageDays: 9000 }),
      candidate({ id: 'autosave-1', class: 'autosave-revision', ageDays: 40 }),
    ]);
    expect(outcome.removable).toEqual(['autosave-1']);
    expect(outcome.retained.map((row) => row.id).toSorted()).toEqual(['run-1', 'snapshot-1']);
    expect(outcome.retained.every((row) => row.reason === 'protected-class')).toBe(true);
  });
});

describe('retention of one class never deletes another class protected records (ADR 0008)', () => {
  // ADR 0008's decision: a set of named classes, each with a declared retention window, and a sweep
  // that refuses a protected class or a still-referenced record with a named error rather than a
  // silent no-op (adrs/0008-retention-and-cross-class-deletion-protection.md; adrs/index.json lists
  // T58 under ADR 0008's enforcedBy).
  it('never lets a protected class slip into removable, whatever else is being swept in the same pass', () => {
    const protectedCandidates = RETENTION_POLICIES.filter((policy) => policy.protected).map((policy) =>
      candidate({ id: `protected-${policy.class}`, class: policy.class, ageDays: 100_000 }),
    );
    const eligible = candidate({ id: 'eligible-autosave', class: 'autosave-revision', ageDays: 100_000 });
    const outcome = sweep([...protectedCandidates, eligible]);

    expect(outcome.removable).toEqual(['eligible-autosave']);
    expect(outcome.retained).toHaveLength(protectedCandidates.length);
    for (const row of protectedCandidates) {
      expect(outcome.retained).toContainEqual(expect.objectContaining({ id: row.id, reason: 'protected-class' }));
    }
  });

  it('refuses a referenced record even when its own class carries no protection', () => {
    const outcome = sweep([
      candidate({ id: 'referenced-audit', class: 'audit-entry', ageDays: 100_000, protectedBy: ['run-event:run-1'] }),
      candidate({ id: 'free-audit', class: 'audit-entry', ageDays: 100_000 }),
    ]);
    expect(outcome.removable).toEqual(['free-audit']);
    expect(outcome.retained).toEqual([
      { id: 'referenced-audit', reason: 'referenced', message: expect.stringContaining('run-event:run-1') },
    ]);
  });
});

describe('protected content revisions never expire (ADR 0001)', () => {
  // ADR 0001's decision: the classes current, latest-autosave, conflict and manual-checkpoint — and any
  // revision referenced elsewhere — never expire; only a superseded, unreferenced, intermediate autosave
  // may (adrs/0001-content-identity-revisions-archive-and-deletion.md; adrs/index.json lists T58 under
  // ADR 0001's enforcedBy alongside T24, which built the revision store this classifies).
  const history = [
    { revision: 1, origin: 'autosave' as const },
    { revision: 2, origin: 'autosave' as const },
    { revision: 3, origin: 'manual-checkpoint' as const },
  ];

  it('grades the standing revision current, whatever its own origin', () => {
    expect(revisionRetentionClass(history, history[2]!)).toBe('current-revision');
  });

  it('grades an explicit checkpoint manual-checkpoint even once superseded', () => {
    const withLaterAutosave = [...history, { revision: 4, origin: 'autosave' as const }];
    expect(revisionRetentionClass(withLaterAutosave, history[2]!)).toBe('manual-checkpoint');
  });

  it('grades the most recent autosave latest-autosave once a checkpoint supersedes it', () => {
    expect(revisionRetentionClass(history, history[1]!)).toBe('latest-autosave');
  });

  it('grades an older autosave superseded by a later autosave as the only expirable class', () => {
    expect(revisionRetentionClass(history, history[0]!)).toBe('autosave-revision');
  });

  it('composes with guardRemoval: only the expirable class is ever removable, and only past its window', () => {
    const classified = history.map((revision) => ({
      revision,
      class: revisionRetentionClass(history, revision),
    }));
    const outcome = sweep(
      classified.map(({ revision, class: revisionClass }) =>
        candidate({ id: `revision-${revision.revision}`, class: revisionClass, ageDays: 9000 }),
      ),
    );
    expect(outcome.removable).toEqual(['revision-1']);
    expect(outcome.retained.map((row) => row.id).toSorted()).toEqual(['revision-2', 'revision-3']);
  });
});
