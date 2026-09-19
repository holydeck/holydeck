// Launching the three output surfaces — Audience, Stage, Singer — independently of one another and of
// however the operator eventually arranges their screens (spec 9.7). Placement itself, and the saved
// per-device arrangement that remembers which surface goes where, are LIVE-16's build; this module owns
// the narrower LIVE-02 concern underneath it: detect the screens a browser can enumerate, open one
// surface at a time on whichever screen was already chosen for it, and never let a launch fail
// silently. The Window Management API (`getScreenDetails`) is feature-detected rather than assumed,
// because it is still an experimental API this milestone's own capability lab found absent, refused,
// and gesture-starved in roughly equal measure — every one of those outcomes still has to open a
// window, just without the placement the API would have supplied.
//
// Real-device coverage for the two-output DisplayLink configuration this unblocks is T7's
// `hardware/index.json`: seven of its eight protocol steps are recorded `blocked`, naming this task as
// what they were waiting on, and DISC-03 stays open until the maintainer supplies a MacBook Air M1 or a
// Windows 11 machine and the inventoried DisplayLink adapter to run them on
// (`evidence/2026-09-12-hardware-evidence.md`). This module's own tests prove the launch and fallback
// mechanics those steps will exercise; they do not, and cannot yet, stand in for a hardware run nobody
// has taken.

import type { OutputChannel } from '@holydeck/contracts/live';

/** One screen the Window Management API reported, reduced to the four numbers placement needs. */
export interface DetectedScreen {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly isPrimary: boolean;
}

interface ScreenDetailLike {
  readonly availLeft: number;
  readonly availTop: number;
  readonly availWidth: number;
  readonly availHeight: number;
  readonly isPrimary?: boolean;
}

export interface ScreenDetailsLike {
  readonly screens: readonly ScreenDetailLike[];
}

/** The one method this client needs from `window`, injected so detection is testable without a browser. */
export interface WindowManagementLike {
  getScreenDetails?: () => Promise<ScreenDetailsLike>;
}

export type ScreenDetection =
  | { readonly kind: 'detected'; readonly screens: readonly DetectedScreen[] }
  | { readonly kind: 'unavailable'; readonly reason: 'api-absent' | 'permission-denied' };

/**
 * Feature-detects the Window Management API before ever calling it, then reads a refusal and an absent
 * API as the same fact: neither leaves this client anything to place a surface on automatically, and
 * both hand it the same manual fallback. `NotAllowedError` covers a denied permission and a prompt the
 * browser could not put on screen alike — the capability lab found no way to tell those apart from the
 * error alone either — so this module does not try to; it only needs to know that placement is not
 * available right now.
 */
export async function detectScreens(window: WindowManagementLike): Promise<ScreenDetection> {
  if (typeof window.getScreenDetails !== 'function') {
    return { kind: 'unavailable', reason: 'api-absent' };
  }
  try {
    const details = await window.getScreenDetails();
    return {
      kind: 'detected',
      screens: details.screens.map((screen) => ({
        left: screen.availLeft,
        top: screen.availTop,
        width: screen.availWidth,
        height: screen.availHeight,
        isPrimary: screen.isPrimary === true,
      })),
    };
  } catch {
    return { kind: 'unavailable', reason: 'permission-denied' };
  }
}

/** What opening one surface's window produced. `manual` is not a failure: it is the fallback working. */
export type SurfaceLaunch =
  | { readonly kind: 'launched'; readonly view: OutputChannel; readonly placement: 'screen' | 'manual' }
  | { readonly kind: 'blocked'; readonly view: OutputChannel };

/** The one method this client needs from `window` to open a surface, injected for the same reason. */
export interface WindowOpenerLike {
  open(url: string, target: string, features?: string): object | null;
}

const windowName = (view: OutputChannel): string => `holydeck-output-${view}`;

const featuresFor = (screen: DetectedScreen | undefined): string | undefined =>
  screen === undefined
    ? undefined
    : `left=${screen.left},top=${screen.top},width=${screen.width},height=${screen.height}`;

/**
 * Opens one output surface. Audience, Stage and Singer are three separate calls with three separate
 * window names, never a batch: one blocked by the popup policy never keeps the other two from opening.
 * A screen places the window directly; its absence is not a stalled launch, it is the manual fallback —
 * the window still opens, at whatever position the browser defaults to, for the operator to drag onto
 * its screen by hand. `window.open` can also throw rather than return null under a strict enough popup
 * policy; both are read as the same blocked outcome, because the operator's next move is the same
 * either way.
 */
export function launchOutputSurface(
  window: WindowOpenerLike,
  view: OutputChannel,
  url: string,
  screen?: DetectedScreen,
): SurfaceLaunch {
  let opened: object | null;
  try {
    opened = window.open(url, windowName(view), featuresFor(screen));
  } catch {
    opened = null;
  }
  if (opened === null) return { kind: 'blocked', view };
  return { kind: 'launched', view, placement: screen === undefined ? 'manual' : 'screen' };
}

const LABELS: Readonly<Record<OutputChannel, string>> = { audience: 'Audience', stage: 'Stage', singer: 'Singer' };

const launchedText = (view: OutputChannel, placement: 'screen' | 'manual'): string =>
  placement === 'screen'
    ? `${LABELS[view]} opened on its assigned screen.`
    : `${LABELS[view]} opened. Drag this window onto its screen, then use the display's own fullscreen control.`;

const blockedText = (view: OutputChannel): string =>
  `${LABELS[view]} was blocked by the browser's popup policy. Click to open it.`;

/** The two elements one surface's launch state is shown through, kept as narrow as `presentSurfaceLaunch` needs. */
export interface SurfaceStatusLike {
  textContent: string | null;
}

export interface SurfaceRetryLike {
  hidden: boolean;
  onclick: (() => void) | null;
}

export interface SurfaceLaunchControls {
  readonly status: SurfaceStatusLike;
  readonly retry: SurfaceRetryLike;
}

/**
 * Shows what a launch produced, and — for a blocked one — a recoverable state with an explicit action a
 * person takes, never a console warning nobody reading the output sees. `retry` is whatever the caller
 * wants tried again, typically `launchOutputSurface` re-run from the click's own gesture, which is the
 * only kind of gesture a browser will honour a second `window.open` from. `onclick` is assigned rather
 * than added as a listener, so presenting the same controls again replaces the previous retry instead
 * of stacking another one behind it.
 */
export function presentSurfaceLaunch(controls: SurfaceLaunchControls, launch: SurfaceLaunch, retry: () => void): void {
  if (launch.kind === 'blocked') {
    controls.status.textContent = blockedText(launch.view);
    controls.retry.hidden = false;
    controls.retry.onclick = retry;
    return;
  }
  controls.status.textContent = launchedText(launch.view, launch.placement);
  controls.retry.hidden = true;
  controls.retry.onclick = null;
}
