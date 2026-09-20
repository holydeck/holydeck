// Moving an output surface from one frame to the next (LIVE-19): which transition the admin chose, how
// long it is allowed to take, and — the part that matters on a Sunday — what the room is looking at when
// one does not complete.
//
// This is the rule alone, in the shape `stage-state.ts` and `singer-state.ts` keep: pure functions over a
// state small enough to reason about, with no element, no timer and no clock of its own. Whatever later
// drives a real surface owns the animation and the moment it reports back; nothing here can start one, so
// nothing here can be the reason a frame is late.
//
// A frame is only ever its identity below. What a frame is made of is the renderer's, and deliberately not
// repeated here: the single question this module answers is *which* frame a surface is authoritatively
// showing, and an answer made of whole rendered slides would have to be kept in step with one.
//
// `none` is a real member of the selection rather than the absence of one. An admin who wants a hard cut
// has chosen something, the same way `MediaRecovery`'s `'none'` in `@holydeck/contracts/live-media` is a
// chosen affordance rather than a missing one — a selection nobody made and a selection of nothing are
// different facts, and only the second is a setting that can be saved, shown back, and relied on.
//
// The failure rule is LIVE-19's own sentence: a failure "never replaces the last authoritative frame with
// an error or blank browser surface". `live-media.ts` already keeps the same promise one level down, for a
// clip that will not load, by holding the last frame instead of showing a dead element. A transition is the
// same promise one level up, and it is kept here by construction rather than by remembering to catch: the
// incoming frame becomes authoritative in exactly one place — a transition reported complete — so every
// other path, including a failure, a late report and a move superseded by the next one, leaves the frame
// that was already on screen exactly where it was. There is no path through this file that produces a
// surface showing nothing that was not already showing nothing.

/** Every transition an admin may configure, in the order a settings surface offers them. `none` is the
 *  hard cut, and the one this build ships configured: it is what an operator running an old machine in a
 *  cold hall can always afford, and every other choice here is something they opt into. */
export const TRANSITIONS = ['none', 'fade', 'crossfade', 'push'] as const;

export type TransitionName = (typeof TRANSITIONS)[number];

/** The transitions that actually animate — everything except the cut. Excluding `none` at the type level
 *  is why a running transition below cannot be one that runs for no time at all. */
export type AnimatedTransition = Exclude<TransitionName, 'none'>;

/** What a fresh deployment presents with until an admin says otherwise. */
export const DEFAULT_TRANSITION: TransitionName = 'none';

/**
 * How long an operator may be kept waiting between asking for the next frame and that frame being the one
 * on screen — the whole move, not the paint at the end of it.
 *
 * Nothing enforces this at runtime, deliberately: a surface on a tired machine that overruns should still
 * finish its move, because a late frame is worth incomparably more to a service than an abandoned one. It
 * is asserted by this module's own test against every duration declared below, so a transition tuned into
 * something sluggish fails a build rather than a Sunday. The number is this task's own and provisional —
 * chosen as the longest move that still reads as the operator's press rather than as the machine thinking
 * about it. Confirming it against the supported hardware matrix is T111's job, which owns every budget
 * this product declares; this is the figure T111 has to confirm or correct.
 */
export const TRANSITION_BUDGET_MS = 250;

/** How long each transition runs. Every one of them sits inside the budget above with room left for the
 *  commit, and `none` takes no time because there is nothing to take time. */
const DURATIONS: Readonly<Record<TransitionName, number>> = Object.freeze({
  none: 0,
  fade: 160,
  crossfade: 200,
  push: 220,
});

/** Whether a stored or submitted string names a transition this build actually has. */
export const isTransitionName = (value: string): value is TransitionName =>
  (TRANSITIONS as readonly string[]).includes(value);

export const transitionDurationMs = (name: TransitionName): number => DURATIONS[name];

/**
 * An admin choosing the transition. A name this build does not offer — a stale setting from an older
 * deployment, a hand-edited value — leaves the configured one exactly as it was, for the same reason
 * `selectStageLanguage` refuses a language an item never declared: a selection that cannot be honoured is
 * a selection that changes nothing, rather than one that quietly resolves to somebody else's default.
 */
export function selectTransition(configured: TransitionName, chosen: string): TransitionName {
  return isTransitionName(chosen) ? chosen : configured;
}

/** What the surface that ran a transition reports back. A pure function cannot watch an animation drop
 *  frames or a compositor give up, so whatever did watch hands the fact in; nothing here goes looking. */
export type TransitionOutcome = 'completed' | 'failed';

/** Which frame stands once an outcome is known. Two members, and there is never going to be a third: a
 *  move either delivered the frame it was carrying or it did not, and the second case is the last
 *  authoritative frame rather than anything new to draw. */
export type TransitionFallback = 'incoming-frame' | 'last-frame';

export const transitionFallbackFor = (outcome: TransitionOutcome): TransitionFallback =>
  outcome === 'failed' ? 'last-frame' : 'incoming-frame';

/** A move in flight: what is animating, for how long, and the frame it is carrying — which is not yet the
 *  frame this surface is showing, and becomes one only by completing. */
export interface RunningTransition {
  readonly transition: AnimatedTransition;
  readonly durationMs: number;
  readonly toFrameId: string;
}

/**
 * One output surface's transition state. `frameId` is the frame it is authoritatively showing — the one a
 * failure holds — and is empty only for a surface that has not yet shown anything at all, which no move
 * below can put it back into.
 *
 * `running` is absent, not an emptied object, whenever nothing is moving, so a renderer has no animation
 * to drive rather than one of zero length to drive pointlessly.
 */
export interface SurfaceTransition {
  readonly frameId: string;
  readonly running?: RunningTransition;
}

/** A surface standing on one frame with nothing moving — a fresh output, or one caught up by a snapshot.
 *  An empty name is a surface showing nothing yet, which is a real state and not a failed move. */
export function settledOn(frameId: string): SurfaceTransition {
  return { frameId: frameId.trim() };
}

/**
 * The next frame arriving. A cut lands immediately and has nothing to report back; every other transition
 * starts a move while this surface goes on showing the frame it already had.
 *
 * A move arriving while one is running supersedes it, carrying the newest frame and starting again from
 * the frame the room can actually see — an operator pressing twice quickly means the later slide is what
 * is coming, and the one skipped past was never on screen to be left half-way onto.
 *
 * A move onto no frame at all is refused outright rather than started and left to fail, which is the
 * blank-frame guarantee held one step earlier than the failure path that also holds it.
 */
export function beginTransition(
  state: SurfaceTransition,
  configured: TransitionName,
  toFrameId: string,
): SurfaceTransition {
  const to = toFrameId.trim();
  if (to === '') return state;
  if (configured === 'none') return { frameId: to };
  return {
    frameId: state.frameId,
    running: { transition: configured, durationMs: DURATIONS[configured], toFrameId: to },
  };
}

/**
 * What the surface is showing once the move is over. The one place the incoming frame ever becomes the
 * authoritative one, and it does so only for a transition that completed.
 *
 * An outcome arriving when nothing is running changes nothing — a duplicate report, or a failure raised
 * by a move that had already committed, cannot take a frame back off a screen it is already on.
 */
export function settleTransition(state: SurfaceTransition, outcome: TransitionOutcome): SurfaceTransition {
  const { running } = state;
  if (running === undefined) return state;
  return transitionFallbackFor(outcome) === 'last-frame'
    ? { frameId: state.frameId }
    : { frameId: running.toFrameId };
}
