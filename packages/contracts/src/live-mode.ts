// The public-privacy model LIVE-08 names and spec 9.2 defines: which of `live`, `paused`, and
// `standby` a run is in, and the two positions that mode governs — `publicPosition` (what Audience
// and Guest see) and `selectedPosition` (what the operator is privately searching, inspecting a
// passage or offset in, or otherwise browsing). This is the model alone, framework- and
// transport-free, the same split `slide-labels.ts` keeps between a rule and whatever later wires a
// real surface to it; a live session's server authority (§9.1, `live-protocol.ts`) is what would
// actually carry a `select`/`takeSelectedLive`/… call onto the wire, and is not this file's concern.
//
// C-06: LIVE-04 and LIVE-08 predate the closed Standby decision and used the superseded two-state
// name this file never repeats — restated here using only the canonical three-mode vocabulary.
// `live-mode.test.ts` greps this file for that superseded literal and fails if it is ever reintroduced.
//
// `P` is left generic on purpose: a position is a slide index to `control-state.ts`, a Standby
// screen id to whatever builds that domain, and later a passage or offset reference to whichever
// task wires Bible lookup into Control — none of which this model needs to know the shape of to get
// the mode/privacy rules right.

/** The three modes spec 9.2's table defines. Nothing else is a live mode — see the header note on
 *  C-06 — and every function below reaches `'live'` only by a call that says explicitly what
 *  `publicPosition` becomes, never by falling through with whatever it already was. */
export const LIVE_MODES = ['live', 'paused', 'standby'] as const;
export type LiveMode = (typeof LIVE_MODES)[number];

/**
 * `publicPosition` is what §9.3 says Audience and Guest may ever be shown; `selectedPosition` is
 * everything else an operator does privately — a search, a passage or offset being checked, upcoming
 * content being browsed. The two are tracked apart deliberately: in `live` a `select` keeps them
 * equal, but the instant the mode is not `live`, only one of `select`'s two writes still happens.
 *
 * `emptyScreen` is the plain default screen §9.2's Standby-media-failure rule falls back to — fixed
 * once at `initialLiveModeState` alongside the position type it shares, so `enterStandby` never has
 * to be told twice what "nothing to show" looks like for this deployment's position type.
 */
export interface LiveModeState<P> {
  readonly mode: LiveMode;
  readonly publicPosition: P;
  readonly selectedPosition: P;
  readonly emptyScreen: P;
}

/** A fresh run: `live`, both positions at the default empty screen, nothing yet shown or selected. */
export function initialLiveModeState<P>(emptyScreen: P): LiveModeState<P> {
  return { mode: 'live', publicPosition: emptyScreen, selectedPosition: emptyScreen, emptyScreen };
}

/**
 * Control navigation, search, passage inspection, offset inspection — every way an operator moves
 * where they are privately looking (LIVE-08's list, verbatim). In `live` this is also what reaches
 * the public output, because `live` is defined as Control navigation publishing immediately (spec
 * 9.2's table). In `paused` and `standby` it moves `selectedPosition` alone; `publicPosition` is
 * untouched, and so is whatever `publicFrameOf` hands Audience and Guest.
 */
export function select<P>(state: LiveModeState<P>, position: P): LiveModeState<P> {
  return state.mode === 'live'
    ? { ...state, publicPosition: position, selectedPosition: position }
    : { ...state, selectedPosition: position };
}

/**
 * Holds the last live `publicPosition` on the public output (spec 9.2's `paused` row) while
 * `selectedPosition` — already equal to it, since every `live` `select` keeps them so — is free to
 * move privately from here. `publicPosition` itself is never written by this call.
 */
export function pause<P>(state: LiveModeState<P>): LiveModeState<P> {
  return { ...state, mode: 'paused' };
}

/**
 * `Return to Live Position`: abandons private browsing and re-syncs `selectedPosition` back onto
 * whatever is still live, without ever having moved `publicPosition` at all. The other of the two
 * named ways out of `paused` — `takeSelectedLive` is the one that publishes instead of discarding.
 */
export function returnToLivePosition<P>(state: LiveModeState<P>): LiveModeState<P> {
  return { ...state, mode: 'live', selectedPosition: state.publicPosition };
}

/**
 * `Take Selected Live`: the one explicit act that ever moves a private `paused` or `standby`
 * selection onto the public output — LIVE-08's "never implicitly". Nothing here reaches this mode
 * any other way that leaves `publicPosition` unaccounted for.
 */
export function takeSelectedLive<P>(state: LiveModeState<P>): LiveModeState<P> {
  return { ...state, mode: 'live', publicPosition: state.selectedPosition };
}

/**
 * The Standby primary action (spec 9.2: "immediate" — never staged behind a private step).
 * `mediaAvailable: false` is the Standby-media-failure rule stated alongside it: the public output
 * falls back to `state.emptyScreen` — the plain default screen — rather than `screen` itself
 * half-rendered or an error left showing. `selectedPosition` is left exactly where it was, so
 * private browsing that was already under way continues uninterrupted by entering Standby.
 */
export function enterStandby<P>(state: LiveModeState<P>, screen: P, mediaAvailable = true): LiveModeState<P> {
  return { ...state, mode: 'standby', publicPosition: mediaAvailable ? screen : state.emptyScreen };
}

/**
 * `Resume`: reveals the slide privately selected while in Standby, the only way it ever reaches the
 * public output (spec 9.2's `standby` row, verbatim: "Resume, which reveals the privately selected
 * slide").
 */
export function resume<P>(state: LiveModeState<P>): LiveModeState<P> {
  return { ...state, mode: 'live', publicPosition: state.selectedPosition };
}

/** Exactly what spec 9.3 says Audience and Guest may ever receive from this model: the public
 *  position, and nothing named `selectedPosition` for a payload, a DOM, or an accessibility tree to
 *  leak. */
export interface PublicFrame<P> {
  readonly position: P;
}

/** The public render model — the only view of this state Audience or Guest output is ever built
 *  from. Never reads `selectedPosition`. */
export function publicFrameOf<P>(state: LiveModeState<P>): PublicFrame<P> {
  return { position: state.publicPosition };
}
