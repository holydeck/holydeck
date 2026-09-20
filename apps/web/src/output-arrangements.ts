// Saved output arrangements (LIVE-16): a named, per-device record of which screen each output surface
// last opened on, and the one action that reopens every surface against it. `output-launch.ts` already
// solved screen detection and window placement (T80); this module adds nothing to either — it only
// remembers, per device, what `detectScreens` reported when an operator was happy with where things
// landed, and hands that straight back through `launchOutputSurface` the next time the service runs.
//
// Persisted client-side (spec 9.7's own ruling), keyed by a device identifier this module creates the
// first time one is asked for and reads back unchanged after that: an arrangement describes the screens
// physically attached to one machine, never something with meaning transplanted to another device, so
// there is no server collection or migration surface here to own.
//
// A screen a saved arrangement names is not guaranteed to still be there next time — a laptop undocked,
// a monitor swapped — so every surface this module reopens is matched against whatever `detectScreens`
// reports right now, by position and size, and a surface whose saved screen is gone opens through
// `launchOutputSurface`'s own manual fallback exactly as if no screen had ever been assigned to it. That
// fallback is not reimplemented here; it is the same `launchOutputSurface(window, view, url)` call
// without a screen that T80 already proved degrades to a plain, unplaced window rather than failing.
//
// Explicit per-surface reassignment — choosing which named screen a surface goes to — is a later task's
// domain (T115); this module only ever assigns Audience, Stage and Singer to whatever was detected, in
// that fixed order, because that is what "save what is there now" means without inventing a UI this
// task does not own.

import { OUTPUT_CHANNELS, type OutputChannel } from '@holydeck/contracts/live';
import type { Locale } from '@holydeck/localization/locales';
import { translate, type MessageKey } from '@holydeck/localization/messages';

import { launchOutputSurface } from './output-launch.js';

import type { DetectedScreen, ScreenDetection, SurfaceLaunch, WindowOpenerLike } from './output-launch.js';

/**
 * One saved, named record of the screens an arrangement opened its surfaces on last time, in
 * `OUTPUT_CHANNELS` order: `screens[0]` is Audience's screen, `screens[1]` is Stage's, `screens[2]` is
 * Singer's. Fewer than three simply means that surface was never assigned one — it always opens through
 * the manual fallback, the same outcome a screen that was assigned and later went away gets.
 */
export interface SavedArrangement {
  readonly name: string;
  readonly screens: readonly DetectedScreen[];
}

/**
 * What `previewArrangement` and `reopenArrangement` agree one surface will do: place on the screen it
 * was saved with, if that screen is still there, or fall back to manual placement if it is not — the
 * same two outcomes `launchOutputSurface` itself distinguishes.
 */
export interface ArrangedSurface {
  readonly view: OutputChannel;
  readonly screen?: DetectedScreen;
}

// ---------------------------------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------------------------------

/** The two methods this module needs from `localStorage`, injected so persistence is testable without
 *  a browser — the same reason `output-launch.ts` injects `WindowOpenerLike`. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The one method this module prefers for generating a device id, injected because it is optional even
 *  in a real browser: older engines carry `crypto` without `randomUUID`. */
export interface IdSourceLike {
  randomUUID?: () => string;
}

const DEVICE_ID_KEY = 'holydeck.deviceId';

const generateId = (source: IdSourceLike): string =>
  typeof source.randomUUID === 'function'
    ? source.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * The device identifier every saved arrangement is keyed by, created the first time anything asks for
 * one and read back unchanged after that. Create-if-absent means a caller never has to know, or care,
 * whether this is the first run on this device.
 */
export function getDeviceId(storage: StorageLike, idSource: IdSourceLike = {}): string {
  const existing = storage.getItem(DEVICE_ID_KEY);
  if (existing !== null && existing !== '') return existing;
  const created = generateId(idSource);
  storage.setItem(DEVICE_ID_KEY, created);
  return created;
}

// ---------------------------------------------------------------------------------------------------
// Save and load
// ---------------------------------------------------------------------------------------------------

const arrangementsKey = (deviceId: string): string => `holydeck.output-arrangements.${deviceId}`;

const isDetectedScreen = (value: unknown): value is DetectedScreen => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DetectedScreen>;
  return (
    typeof candidate.left === 'number' &&
    typeof candidate.top === 'number' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number' &&
    typeof candidate.isPrimary === 'boolean'
  );
};

const isArrangementMap = (value: unknown): value is Record<string, readonly DetectedScreen[]> =>
  typeof value === 'object' &&
  value !== null &&
  Object.values(value as Record<string, unknown>).every(
    (screens) => Array.isArray(screens) && screens.every(isDetectedScreen),
  );

/** Malformed or hand-edited storage is read as if nothing were saved yet, never thrown — the same
 *  "never fail opaquely" rule `output-launch.ts` applies to a denied screen-detection prompt. */
function readArrangements(storage: StorageLike, deviceId: string): Record<string, readonly DetectedScreen[]> {
  const raw = storage.getItem(arrangementsKey(deviceId));
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isArrangementMap(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Saves one named arrangement for this device, replacing any earlier save under the same name. Every
 *  other name this device already saved, and every other device's own saves, are left untouched. */
export function saveArrangement(
  storage: StorageLike,
  deviceId: string,
  name: string,
  screens: readonly DetectedScreen[],
): void {
  const all = readArrangements(storage, deviceId);
  storage.setItem(arrangementsKey(deviceId), JSON.stringify({ ...all, [name]: screens }));
}

/** The one arrangement named, for this device — `undefined` if this device never saved one by that
 *  name. */
export function loadArrangement(storage: StorageLike, deviceId: string, name: string): SavedArrangement | undefined {
  const screens = readArrangements(storage, deviceId)[name];
  return screens === undefined ? undefined : { name, screens };
}

/** Every arrangement this device has saved, for whatever list a caller shows an operator choosing
 *  from. */
export function listArrangements(storage: StorageLike, deviceId: string): readonly SavedArrangement[] {
  return Object.entries(readArrangements(storage, deviceId)).map(([name, screens]) => ({ name, screens }));
}

// ---------------------------------------------------------------------------------------------------
// Preview and reopen
// ---------------------------------------------------------------------------------------------------

const sameScreen = (a: DetectedScreen, b: DetectedScreen): boolean =>
  a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

/**
 * What reopening this arrangement would do right now, without opening anything: one entry per output
 * surface, each carrying the screen it will place on if that screen is still among what `detection`
 * currently reports, or no screen at all if it is not. `reopenArrangement` promises to do exactly what
 * this says — a caller can show this preview and trust the reopen it precedes.
 */
export function previewArrangement(
  arrangement: SavedArrangement,
  detection: ScreenDetection,
): readonly ArrangedSurface[] {
  const available = detection.kind === 'detected' ? detection.screens : [];
  return OUTPUT_CHANNELS.map((view, index) => {
    const saved = arrangement.screens[index];
    const screen = saved === undefined ? undefined : available.find((candidate) => sameScreen(candidate, saved));
    return { view, screen };
  });
}

/**
 * Reopens every output surface this arrangement names in one call — Audience, Stage and Singer each
 * through their own `launchOutputSurface`, so one blocked by the popup policy still never blocks the
 * others, exactly as T80 already guarantees. A surface whose saved screen is no longer among what
 * `detection` reports opens through that same function's manual fallback rather than failing: this is
 * the one place `previewArrangement`'s prediction turns into an actual window.
 */
export function reopenArrangement(
  window: WindowOpenerLike,
  arrangement: SavedArrangement,
  detection: ScreenDetection,
  urlFor: (view: OutputChannel) => string,
): readonly SurfaceLaunch[] {
  return previewArrangement(arrangement, detection).map(({ view, screen }) =>
    launchOutputSurface(window, view, urlFor(view), screen),
  );
}

// ---------------------------------------------------------------------------------------------------
// Presenting a preview
// ---------------------------------------------------------------------------------------------------

// The same role-word catalog `output-launch.ts` reads Audience/Stage/Singer's display names from —
// duplicated as one three-line map rather than imported, so this module never has to edit that file's
// internals just to reach a label it already owns.
const CHANNEL_MESSAGE_KEY: Readonly<Record<OutputChannel, MessageKey>> = {
  audience: 'output.channel.audience',
  stage: 'output.channel.stage',
  singer: 'output.channel.singer',
};

/** The one element a preview entry is shown through, kept as narrow as `SurfaceStatusLike` is in
 *  `output-launch.ts`. */
export interface ArrangementPreviewStatusLike {
  textContent: string | null;
}

/**
 * Shows what one preview entry means for an operator deciding whether to click reopen — the same two
 * outcomes `previewArrangement` distinguishes, worded for someone who has not opened anything yet rather
 * than for someone reading what already happened (`presentSurfaceLaunch`'s job, once it has).
 */
export function presentArrangementPreview(
  status: ArrangementPreviewStatusLike,
  entry: ArrangedSurface,
  locale: Locale,
): void {
  const view = translate(locale, CHANNEL_MESSAGE_KEY[entry.view]);
  status.textContent = translate(
    locale,
    entry.screen === undefined ? 'arrangement.preview.manual' : 'arrangement.preview.screen',
    { view },
  );
}
