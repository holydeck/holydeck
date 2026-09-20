// The exact references a run showed, and the optional recap rendered from them (spec LIVE-13).
//
// Both answers are reductions over `run-events.ts`'s immutable log and nothing else. That is the whole of
// the requirement: a review read off the Service definition would answer what somebody meant to show, in
// the order they meant to show it, which is a different list on any Sunday where an item was skipped,
// shown twice, taken out of order, or added from the front mid-service — and the definition is editable
// after the fact, while the log is not (ADR 0002, ADR 0007). Nothing here reads a Service, a manifest or a
// run row; the only thing it asks the server for is the log, and the only thing it gives back is what the
// log already says.
//
// A recap is therefore never stored. `snapshots.ts`'s `runLabel` is the same shape — it re-reads the log
// and reduces over it rather than keeping a label anywhere — and for the same reason: a recap kept beside
// the log is a second copy that can disagree with it, and the moment it does, the copy is what a person
// reads. Rendering one is a pure function of the log at the moment it is asked for, so a recap that
// diverges from the log is not a recap this module can produce.
//
// What it deliberately leaves out: every event that moved nothing into view. Three of `live-events.ts`'s
// four change classes are operator state — theme, Standby, run-state — and the log also carries
// `snapshots.ts`'s `readiness.override` rows, which are an act of control rather than a reference put in
// front of the room. None of them is something the room was shown, so none of them is in the review;
// `snapshots.ts`'s own `runLabel` is where an override is answered for, which is why it is not answered
// for twice here.
//
// Reading is gated on `runEvents.read` alone (the repository's own check, `records.ts`'s
// `permissionsFor`), never on Control presentation: reviewing what happened is not controlling anything,
// and the person going back over a service afterwards is often not the Operator who ran it. Writing is the
// opposite — `show` goes through `runEvents.record`, which checks THR-11 before it reads or writes a thing.
//
// `show` is here because the log had no writer for the ordinary case at all: `live-theme.ts` writes theme
// changes, `snapshots.ts` writes overrides, `mid-service-additions.ts` writes what a run took on while it
// was already on, and `runs.ts` fixes a run's position at zero and says in its own header that nothing
// there ever moves it again. So the one act LIVE-13 reviews — the Operator moving the room to the next
// reference — was the one act nothing recorded. Recording it is all `show` does: telling the joined views
// is `live-events.ts`'s `publishSlideChanged`, which the surface that moves a run's position calls, the
// same way `live-theme.ts` records first and publishes second.
//
// A run's phase is not asked for anywhere here, which is what makes the review the same during the run and
// after it: the log of a run that ended is the log it already was, one row longer than it was a moment
// before it ended, and `runs.ts` alone owns whether a run is still on.
//
// Not `shown-references.ts`: that store is BIBL-04's record of a Bible lookup an operator put on screen
// from the reference routes, keyed to nothing and promising nothing about immutability, and its own header
// says so. A review derived from it would be derived from something that is not the presentation-run log.

import { requestContext } from './context.js';
import { LIVE_EVENT_TYPES } from './live-events.js';
import { RUN_EVENT_PERMISSIONS } from './run-events.js';

import type { SnapshotPin } from '@holydeck/contracts/snapshots';
import type { RequestContext } from './context.js';
import type { RunEventRecord, RunEventStore, ShownItem } from './run-events.js';
import type { OperatorSession } from './snapshots.js';

/** The context a review is read under: the run log's own read permission, and nothing else at all. */
export function runReviewContext(actor: string, correlationId: string): RequestContext {
  return requestContext({ actor, permissions: [RUN_EVENT_PERMISSIONS.read], correlationId });
}

/** What the Operator moved the room to, and the pins the run was showing from when they did. */
export interface ShowRequest {
  readonly runId: string;
  readonly itemId: string;
  readonly reference: string;
  /** Every one of `SNAPSHOT_PINS`, read back from the run's own bound manifest and never recomputed. */
  readonly pinnedRevisions: Readonly<Record<SnapshotPin, string>>;
}

/** One reference the run actually showed, as the log holds it: never re-derived, never re-ordered. */
export interface ReviewedReference extends ShownItem {
  /** The log's own ordinal, so an entry can be taken back to the event it came from. */
  readonly sequence: number;
  readonly at: string;
  readonly actor: string;
}

/** The optional recap: the same references, rendered in the order the run showed them. */
export interface RunRecap {
  readonly runId: string;
  readonly lines: readonly string[];
}

export interface RunReviewStore {
  /** Records that the Operator put one reference in front of the room: one `current-slide-changed` in the
   *  run's log, carrying what was shown. Refused for a session without Control presentation (THR-11). */
  show(session: OperatorSession, request: ShowRequest): Promise<RunEventRecord>;
  /** Exactly the references this run showed, oldest first — during the run and after it alike. */
  review(context: unknown, runId: string): Promise<readonly ReviewedReference[]>;
  /** The optional recap, rendered from the log at the moment it is asked for and stored nowhere. */
  recap(context: unknown, runId: string): Promise<RunRecap>;
}

const shownIn = (log: readonly RunEventRecord[]): readonly ReviewedReference[] =>
  log.flatMap((event) =>
    // Both halves are the filter: a kind that shows something, carrying what it showed. An override row
    // satisfies neither, and a slide event written before this field existed satisfies only the first.
    event.kind === LIVE_EVENT_TYPES.slide && event.shown !== undefined
      ? [{ sequence: event.sequence, at: event.at, actor: event.actor, itemId: event.shown.itemId, reference: event.shown.reference }]
      : [],
  );

/** The review over one run event log. Composed the way `live-theme.ts` composes: given the store, not a
 *  database, because everything this module knows is already in that store's own answers. */
export function runReviewOn(runEvents: Pick<RunEventStore, 'record' | 'log'>): RunReviewStore {
  const store: RunReviewStore = {
    show: (session, request) =>
      runEvents.record(session, {
        runId: request.runId,
        kind: LIVE_EVENT_TYPES.slide,
        pinnedRevisions: request.pinnedRevisions,
        shown: { itemId: request.itemId, reference: request.reference },
      }),

    review: async (context, runId) => shownIn(await runEvents.log(context, runId)),

    recap: async (context, runId) => ({
      runId,
      // Numbered as the run showed them, which is the log's order and not the plan's.
      lines: shownIn(await runEvents.log(context, runId)).map((entry, index) => `${index + 1}. ${entry.reference}`),
    }),
  };
  return Object.freeze(store);
}
