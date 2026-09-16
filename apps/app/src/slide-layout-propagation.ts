// How a Slide Layout's revisions reach each of ADR 0005's five consumers, and how a consumer that pinned
// one decides whether that pin has gone Outdated (spec 8.2, 8.4). This composes with the existing store
// rather than opening a second read path: `slide-layouts.ts`'s `preview(context, id)` already resolves the
// current revision, and `preview(context, id, revision)` already resolves that exact hash-addressed,
// append-only, immutable revision forever, unaffected by a later `version()` call. So "stays pinned" and
// "never mutated" are already true of every call a consumer makes through that store — nothing here
// reopens that.
//
// What this file adds is the one thing not already true for free: naming, once, which of the five ADR 0005
// consumers pins a revision and which floats to current, and computing whether a pin has gone stale. No
// prepared-snapshot or run-persistence module exists yet (spec PREP-01/LIVE-12, stage W6, not started) to
// call these from — they are free functions a future module composes with.
//
// `contentRevisions` resolves nothing here: the ADR's fifth row exists only to rule out an ambiguity an
// earlier design note raised — that a Slide Layout edit might auto-apply to a pinned content revision the
// way it auto-applies to unprepared rendering. A Slide Layout carries no reference to any content revision
// anywhere in this codebase, so there is nothing for this module to resolve for it.

/** The five places ADR 0005 names a Slide Layout revision being read from. */
export type LayoutConsumer =
  | 'unpreparedRendering'
  | 'preparedSnapshot'
  | 'activeRun'
  | 'historicalRunLog'
  | 'contentRevisions';

/** How a consumer resolves a Slide Layout: 'current' floats to the latest edit; 'pinned' never does. */
export type LayoutResolution = 'current' | 'pinned' | 'not-applicable';

const RESOLUTION_BY_CONSUMER: Readonly<Record<LayoutConsumer, LayoutResolution>> = {
  unpreparedRendering: 'current',
  preparedSnapshot: 'pinned',
  activeRun: 'pinned',
  historicalRunLog: 'pinned',
  contentRevisions: 'not-applicable',
};

/** Spec 8.4's propagation table, said as a lookup instead of prose. */
export function resolutionFor(consumer: LayoutConsumer): LayoutResolution {
  return RESOLUTION_BY_CONSUMER[consumer];
}

/** What a pinned consumer requires once its pin no longer matches the Layout's current revision. */
export const OUTDATED_REQUIRES: readonly string[] = Object.freeze(['regeneration', 'revalidation']);

/**
 * Spec 8.2: a prepared snapshot is Outdated once the Layout it pinned has moved past the revision it
 * pinned. Computed, never stored — `preparedSnapshots` is an immutable record class (see records.ts), so
 * nothing about a snapshot can be rewritten to say "now outdated" even if a future module wanted to.
 */
export function isOutdated(pinnedRevision: number, currentRevision: number): boolean {
  return currentRevision !== pinnedRevision;
}
