// Local output (LIVE-10): the single-device presentation path, distinct from the separate-window
// surfaces `output-launch.ts` opens onto other screens (LIVE-16). When a service runs on one screen —
// no second display, no Window Management placement — this is what keeps that screen presentable: a
// real fullscreen transition instead of maximized browser chrome, next/previous keys instead of a mouse
// aimed at a control surface nobody can see while presenting, and a screen that does not sleep
// mid-service. `apps/app/src/static.ts`'s permissions-policy comment named this need before anything
// here existed — "presenting to a second screen needs fullscreen, wake lock and window management" —
// and this module is fullscreen and wake lock's half of that; `output-launch.ts` is window management's.
//
// All three sit behind the same risk this milestone's capability lab already named for the Window
// Management API: experimental APIs a browser can omit, refuse, or grant only from a user gesture — so
// every one of them is feature-detected here rather than assumed, and every refusal is a visible,
// recoverable state, never a console warning nobody reading the output sees.
//
// Real-device coverage is the same open gate `output-launch.ts` carries: T7's `hardware/index.json`
// records the DisplayLink protocol steps this unblocks as `blocked`, and DISC-03 stays open until the
// maintainer supplies the hardware to run them on (`evidence/2026-09-12-hardware-evidence.md`). This
// module's own tests prove the fullscreen, keyboard, and wake-lock mechanics those steps will exercise;
// they do not, and cannot yet, stand in for a hardware run nobody has taken.

import type { Locale } from '@holydeck/localization/locales';
import { translate } from '@holydeck/localization/messages';

// ---------------------------------------------------------------------------------------------------
// Fullscreen
// ---------------------------------------------------------------------------------------------------

/** The one method this client needs from the element it presents, injected for the same reason
 *  `output-launch.ts` injects `WindowOpenerLike`: a real browser API is never called untested. */
export interface FullscreenElementLike {
  requestFullscreen?: () => Promise<void>;
}

/** The document fullscreen state is read from and changed through. */
export interface FullscreenDocumentLike {
  readonly fullscreenElement: object | null;
  exitFullscreen?: () => Promise<void>;
  addEventListener(type: 'fullscreenchange', listener: () => void): void;
  removeEventListener(type: 'fullscreenchange', listener: () => void): void;
}

export type FullscreenState =
  | { readonly kind: 'entered' }
  | { readonly kind: 'exited' }
  | { readonly kind: 'unavailable'; readonly reason: 'api-absent' | 'denied' };

/**
 * Feature-detects `requestFullscreen` before ever calling it, then reads a denial and an absent API as
 * the same fact `detectScreens` already reads them as in `output-launch.ts`: neither leaves this client
 * a fullscreen surface, and both hand it the same manual fallback — the browser's own fullscreen key,
 * offered through `presentFullscreenState` rather than assumed known.
 */
export async function enterFullscreen(element: FullscreenElementLike): Promise<FullscreenState> {
  if (typeof element.requestFullscreen !== 'function') {
    return { kind: 'unavailable', reason: 'api-absent' };
  }
  try {
    await element.requestFullscreen();
    return { kind: 'entered' };
  } catch {
    return { kind: 'unavailable', reason: 'denied' };
  }
}

/** Leaves fullscreen if this document is currently in it — a no-op, not an error, when it already is
 *  not, the same "nothing to undo" reading `presentSurfaceLaunch`'s retry gives a launch already
 *  showing. Only reads the two fields it needs, not the `fullscreenchange` wiring `watchFullscreenChange`
 *  owns, so a caller exiting fullscreen never has to fake listeners it will never register. */
export async function leaveFullscreen(
  document: Pick<FullscreenDocumentLike, 'fullscreenElement' | 'exitFullscreen'>,
): Promise<void> {
  if (document.fullscreenElement === null || typeof document.exitFullscreen !== 'function') return;
  try {
    await document.exitFullscreen();
  } catch {
    // The browser refused the exit; watchFullscreenChange still reflects whatever is actually true.
  }
}

/**
 * Reports every fullscreen transition, including ones this module never asked for — a person pressing
 * Escape, or the browser's own fullscreen chrome, both fire `fullscreenchange` without this module
 * having called anything. Returns the unsubscribe function, the same shape a caller needs to tear down
 * any other listener this module wires.
 */
export function watchFullscreenChange(
  document: FullscreenDocumentLike,
  onChange: (state: FullscreenState) => void,
): () => void {
  const listener = (): void => {
    onChange(document.fullscreenElement === null ? { kind: 'exited' } : { kind: 'entered' });
  };
  document.addEventListener('fullscreenchange', listener);
  return () => document.removeEventListener('fullscreenchange', listener);
}

/** The one element a local-output state is shown through, kept as narrow as `SurfaceStatusLike` is in
 *  `output-launch.ts`. Fullscreen and wake-lock state each render into their own instance of this. */
export interface LocalOutputStatusLike {
  textContent: string | null;
}

/** Shows what fullscreen produced. `unavailable` always names the same manual fallback regardless of
 *  why — an absent API and a denied prompt leave a presenter the same next move. */
export function presentFullscreenState(
  status: LocalOutputStatusLike,
  state: FullscreenState,
  locale: Locale,
): void {
  if (state.kind === 'entered') {
    status.textContent = translate(locale, 'localOutput.fullscreen.entered');
    return;
  }
  if (state.kind === 'exited') {
    status.textContent = translate(locale, 'localOutput.fullscreen.exited');
    return;
  }
  status.textContent = translate(
    locale,
    state.reason === 'api-absent' ? 'localOutput.fullscreen.absent' : 'localOutput.fullscreen.denied',
  );
}

// ---------------------------------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------------------------------

/** What a key press moves. This is a separate, narrower concern than `control.ts`'s shortcut catalogue:
 *  that module drives the operator's own control document, this one runs on the output surface itself,
 *  where the only choices a presenter needs without looking away from the audience are forward and
 *  back. */
export interface LocalOutputNavigation {
  readonly next: () => void;
  readonly previous: () => void;
}

/** The one method a keydown listener needs, injected so wiring is testable without a browser. */
export interface KeyboardTargetLike {
  addEventListener(type: 'keydown', listener: (event: { readonly key: string }) => void): void;
  removeEventListener(type: 'keydown', listener: (event: { readonly key: string }) => void): void;
}

const NEXT_KEYS: ReadonlySet<string> = new Set(['ArrowRight', 'ArrowDown', ' ', 'PageDown']);
const PREVIOUS_KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowUp', 'Backspace', 'PageUp']);

/**
 * Wires next/previous to the keys a presenter reaches for without looking at the keyboard — arrows,
 * space, and the paging keys a presentation remote sends. Escape is deliberately not handled here: a
 * browser already exits fullscreen on Escape by itself (`watchFullscreenChange` reports that exit),
 * and handling it again here would only risk fighting that native behavior rather than adding to it.
 * Returns the unsubscribe function.
 */
export function wireLocalOutputKeyboard(
  target: KeyboardTargetLike,
  navigation: LocalOutputNavigation,
): () => void {
  const listener = (event: { readonly key: string }): void => {
    if (NEXT_KEYS.has(event.key)) navigation.next();
    else if (PREVIOUS_KEYS.has(event.key)) navigation.previous();
  };
  target.addEventListener('keydown', listener);
  return () => target.removeEventListener('keydown', listener);
}

// ---------------------------------------------------------------------------------------------------
// Wake lock
// ---------------------------------------------------------------------------------------------------

/** One held wake lock, as far as this module needs it: whether it has already let go, a way to let go
 *  of it deliberately, and the event that fires when the browser lets go of it on its own — losing
 *  visibility, or the system reclaiming it for reasons this API never explains. */
export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/** The one property this client needs from `navigator`, injected for the same reason every other
 *  browser-only surface in this module is. */
export interface WakeLockNavigatorLike {
  readonly wakeLock?: WakeLockLike;
}

/** The one property and event this client needs from `document` to reacquire a lock the browser let go
 *  of when the tab was hidden — a wake lock is always released on that transition, by specification,
 *  and never reacquired by the browser itself. */
export interface VisibilityDocumentLike {
  readonly visibilityState: 'visible' | 'hidden';
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export type WakeLockState =
  | { readonly kind: 'active' }
  | { readonly kind: 'released' }
  | { readonly kind: 'lost' }
  | { readonly kind: 'unavailable'; readonly reason: 'api-absent' | 'denied' };

export interface WakeLockController {
  readonly state: WakeLockState;
  request(): Promise<void>;
  release(): Promise<void>;
  dispose(): void;
}

/**
 * Holds the screen awake for as long as `request` has been called and `release` has not, reacquiring it
 * every time this document becomes visible again while that is still true — the one behavior the test
 * brief calls out by name: reacquisition after a visibility change, not only the first acquisition.
 * Loss is never silent: a sentinel's own `release` event — the browser letting go, for any reason this
 * API does not name — reports `lost` through `onChange` immediately; only a later visibility change
 * tries to win the lock back, exactly as the real API never reacquires on its own.
 *
 * The `sentinel === held` guard in the release listener exists for one reason: a deliberate `release()`
 * call also fires that same event on its way out, and by then this controller has already reported
 * `released` and moved on — that later event must not overwrite it with `lost`.
 */
export function createWakeLockController(
  navigator: WakeLockNavigatorLike,
  document: VisibilityDocumentLike,
  onChange: (state: WakeLockState) => void,
): WakeLockController {
  let sentinel: WakeLockSentinelLike | undefined;
  let desired = false;
  let state: WakeLockState = { kind: 'released' };

  const setState = (next: WakeLockState): void => {
    state = next;
    onChange(next);
  };

  const acquire = async (): Promise<void> => {
    if (navigator.wakeLock === undefined) {
      setState({ kind: 'unavailable', reason: 'api-absent' });
      return;
    }
    try {
      const held = await navigator.wakeLock.request('screen');
      sentinel = held;
      held.addEventListener('release', () => {
        if (sentinel === held) setState({ kind: 'lost' });
      });
      setState({ kind: 'active' });
    } catch {
      setState({ kind: 'unavailable', reason: 'denied' });
    }
  };

  const onVisibilityChange = (): void => {
    if (desired && document.visibilityState === 'visible') void acquire();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    get state() {
      return state;
    },
    async request() {
      desired = true;
      await acquire();
    },
    async release() {
      desired = false;
      const held = sentinel;
      sentinel = undefined;
      if (held !== undefined && !held.released) {
        try {
          await held.release();
        } catch {
          // Already releasing, or the browser refused a second release — either way nothing is held
          // any more from this controller's own point of view.
        }
      }
      setState({ kind: 'released' });
    },
    dispose() {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}

/** Shows what the wake lock is doing right now. `lost` and `unavailable` both say what will, or will
 *  not, happen next — never just that something failed. */
export function presentWakeLockState(
  status: LocalOutputStatusLike,
  state: WakeLockState,
  locale: Locale,
): void {
  switch (state.kind) {
    case 'active':
      status.textContent = translate(locale, 'localOutput.wakeLock.active');
      return;
    case 'released':
      status.textContent = translate(locale, 'localOutput.wakeLock.released');
      return;
    case 'lost':
      status.textContent = translate(locale, 'localOutput.wakeLock.lost');
      return;
    case 'unavailable':
      status.textContent = translate(
        locale,
        state.reason === 'api-absent' ? 'localOutput.wakeLock.absent' : 'localOutput.wakeLock.denied',
      );
  }
}
