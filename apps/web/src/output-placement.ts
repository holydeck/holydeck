// Operator-chosen placement of the output surfaces (LIVE-21): which named screen Audience, Stage and
// Singer each go to, exchanging two of them in one action, and the capability every window that opens is
// given. It owns exactly that — the assignment an operator makes, the freshly issued capability the
// window it opens presents, and the report of whether the assignment was applied or not.
//
// It owns none of the three things underneath it, and calls each of them through the surface its own
// task published rather than reaching into it. Detecting screens and opening one window on one of them
// is T80's `output-launch.ts`; the per-device saved arrangement, and reopening every surface from it, is
// T89's `output-arrangements.ts`; issuing and revoking a capability is T32's `capability-routes.ts`,
// reached over the paths `@holydeck/contracts/live` names for both sides. Nothing here re-implements
// screen detection, window features, storage keys or capability minting.
//
// It also deliberately owns nothing of the authoritative live state. There is no import of
// `live-client.ts` here and no command is ever issued from this module: moving a window between screens
// is a local window-management concern plus one HTTP authorization, and an operator dragging Audience to
// another monitor must not be able to move the service's mode, position or content by doing it. What the
// public output is showing while a window moves is whatever the last authoritative frame left there.
//
// Two rules hold everything else together:
//
//   1. Nothing is recorded that did not happen. A surface's assignment changes only when a window
//      actually opened, so a refused capability, a blocked popup or a screen that is no longer there
//      leaves the arrangement exactly as it was — and the placement is reported as unapplied.
//   2. A window never opens on a screen nobody chose for it. Every way a placement can fail degrades to
//      T80's manual fallback — the same unplaced window that function already opens when no screen was
//      assigned at all — never to some other screen that happened to be available.

import { OUTPUT_CAPABILITY_PATH, OUTPUT_CHANNELS, type OutputChannel, capabilityPath } from '@holydeck/contracts/live';
import { type Parsed, parseObject } from '@holydeck/contracts/problems';
import { type MessageKey, translate } from '@holydeck/localization/messages';

import { ask } from './api.js';
import { loadArrangement, previewArrangement, reopenArrangement, saveArrangement } from './output-arrangements.js';
import { launchOutputSurface } from './output-launch.js';

import type { FetchLike } from './api.js';
import type { ArrangedSurface, StorageLike } from './output-arrangements.js';
import type {
  DetectedScreen,
  ScreenDetection,
  SurfaceLaunch,
  SurfaceLaunchControls,
  WindowOpenerLike,
} from './output-launch.js';
import type { Locale } from '@holydeck/localization/locales';

/** What an output window was opened holding: one capability, good for one surface, issued for this open. */
export interface IssuedCapability {
  readonly view: OutputChannel;
  readonly capabilityId: string;
  readonly token: string;
  readonly expiresAt: string;
}

/** A capability a window no longer presents, and whether the server agreed to take it back. */
export interface ReleasedCapability {
  readonly capability: IssuedCapability;
  readonly revoked: boolean;
}

/**
 * Why an assignment was not applied. The first two are the server's answer and are the only ones that
 * open no window at all; the last four each still leave the operator a window, placed by hand, which is
 * what "degrades to the manual fallback" means here.
 */
export type PlacementRefusal =
  | { readonly kind: 'not-authorized'; readonly code: string; readonly message: string }
  | { readonly kind: 'not-issued'; readonly message: string }
  | { readonly kind: 'detection-unavailable'; readonly reason: 'api-absent' | 'permission-denied' }
  | { readonly kind: 'screen-absent' }
  | { readonly kind: 'unassigned' }
  | { readonly kind: 'blocked' };

/**
 * What one surface's placement did. `applied` is the whole answer to "did the assignment take effect":
 * true only when this window opened on the screen it was assigned, and false — with a `refusal` naming
 * why — every other time, including the times a window did open, unplaced.
 */
export interface SurfacePlacement {
  readonly view: OutputChannel;
  readonly applied: boolean;
  readonly screen?: DetectedScreen;
  /** Which of the currently detected screens this is, counted from one, so it can be named back. */
  readonly screenNumber?: number;
  /** Absent only where nothing was opened at all — a refusal from the server. */
  readonly launch?: SurfaceLaunch;
  readonly capability?: IssuedCapability;
  readonly released?: ReleasedCapability;
  readonly refusal?: PlacementRefusal;
}

export interface OutputPlacementOptions {
  readonly window: WindowOpenerLike;
  readonly fetching: FetchLike;
  /** Which service the capabilities are issued against. */
  readonly service: string;
  /** The session's CSRF token, held in memory by the client exactly as `api.ts` expects it to be. */
  readonly csrf: string;
  /** When the capability issued for the next window should lapse. Called once per issue, never cached. */
  readonly expiresAt: () => string;
  /** Where one surface is served, holding the capability it was opened with. */
  readonly urlFor: (view: OutputChannel, token: string) => string;
}

export interface OutputPlacement {
  /** Where each surface's window currently is, in `OUTPUT_CHANNELS` order — T89's own shape. */
  assignments(): readonly ArrangedSurface[];
  /** The capability the window showing this surface was opened with, if one is open. */
  holding(view: OutputChannel): IssuedCapability | undefined;
  /** Assigns one surface to one detected screen and opens it there. `undefined` unassigns it. */
  place(view: OutputChannel, screen: DetectedScreen | undefined, detection: ScreenDetection): Promise<SurfacePlacement>;
  /** Swaps two surfaces' screens in one action. */
  exchange(
    first: OutputChannel,
    second: OutputChannel,
    detection: ScreenDetection,
  ): Promise<readonly SurfacePlacement[]>;
  /** Saves the current assignments as this device's named arrangement, through T89. */
  save(storage: StorageLike, deviceId: string, name: string): void;
  /** Reopens every surface from this device's named arrangement, through T89. Empty when there is none. */
  reopen(
    storage: StorageLike,
    deviceId: string,
    name: string,
    detection: ScreenDetection,
  ): Promise<readonly SurfacePlacement[]>;
}

// ---------------------------------------------------------------------------------------------------
// Screens, and naming them
// ---------------------------------------------------------------------------------------------------

// The same by-geometry comparison `output-arrangements.ts` matches a saved screen with, three lines of
// it, rather than an export added to that module for this one's sake.
const sameScreen = (a: DetectedScreen, b: DetectedScreen): boolean =>
  a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

const screensOf = (detection: ScreenDetection): readonly DetectedScreen[] =>
  detection.kind === 'detected' ? detection.screens : [];

const numberOf = (detection: ScreenDetection, screen: DetectedScreen): number | undefined => {
  const index = screensOf(detection).findIndex((candidate) => sameScreen(candidate, screen));
  return index < 0 ? undefined : index + 1;
};

const nameOf = (locale: Locale, screen: DetectedScreen, number: number): string =>
  translate(locale, screen.isPrimary ? 'placement.screen.primary' : 'placement.screen.secondary', {
    // Passed as text rather than as numbers: these are a screen's own pixel dimensions, which no locale
    // groups into thousands the way it groups a count of something.
    number: String(number),
    width: String(screen.width),
    height: String(screen.height),
  });

/** One detected screen, with the name an operator picks it by. */
export interface NamedScreen {
  readonly screen: DetectedScreen;
  readonly name: string;
}

/**
 * The screens there are to assign a surface to, named and numbered in the order they were detected. A
 * browser that listed none offers nothing to choose between — which is the honest state, not an error:
 * every surface then opens through the manual fallback.
 */
export function namedScreens(detection: ScreenDetection, locale: Locale): readonly NamedScreen[] {
  return screensOf(detection).map((screen, index) => ({ screen, name: nameOf(locale, screen, index + 1) }));
}

// ---------------------------------------------------------------------------------------------------
// Where a surface is being asked to go
// ---------------------------------------------------------------------------------------------------

/** One surface's resolved destination: the screen it will actually be placed on, or why it will not be. */
interface Target {
  readonly screen?: DetectedScreen;
  readonly number?: number;
  readonly refusal?: PlacementRefusal;
}

const resolveTarget = (screen: DetectedScreen | undefined, detection: ScreenDetection): Target => {
  if (screen === undefined) return { refusal: { kind: 'unassigned' } };
  if (detection.kind !== 'detected') {
    return { refusal: { kind: 'detection-unavailable', reason: detection.reason } };
  }
  const found = detection.screens.find((candidate) => sameScreen(candidate, screen));
  if (found === undefined) return { refusal: { kind: 'screen-absent' } };
  return { screen: found, number: numberOf(detection, found) };
};

// ---------------------------------------------------------------------------------------------------
// The capability a window is opened with
// ---------------------------------------------------------------------------------------------------

interface IssuedBody {
  readonly token: string;
  readonly capabilityId: string;
  readonly view: OutputChannel;
  readonly expiresAt: string;
}

const parseIssued = (value: unknown): Parsed<IssuedBody> =>
  parseObject(value, 'outputCapability', (reader) => ({
    token: reader.text('token'),
    capabilityId: reader.text('capabilityId'),
    view: reader.choice('view', OUTPUT_CHANNELS),
    expiresAt: reader.time('expiresAt'),
  }));

type Issue =
  | { readonly ok: true; readonly capability: IssuedCapability }
  | { readonly ok: false; readonly refusal: PlacementRefusal };

type IssuedEach =
  | { readonly ok: true; readonly issued: readonly IssuedCapability[] }
  | { readonly ok: false; readonly refusal: PlacementRefusal };

// ---------------------------------------------------------------------------------------------------
// Placing the surfaces
// ---------------------------------------------------------------------------------------------------

export function createOutputPlacement(options: OutputPlacementOptions): OutputPlacement {
  const { window, fetching, service, csrf, expiresAt, urlFor } = options;

  /** Where each surface's window actually is. Written only after a window has opened there. */
  const assigned = new Map<OutputChannel, DetectedScreen | undefined>();
  /** What each surface's open window is presenting. */
  const held = new Map<OutputChannel, IssuedCapability>();

  const issue = async (view: OutputChannel): Promise<Issue> => {
    const result = await ask(OUTPUT_CAPABILITY_PATH, fetching, {
      method: 'POST',
      csrf,
      body: { service, view, expiresAt: expiresAt() },
    });
    if (!result.ok) {
      return { ok: false, refusal: { kind: 'not-authorized', code: result.code, message: result.message } };
    }
    const parsed = parseIssued(result.data);
    if (!parsed.ok) {
      const message = parsed.problems.map((problem) => `${problem.path} ${problem.message}`).join('; ');
      return { ok: false, refusal: { kind: 'not-issued', message } };
    }
    // The view the server issued for is checked against the view asked for, rather than assumed: a
    // window must never be opened holding a capability scoped to a surface other than the one it shows.
    if (parsed.value.view !== view) {
      return { ok: false, refusal: { kind: 'not-issued', message: `outputCapability.view is ${parsed.value.view}` } };
    }
    const { token, capabilityId } = parsed.value;
    return { ok: true, capability: { view, capabilityId, token, expiresAt: parsed.value.expiresAt } };
  };

  const revoke = async (capability: IssuedCapability): Promise<ReleasedCapability> => {
    const result = await ask(capabilityPath(capability.capabilityId), fetching, { method: 'DELETE', csrf });
    return { capability, revoked: result.ok };
  };

  /**
   * What one opened window means for the arrangement. A blocked popup opened nothing, so nothing here
   * moves: the window that surface already had is still the one showing it, still presenting the
   * capability it was opened with, and the one just issued is given straight back rather than left
   * outstanding for a window that does not exist.
   */
  const adopt = async (
    view: OutputChannel,
    target: Target,
    capability: IssuedCapability,
    launch: SurfaceLaunch,
  ): Promise<SurfacePlacement> => {
    if (launch.kind === 'blocked') {
      await revoke(capability);
      return { view, applied: false, launch, refusal: { kind: 'blocked' } };
    }
    const previous = held.get(view);
    held.set(view, capability);
    assigned.set(view, target.screen);
    const released = previous === undefined ? undefined : await revoke(previous);
    return {
      view,
      applied: target.screen !== undefined,
      screen: target.screen,
      screenNumber: target.number,
      launch,
      capability,
      released,
      refusal: target.refusal,
    };
  };

  const openOn = async (view: OutputChannel, target: Target, capability: IssuedCapability): Promise<SurfacePlacement> =>
    adopt(view, target, capability, launchOutputSurface(window, view, urlFor(view, capability.token), target.screen));

  const unauthorized = (views: readonly OutputChannel[], refusal: PlacementRefusal): readonly SurfacePlacement[] =>
    views.map((view) => ({ view, applied: false, refusal }));

  /**
   * Issues every capability an action needs before the action opens anything. One refused capability
   * means the whole action is refused — nothing is opened, and whatever was already issued for it is
   * given back rather than left outstanding.
   */
  const issueEach = async (views: readonly OutputChannel[]): Promise<IssuedEach> => {
    const issued: IssuedCapability[] = [];
    for (const view of views) {
      const result = await issue(view);
      if (!result.ok) {
        for (const capability of issued) await revoke(capability);
        return { ok: false, refusal: result.refusal };
      }
      issued.push(result.capability);
    }
    return { ok: true, issued };
  };

  const capabilityFor = (issued: readonly IssuedCapability[], view: OutputChannel): IssuedCapability => {
    const capability = issued.find((candidate) => candidate.view === view);
    // Unreachable: `issueEach` is called with exactly the views read back here, and refuses as a whole
    // otherwise. Refusing loudly still beats opening a window on a token this client does not have.
    if (capability === undefined) throw new Error(`no capability was issued for ${view}`);
    return capability;
  };

  return {
    assignments: (): readonly ArrangedSurface[] =>
      OUTPUT_CHANNELS.map((view) => ({ view, screen: assigned.get(view) })),

    holding: (view: OutputChannel): IssuedCapability | undefined => held.get(view),

    place: async (view, screen, detection): Promise<SurfacePlacement> => {
      const target = resolveTarget(screen, detection);
      const issued = await issue(view);
      if (!issued.ok) return { view, applied: false, refusal: issued.refusal };
      return openOn(view, target, issued.capability);
    },

    exchange: async (first, second, detection): Promise<readonly SurfacePlacement[]> => {
      // Both destinations are read off the arrangement as it stands *before* anything moves, so neither
      // surface is ever computed against a state the other one has already changed.
      const targets = [
        { view: first, target: resolveTarget(assigned.get(second), detection) },
        { view: second, target: resolveTarget(assigned.get(first), detection) },
      ];
      const views = targets.map((entry) => entry.view);
      const issued = await issueEach(views);
      if (!issued.ok) return unauthorized(views, issued.refusal);
      const placements: SurfacePlacement[] = [];
      for (const { view, target } of targets) {
        placements.push(await openOn(view, target, capabilityFor(issued.issued, view)));
      }
      return placements;
    },

    save: (storage, deviceId, name): void => {
      // The saved record is positional — Audience, Stage, Singer — and an array cannot carry a hole
      // through storage, so it ends at the first surface with no screen. A surface left out of it
      // reopens through the manual fallback, which is exactly what an unassigned surface does anyway.
      const screens: DetectedScreen[] = [];
      for (const view of OUTPUT_CHANNELS) {
        const screen = assigned.get(view);
        if (screen === undefined) break;
        screens.push(screen);
      }
      saveArrangement(storage, deviceId, name, screens);
    },

    reopen: async (storage, deviceId, name, detection): Promise<readonly SurfacePlacement[]> => {
      const arrangement = loadArrangement(storage, deviceId, name);
      if (arrangement === undefined) return [];
      const issued = await issueEach(OUTPUT_CHANNELS);
      if (!issued.ok) return unauthorized(OUTPUT_CHANNELS, issued.refusal);

      const arranged = previewArrangement(arrangement, detection);
      const launches = reopenArrangement(window, arrangement, detection, (view) =>
        urlFor(view, capabilityFor(issued.issued, view).token),
      );

      const placements: SurfacePlacement[] = [];
      for (const [index, entry] of arranged.entries()) {
        const saved = arrangement.screens[index];
        const launch = launches[index];
        // `previewArrangement` and `reopenArrangement` are the same walk over `OUTPUT_CHANNELS`, so
        // this only guards the types, never a case T89 can actually produce.
        if (launch === undefined) continue;
        const target: Target =
          entry.screen === undefined
            ? { refusal: refusalForMissing(saved, detection) }
            : { screen: entry.screen, number: numberOf(detection, entry.screen) };
        placements.push(await adopt(entry.view, target, capabilityFor(issued.issued, entry.view), launch));
      }
      return placements;
    },
  };
}

/** Why a saved surface came back without a screen: none was ever saved, none was listed, or it is gone. */
const refusalForMissing = (saved: DetectedScreen | undefined, detection: ScreenDetection): PlacementRefusal => {
  if (saved === undefined) return { kind: 'unassigned' };
  if (detection.kind !== 'detected') return { kind: 'detection-unavailable', reason: detection.reason };
  return { kind: 'screen-absent' };
};

// ---------------------------------------------------------------------------------------------------
// Showing what a placement did
// ---------------------------------------------------------------------------------------------------

// The same three role words `output-launch.ts` and `output-arrangements.ts` each name locally, for the
// same reason they do: a label read from a shared catalog, not an internal reached for across modules.
const CHANNEL_MESSAGE_KEY: Readonly<Record<OutputChannel, MessageKey>> = {
  audience: 'output.channel.audience',
  stage: 'output.channel.stage',
  singer: 'output.channel.singer',
};

const UNAPPLIED_MESSAGE_KEY: Readonly<Record<PlacementRefusal['kind'], MessageKey>> = {
  'not-authorized': 'placement.unapplied.notAuthorized',
  'not-issued': 'placement.unapplied.notIssued',
  'detection-unavailable': 'placement.unapplied.detection',
  'screen-absent': 'placement.unapplied.screenAbsent',
  unassigned: 'placement.unapplied.unassigned',
  blocked: 'placement.unapplied.blocked',
};

/** The two refusals a second attempt can actually clear: a popup policy, and an answer nobody could read. */
const RETRYABLE: readonly PlacementRefusal['kind'][] = ['blocked', 'not-issued'];

const placementText = (locale: Locale, placement: SurfacePlacement): string => {
  const view = translate(locale, CHANNEL_MESSAGE_KEY[placement.view]);
  const { refusal, screen, screenNumber } = placement;
  if (refusal !== undefined) return translate(locale, UNAPPLIED_MESSAGE_KEY[refusal.kind], { view });
  if (screen === undefined || screenNumber === undefined) {
    // Unreachable from this module: a placement carrying no refusal landed on a detected screen.
    return translate(locale, 'placement.unapplied.unassigned', { view });
  }
  return translate(locale, 'placement.applied', { view, screen: nameOf(locale, screen, screenNumber) });
};

/**
 * Shows what a placement did, through the same two controls `presentSurfaceLaunch` shows a launch
 * through — so an operator reads one status line per surface, whichever of the two wrote it. The retry
 * is offered only for the refusals a second attempt can clear: a session that may not control the
 * presentation gets an explanation, not a button that will refuse it again.
 */
export function presentPlacement(
  controls: SurfaceLaunchControls,
  placement: SurfacePlacement,
  retry: () => void,
  locale: Locale,
): void {
  controls.status.textContent = placementText(locale, placement);
  const retryable = placement.refusal !== undefined && RETRYABLE.includes(placement.refusal.kind);
  controls.retry.hidden = !retryable;
  controls.retry.onclick = retryable ? retry : null;
}
