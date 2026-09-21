// Audience offline continuity (OFFL-04): what the Audience output keeps doing when the live connection
// is not there to drive it. Invariant 7 says offline presentation runs only from a snapshot that is
// capacity-checked, completely cached, hash-verified and locally rehearsed — `preparation-rehearsal.ts`
// is where that snapshot is produced, as a `RehearsalReport`; this module is its first consumer, reading
// `rehearsedSlideIds` as the flat, already-drawn slide order OFFL-04 calls "the verified snapshot."
//
// "Read-only" is not a UI restriction layered on top of a capable client: the dependency this module
// takes on `LiveClient` is `Pick<LiveClient, 'status' | 'onStatus'>`, which carries no `command`,
// `connect` or `close` — code in this file is structurally unable to call any of them, the same
// no-such-capability guarantee `RehearsalClients` gives `preparation-rehearsal.ts` by never naming
// `fetch`. `next`/`previous` are real methods, not disabled ones, but they only ever move `position`
// while `state.kind === 'offline'` and a slide in that direction exists — while `live` or `unavailable`,
// or at either end of the slide order, calling either is a no-op. That is the concrete, testable shape
// "no mutation path" and "no wraparound" take here.
//
// "Connected" here means exactly `LiveSessionState === 'synchronised'` — the one state the contract
// names as this context actually holding a caught-up session — and nothing else: `connecting`,
// `authorizing`, `resuming` and `degraded` are all `offline` by this module's reading, because none of
// them is a live guarantee this screen dares show as one. That reading is what OFFL-04's exact wording
// asks for: continuing "without claiming remote guests remain synchronized" — the offline message names
// that other screens may no longer match this one, not just that this one lost its connection.
//
// What this module deliberately does not do: it does not implement reconnect reconciliation (T99,
// OFFL-05, invariant 8 — replacing stale local state, of which this read-only surface holds none to
// replace) and it does not touch the service editor's own read-only behavior on disconnect (D-17, a
// different surface). Position starts at 0 because no slide-position field exists anywhere on the live
// wire yet (`packages/contracts/src/live.ts`'s frame types carry none) — the day one does, wiring it in
// is this module's next caller's job, not a reason to block this one.

import { translate } from '@holydeck/localization/messages';

import type { Locale } from '@holydeck/localization/locales';
import type { LiveSessionState } from '@holydeck/contracts/live';

import type { LiveClient } from './live-client.js';
import type { LocalOutputStatusLike } from './local-output.js';
import type { RehearsalBlocker, RehearsalReport } from './preparation-rehearsal.js';

/** The only two things this module ever reads off a live context: its current status, and a way to
 *  hear the next one. No `command`, `connect` or `close` is named, so nothing in this file can reach
 *  them — the type itself is the read-only guarantee, not a rule this module has to remember to obey. */
export type AudienceOfflineLiveClient = Pick<LiveClient, 'status' | 'onStatus'>;

/**
 * Where the Audience surface stands. `live` claims nothing about what is on screen, only that this
 * context is caught up with the server and free to keep reading from it. `unavailable` is offline with
 * nothing safe to show — an empty or blocked rehearsal — and carries the blockers behind that, the same
 * un-worded codes `RehearsalReport` carries them as; a caller that wants to explain why owns that
 * translation, this module does not invent one. `offline` is the one state with a slide to show and
 * somewhere to move from it.
 */
export type AudienceOfflineState =
  | { readonly kind: 'live' }
  | { readonly kind: 'unavailable'; readonly blockers: readonly RehearsalBlocker[] }
  | {
      readonly kind: 'offline';
      readonly position: number;
      readonly slideId: string;
      readonly totalSlides: number;
      readonly canGoNext: boolean;
      readonly canGoPrevious: boolean;
    };

/** The slide after this one in the flat offline order — `undefined` at the last slide, the same
 *  no-wraparound-at-the-end reading `stage-state.ts` gives a service that has run out. */
export function nextAudienceOfflinePosition(totalSlides: number, position: number): number | undefined {
  return position + 1 < totalSlides ? position + 1 : undefined;
}

/** The slide before this one — `undefined` at the first: an audience already at the start has nowhere
 *  earlier to go back to. */
export function previousAudienceOfflinePosition(position: number): number | undefined {
  return position > 0 ? position - 1 : undefined;
}

/**
 * What the Audience surface is in right now, from the live status and the verified snapshot alone.
 * `position` is clamped into range before it is read, the same defensive shape `stage-state.ts`'s
 * `stopAt` clamps an out-of-range position into rather than trusting a caller kept it there.
 */
function deriveState(liveState: LiveSessionState, report: RehearsalReport, position: number): AudienceOfflineState {
  if (liveState === 'synchronised') return { kind: 'live' };

  const slideIds = report.rehearsedSlideIds;
  if (report.kind !== 'rehearsed' || slideIds.length === 0) {
    return { kind: 'unavailable', blockers: report.blockers };
  }

  const clamped = Math.min(Math.max(position, 0), slideIds.length - 1);
  const slideId = slideIds[clamped];
  if (slideId === undefined) return { kind: 'unavailable', blockers: report.blockers };

  return {
    kind: 'offline',
    position: clamped,
    slideId,
    totalSlides: slideIds.length,
    canGoNext: nextAudienceOfflinePosition(slideIds.length, clamped) !== undefined,
    canGoPrevious: previousAudienceOfflinePosition(clamped) !== undefined,
  };
}

export interface AudienceOfflineController {
  readonly state: AudienceOfflineState;
  readonly next: () => void;
  readonly previous: () => void;
  dispose(): void;
}

/**
 * Watches one live context and presents the Audience surface's own read-only reading of it against one
 * fixed rehearsal report — the verified snapshot for this run, taken once at construction, the same way
 * `preparation-rehearsal.ts` treats a report as a value rather than something that keeps changing under
 * a caller. `onChange` fires on every live status change and on every accepted `next`/`previous`; it does
 * not fire for the state this controller starts in, the same convention `createWakeLockController` keeps
 * for its own first state.
 */
export function createAudienceOfflineController(
  live: AudienceOfflineLiveClient,
  report: RehearsalReport,
  onChange: (state: AudienceOfflineState) => void,
): AudienceOfflineController {
  let position = 0;
  let liveState: LiveSessionState = live.status.state;
  let state: AudienceOfflineState = deriveState(liveState, report, position);

  const recompute = (): void => {
    state = deriveState(liveState, report, position);
    onChange(state);
  };

  const unsubscribe = live.onStatus((status) => {
    liveState = status.state;
    recompute();
  });

  return {
    get state() {
      return state;
    },
    next(): void {
      if (state.kind !== 'offline' || !state.canGoNext) return;
      position = state.position + 1;
      recompute();
    },
    previous(): void {
      if (state.kind !== 'offline' || !state.canGoPrevious) return;
      position = state.position - 1;
      recompute();
    },
    dispose(): void {
      unsubscribe();
    },
  };
}

/** Shows what the Audience surface is doing right now. `offline` and `unavailable` both say, or imply
 *  through translated copy, that this screen may no longer match what a remote guest sees — never the
 *  reverse: `live` is the only state this ever renders as connected. */
export function presentAudienceOfflineState(
  status: LocalOutputStatusLike,
  state: AudienceOfflineState,
  locale: Locale,
): void {
  switch (state.kind) {
    case 'live':
      status.textContent = translate(locale, 'audienceOffline.live');
      return;
    case 'offline':
      status.textContent = translate(locale, 'audienceOffline.offline');
      return;
    case 'unavailable':
      status.textContent = translate(locale, 'audienceOffline.unavailable');
  }
}
