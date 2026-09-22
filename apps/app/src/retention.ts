// Retention and cross-class deletion protection: which named classes of durable record a retention pass
// is even allowed to consider, and the two reasons a candidate is refused anyway (ADR 0001, ADR 0008;
// requirement DELT-01).
//
// `repositories.ts` already proves the strong half of this by omission — no class it exposes offers a way
// to change or remove a record, so nothing here could rewrite or delete one even if it tried (see that
// file's own header, and Invariant 13's structural proof in repositories.test.ts). What was missing is the
// policy half this file adds: a declared window per class, which classes are never eligible regardless of
// age, and a decision that fails loudly rather than quietly no-opping when a candidate does not qualify.
// `guardRemoval` and `sweep` grade plain data a future sweep job assembles; they open no collection and
// delete no row, because this product's database user has no privilege to (records.ts's `RECORD_ACTIONS`)
// — wiring an actual sweep to an operational job is later work this file deliberately leaves undone.
//
// "No policy without a window": every class this file names carries a `retentionDays`, protected or not,
// so a class this table forgets is a defect `policyFor` raises rather than a sweep silently skipping.

export type RetentionClass =
  | 'audit-entry'
  | 'autosave-revision'
  | 'conflict'
  | 'current-revision'
  | 'latest-autosave'
  | 'manual-checkpoint'
  | 'prepared-snapshot'
  | 'run-event';

export interface RetentionPolicy {
  readonly class: RetentionClass;
  /** How long a record of this class stands before it is even considered. Required even when `protected`. */
  readonly retentionDays: number;
  /** True means never eligible, whatever its age: ADR 0001's four permanent revision classes, and the two
   *  record classes ADR 0008 protects unconditionally — nothing sweeping content revisions may ever reach
   *  either, which is Invariant 13. */
  readonly protected: boolean;
}

// ADR 0001: a content revision that is current, the most recent autosave, a conflict-shelf entry, or a
// manual checkpoint never expires. ADR 0008: prepared snapshots and run history are unconditionally
// protected, and every other class still needs a declared window even where nothing here yet sweeps it.
// Only a superseded, unreferenced, intermediate autosave revision is ever eligible, and only past its own
// window; audit entries are the other class ADMN-03 lets retention expire.
//
// Keyed by `RetentionClass` itself, with a type annotation rather than a cast, so a class this table
// forgets is a compile error here rather than a `no-policy` refusal `policyFor` would otherwise only catch
// at runtime — adding a ninth member to `RetentionClass` without a matching entry below does not compile.
const POLICIES: Record<RetentionClass, Omit<RetentionPolicy, 'class'>> = {
  'current-revision': { retentionDays: 3650, protected: true },
  'latest-autosave': { retentionDays: 3650, protected: true },
  conflict: { retentionDays: 3650, protected: true },
  'manual-checkpoint': { retentionDays: 3650, protected: true },
  'prepared-snapshot': { retentionDays: 3650, protected: true },
  'run-event': { retentionDays: 3650, protected: true },
  'autosave-revision': { retentionDays: 30, protected: false },
  'audit-entry': { retentionDays: 365, protected: false },
};

export const RETENTION_POLICIES: readonly RetentionPolicy[] = Object.freeze(
  Object.entries(POLICIES).map(([retentionClass, policy]) => ({
    class: retentionClass as RetentionClass,
    ...policy,
  })),
);

const POLICY_BY_CLASS: ReadonlyMap<string, RetentionPolicy> = new Map(
  RETENTION_POLICIES.map((policy) => [policy.class, policy]),
);

export type RetentionRefusal = 'no-policy' | 'protected-class' | 'referenced' | 'too-recent';

/** Carries why a removal was refused, so a caller can tell a policy gap from a rule this file enforces. */
export class RetentionError extends Error {
  readonly kind: RetentionRefusal;

  constructor(kind: RetentionRefusal, message: string) {
    super(message);
    this.name = 'RetentionError';
    this.kind = kind;
  }
}

const CLASS_OVERRIDE_KEY: Readonly<Partial<Record<RetentionClass, keyof RetentionOverrides>>> = {
  'audit-entry': 'auditRetentionDays',
  'autosave-revision': 'autosaveRetentionDays',
};

/** Settings-driven overrides for the two retention classes an admin can tune (spec v1c-09,
 *  COLAB-04, COLAB-11). */
export interface RetentionOverrides {
  readonly auditRetentionDays?: number;
  readonly autosaveRetentionDays?: number;
}

/** The declared window for a class, or a named refusal — never a silent policy of "anything goes". */
export function policyFor(retentionClass: string, overrides: RetentionOverrides = {}): RetentionPolicy {
  const policy = POLICY_BY_CLASS.get(retentionClass);
  if (policy === undefined) throw new RetentionError('no-policy', `${retentionClass} has no declared retention window`);
  const overrideKey = CLASS_OVERRIDE_KEY[policy.class];
  const overrideDays = overrideKey === undefined ? undefined : overrides[overrideKey];
  return overrideDays === undefined ? policy : { ...policy, retentionDays: overrideDays };
}

export interface RetentionCandidate {
  readonly id: string;
  readonly class: RetentionClass;
  readonly ageDays: number;
  /** Ids of other records that still reference this one. Non-empty outranks the class's own policy. */
  readonly protectedBy: readonly string[];
}

/**
 * Refuses with a named error, or returns — never both, and never a silent no-op. A reference outranks the
 * class's own policy (a record something else still points at cannot go even from an unprotected class),
 * then the class's own protection, then its age against the declared window.
 */
export function guardRemoval(candidate: RetentionCandidate): void {
  const policy = policyFor(candidate.class);
  if (candidate.protectedBy.length > 0) {
    throw new RetentionError('referenced', `${candidate.id}: still referenced by ${candidate.protectedBy.join(', ')}`);
  }
  if (policy.protected) {
    throw new RetentionError('protected-class', `${candidate.id}: ${candidate.class} is never removed`);
  }
  if (candidate.ageDays < policy.retentionDays) {
    throw new RetentionError(
      'too-recent',
      `${candidate.id}: ${candidate.ageDays} days old, short of ${candidate.class}'s ${policy.retentionDays}-day window`,
    );
  }
}

export interface RetainedCandidate {
  readonly id: string;
  readonly reason: RetentionRefusal;
  readonly message: string;
}

export interface SweepOutcome {
  readonly removable: readonly string[];
  readonly retained: readonly RetainedCandidate[];
}

/**
 * Grades a whole batch at once, mixed classes and all. This is what proves Invariant 13: every candidate
 * is judged only against its own declared class and its own references, one at a time, so a protected or
 * referenced record is retained no matter what else — or how much of it — is being swept in the same pass.
 */
export function sweep(candidates: readonly RetentionCandidate[]): SweepOutcome {
  const removable: string[] = [];
  const retained: RetainedCandidate[] = [];
  for (const candidate of candidates) {
    try {
      guardRemoval(candidate);
      removable.push(candidate.id);
    } catch (error) {
      if (!(error instanceof RetentionError)) throw error;
      retained.push({ id: candidate.id, reason: error.kind, message: error.message });
    }
  }
  return { removable, retained };
}

export interface GradedRevision {
  readonly revision: number;
  readonly origin: 'autosave' | 'manual-checkpoint';
}

/**
 * Which of ADR 0001's revision classes one content revision belongs to, from its place in that content's
 * own history. The standing revision is whichever `history` holds the highest ordinal for, found by value
 * rather than by trusting the list's own order — so this does not silently misgrade if a caller ever hands
 * it `history` in something other than the order `revisions.ts`'s own `history()` returns. This grades
 * nothing about whether a revision is referenced elsewhere (a prepared snapshot's pin, ADR 0006) — that is
 * the caller's to fold into `protectedBy` before calling `sweep`.
 */
export function revisionRetentionClass(history: readonly GradedRevision[], target: GradedRevision): RetentionClass {
  const current = history.reduce<GradedRevision | undefined>(
    (highest, entry) => (highest === undefined || entry.revision > highest.revision ? entry : highest),
    undefined,
  );
  if (current !== undefined && current.revision === target.revision) return 'current-revision';
  if (target.origin === 'manual-checkpoint') return 'manual-checkpoint';
  const supersededByALaterAutosave = history.some(
    (entry) => entry.origin === 'autosave' && entry.revision > target.revision,
  );
  return target.origin === 'autosave' && !supersededByALaterAutosave ? 'latest-autosave' : 'autosave-revision';
}
