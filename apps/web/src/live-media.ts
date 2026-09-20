// Live video and audio on a real surface (LIVE-11): the browser half of `@holydeck/contracts/live-media`.
// That module decides where the media should be and what a failure means; this one owns the media element
// those decisions are applied to, and is the only place a `play()` promise is ever awaited.
//
// Two controllers, deliberately asymmetric, because LIVE-11's own sentence is asymmetric: Stage and phone
// playback "remains synchronized to the Audience timeline ... without granting those views presentation
// control". `createMediaAuthority` is the Audience surface and carries the transport — take, play, pause,
// seek — and is the only thing here that ever produces a `MediaTimeline`. `createMediaFollower` is Stage
// or Singer and carries none of those verbs at all: it reads a timeline, corrects its own element onto it,
// and has no shape a caller could mistake for a way to move the service. Opting in is device-local
// (LIVE-20's wording) and lives entirely inside the follower, so it is not a thing the authority can even
// observe, let alone be moved by.
//
// Neither controller sends anything. A follower needs no payload from the authority, because the anchor it
// projects from is the server-stamped `at` the live protocol already puts on every frame — see the header
// of `@holydeck/contracts/live-media` for why that, rather than a fifth live event class, is what carries
// the timeline. `observeServerTime` is the other half of that: a surface projecting against its own clock
// would be out by however far that clock is wrong, and a phone in a building is routinely seconds out, so
// the ordinary heartbeat cadence is read as clock samples and the offset is subtracted from every
// projection.
//
// Every browser surface is injected as a `*Like` interface for the same reason `local-output.ts` injects
// its fullscreen and wake-lock ones: a real media pipeline is never called untested, and the two failures
// this module exists to survive — a refused autoplay and a file that will not load — are exactly the ones
// a real browser will not reproduce on demand.

import {
  MEDIA_CLOCK_SAMPLES,
  correctionForFollower,
  fallbackFor,
  mediaTimelineFromEvent,
  pauseMediaTimeline,
  playMediaTimeline,
  preloadFor,
  projectedMediaPositionMs,
  recoveryFor,
  seekMediaTimeline,
  serverClockOffsetMs,
} from '@holydeck/contracts/live-media';
import { translate } from '@holydeck/localization/messages';

import type {
  ClockSample,
  FollowerChannel,
  MediaCorrection,
  MediaFallback,
  MediaPlaybackState,
  MediaRecovery,
  MediaTimeline,
} from '@holydeck/contracts/live-media';
import type { OutputChannel } from '@holydeck/contracts/live';
import type { Locale } from '@holydeck/localization/locales';
import type { LocalOutputStatusLike } from './local-output.js';

/** What an element says went wrong, reduced to the one field that tells a failed load apart from a
 *  refused autoplay: a browser sets `error` for the first and leaves it null for the second. */
export interface MediaErrorLike {
  readonly code: number;
}

/**
 * The subset of a media element this client actually drives. `currentTime` is in seconds because that is
 * what the DOM uses and this is the boundary where the DOM's units stop; everything above is milliseconds,
 * the way every other time in this repository is.
 */
export interface MediaElementLike {
  currentTime: number;
  loop: boolean;
  muted: boolean;
  volume: number;
  preload: string;
  readonly paused: boolean;
  readonly error: MediaErrorLike | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(type: 'error', listener: () => void): void;
  removeEventListener(type: 'error', listener: () => void): void;
}

/**
 * The surface the element sits on, as far as this module needs it. Its whole reason for existing is the
 * half of LIVE-11 a media element cannot keep by itself: a file that will not load must not leave a hole
 * where the service was, so the surface is told to hold what it was already showing rather than being
 * left to render an empty rectangle.
 */
export interface MediaSurfaceLike {
  /** The media element itself is what this surface shows. */
  showMedia(): void;
  /** Hold whatever was on screen before this media — never a blank frame, never an error page. */
  holdLastFrame(): void;
}

/** What the item configured, already bounded by the renderer (`PreparedMediaAudio`): this module applies
 *  these, it does not second-guess them. */
export interface MediaSettings {
  readonly mediaId: string;
  readonly durationMs: number;
  readonly loop: boolean;
  readonly muted: boolean;
  readonly volume: number;
}

/** Which surface this is, and — for a following one — whether this device has opted in to playing. */
export interface MediaRole {
  readonly channel: OutputChannel;
  readonly optedIn: boolean;
}

/** Everything a surface has to say about its media at one moment: what happened, what recovers it, and
 *  what is on screen while it stands. */
export interface MediaSurfaceState {
  readonly playback: MediaPlaybackState;
  readonly recovery: MediaRecovery;
  readonly fallback: MediaFallback;
}

/** Structurally the one-property status line `local-output.ts` already renders its states into, named for
 *  this module's own use rather than declared a second time. */
export type MediaStatusLike = LocalOutputStatusLike;

const stateOf = (playback: MediaPlaybackState): MediaSurfaceState =>
  Object.freeze({ playback, recovery: recoveryFor(playback), fallback: fallbackFor(playback) });

const OK = stateOf('ok');

/**
 * Applies looping, mute, volume and preload. Mute is the one setting a following surface overrides: every
 * Stage, Singer and phone output starts silent whatever the item asked for, and only this device's own
 * opt-in unmutes it (LIVE-20). The volume is set either way, so opting in mid-song arrives at the item's
 * own level rather than at whatever the element happened to hold.
 */
export function applyMediaSettings(element: MediaElementLike, settings: MediaSettings, role: MediaRole): void {
  element.loop = settings.loop;
  element.volume = settings.volume;
  element.preload = preloadFor(role.channel, role.optedIn);
  element.muted = role.channel === 'audience' ? settings.muted : settings.muted || !role.optedIn;
}

/**
 * Starts playback and reads what the browser did about it. A rejected `play()` is two different facts
 * wearing one rejection: the element carries an `error` when the media itself failed to load, and carries
 * none when the browser simply would not start it without a gesture. Telling them apart here is what lets
 * the surface offer the right way back instead of one apology for both.
 */
const playing = async (element: MediaElementLike): Promise<MediaPlaybackState> => {
  try {
    await element.play();
    return 'ok';
  } catch {
    return element.error === null ? 'autoplay-blocked' : 'load-error';
  }
};

/** Shows the media, or holds the last authoritative frame — never nothing. */
const settle = (surface: MediaSurfaceLike, playback: MediaPlaybackState): MediaSurfaceState => {
  const state = stateOf(playback);
  if (state.fallback === 'last-frame') surface.holdLastFrame();
  else surface.showMedia();
  return state;
};

/** Reports a failure the element raised on its own, after whatever started it had already returned —
 *  a network that dropped mid-clip, a file that decoded part-way and stopped. Returns the unsubscribe. */
export function watchMediaFailure(element: MediaElementLike, onState: (state: MediaSurfaceState) => void): () => void {
  const listener = (): void => onState(stateOf('load-error'));
  element.addEventListener('error', listener);
  return () => element.removeEventListener('error', listener);
}

// ---------------------------------------------------------------------------------------------------
// The Audience surface
// ---------------------------------------------------------------------------------------------------

export interface MediaAuthorityOptions {
  /** This device's own clock, in epoch milliseconds. Explicit, so a test never reads a real one. */
  readonly now: () => number;
  readonly onState?: (state: MediaSurfaceState) => void;
}

/**
 * The Audience surface: the one place a `MediaTimeline` is ever produced or moved. Every method here is a
 * transport act, and none of them exists on `MediaFollower`.
 */
export interface MediaAuthority {
  /** Where the authoritative playback stands, for whatever renders a Control transport bar — and the
   *  value a following surface reconstructs for itself from the same live event. */
  readonly timeline: MediaTimeline | undefined;
  readonly state: MediaSurfaceState;
  /** A slide carrying media went live. `event.at` is the server-stamped time of the live event that took
   *  it there, which is what every other surface anchors the same timeline on. */
  take(event: { readonly at: string }, settings: MediaSettings): Promise<MediaSurfaceState>;
  play(): Promise<MediaSurfaceState>;
  pause(): void;
  seek(toMs: number): void;
  /** The affordance the current failure named: resume blocked playback, or load the media again. */
  recover(): Promise<MediaSurfaceState>;
  dispose(): void;
}

export function createMediaAuthority(
  element: MediaElementLike,
  surface: MediaSurfaceLike,
  options: MediaAuthorityOptions,
): MediaAuthority {
  const role: MediaRole = { channel: 'audience', optedIn: true };
  let timeline: MediaTimeline | undefined;
  let settings: MediaSettings | undefined;
  let state = OK;

  const moveTo = (next: MediaSurfaceState): MediaSurfaceState => {
    state = next;
    options.onState?.(next);
    return next;
  };

  const start = async (): Promise<MediaSurfaceState> => moveTo(settle(surface, await playing(element)));

  const stop = watchMediaFailure(element, (failed) => moveTo(settle(surface, failed.playback)));

  return Object.freeze({
    get timeline() {
      return timeline;
    },
    get state() {
      return state;
    },

    async take(event: { readonly at: string }, taken: MediaSettings): Promise<MediaSurfaceState> {
      settings = taken;
      timeline = mediaTimelineFromEvent(event, taken);
      applyMediaSettings(element, taken, role);
      element.currentTime = timeline.anchorPositionMs / 1_000;
      return start();
    },

    async play(): Promise<MediaSurfaceState> {
      if (timeline === undefined) return state;
      timeline = playMediaTimeline(timeline, options.now());
      return start();
    },

    pause(): void {
      if (timeline === undefined) return;
      timeline = pauseMediaTimeline(timeline, options.now());
      element.pause();
    },

    seek(toMs: number): void {
      if (timeline === undefined) return;
      timeline = seekMediaTimeline(timeline, toMs, options.now());
      element.currentTime = timeline.anchorPositionMs / 1_000;
    },

    async recover(): Promise<MediaSurfaceState> {
      if (state.recovery === 'none' || settings === undefined) return state;
      if (state.recovery === 'retry-load') {
        element.load();
        applyMediaSettings(element, settings, role);
        if (timeline !== undefined) {
          element.currentTime = projectedMediaPositionMs(timeline, options.now()) / 1_000;
        }
      }
      return start();
    },

    dispose(): void {
      stop();
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// A Stage or Singer surface
// ---------------------------------------------------------------------------------------------------

export interface MediaFollowerOptions {
  readonly channel: FollowerChannel;
  /** This device's own clock. Corrected by `observeServerTime` before anything is projected against it. */
  readonly now: () => number;
  /** Overrides `MEDIA_DRIFT_TOLERANCE_MS` for a deployment that needs a tighter or looser one. */
  readonly toleranceMs?: number;
  readonly onState?: (state: MediaSurfaceState) => void;
}

/**
 * A following surface. Note what is absent: there is no `take`, no `play`, no `pause`, no `seek`, and
 * nothing here returns a `MediaTimeline`. That absence is the requirement — this view tracks the Audience
 * timeline and cannot move it — and it is checked by this module's own test rather than left to review.
 */
export interface MediaFollower {
  readonly optedIn: boolean;
  readonly state: MediaSurfaceState;
  /** How far this device's clock is behind the server's, from the frame times it has seen. */
  readonly clockOffsetMs: number;
  /** How many clock readings are being held — bounded, so a three-hour service does not accumulate. */
  readonly sampleCount: number;
  /** This device alone decides to play. Nothing about this reaches the authority or any other surface. */
  optIn(): void;
  optOut(): void;
  /** One server-stamped frame time — a snapshot on join or resume, or an ordinary heartbeat. */
  observeServerTime(serverAt: string): void;
  /** The authoritative timeline as this surface reconstructed it from the live event that carried it. */
  follow(timeline: MediaTimeline, settings: MediaSettings): void;
  /** One correction step, driven by the session's own cadence rather than by a timer of this module's. */
  synchronize(): Promise<MediaCorrection>;
  dispose(): void;
}

export function createMediaFollower(
  element: MediaElementLike,
  surface: MediaSurfaceLike,
  options: MediaFollowerOptions,
): MediaFollower {
  const samples: ClockSample[] = [];
  let optedIn = false;
  let timeline: MediaTimeline | undefined;
  let settings: MediaSettings | undefined;
  /** Which media this element actually holds — undefined until a correction has put one there, which is
   *  what makes the first beat after opting in a load rather than a seek. */
  let loaded: string | undefined;
  let state = OK;

  const moveTo = (next: MediaSurfaceState): MediaSurfaceState => {
    state = next;
    options.onState?.(next);
    return next;
  };

  const stop = watchMediaFailure(element, (failed) => moveTo(failed));

  const offset = (): number => serverClockOffsetMs(samples);
  const role = (): MediaRole => ({ channel: options.channel, optedIn });

  /** Silence: muted, and stopped where it stands. Never a seek — a surface playing nothing has no
   *  position worth arguing about, and moving it would only be a visible twitch. */
  const silence = (): void => {
    element.muted = true;
    if (!element.paused) element.pause();
  };

  const apply = async (correction: MediaCorrection): Promise<void> => {
    if (correction.kind === 'in-sync') return;
    if (correction.kind === 'silent') {
      silence();
      return;
    }
    if (settings !== undefined) applyMediaSettings(element, settings, role());
    loaded = correction.mediaId;
    element.currentTime = correction.toMs / 1_000;
    if (!correction.playing) {
      if (!element.paused) element.pause();
      moveTo(settle(surface, 'ok'));
      return;
    }
    moveTo(settle(surface, await playing(element)));
  };

  return Object.freeze({
    get optedIn() {
      return optedIn;
    },
    get state() {
      return state;
    },
    get clockOffsetMs() {
      return offset();
    },
    get sampleCount() {
      return samples.length;
    },

    optIn(): void {
      optedIn = true;
    },

    optOut(): void {
      optedIn = false;
    },

    observeServerTime(serverAt: string): void {
      const serverAtEpochMs = Date.parse(serverAt);
      // A frame time this build cannot read is dropped rather than recorded as an offset of NaN, which
      // would otherwise poison every projection made for the rest of the service.
      if (Number.isNaN(serverAtEpochMs)) return;
      samples.push({ serverAtEpochMs, localAtEpochMs: options.now() });
      while (samples.length > MEDIA_CLOCK_SAMPLES) samples.shift();
    },

    follow(next: MediaTimeline, followed: MediaSettings): void {
      timeline = next;
      settings = followed;
    },

    async synchronize(): Promise<MediaCorrection> {
      if (timeline === undefined) {
        silence();
        return { kind: 'silent' };
      }
      const correction = correctionForFollower(
        timeline,
        {
          channel: options.channel,
          optedIn,
          ...(loaded === undefined ? {} : { mediaId: loaded }),
          // Read off the element rather than modelled here, so a decoder that quietly fell behind is
          // caught as the drift it is instead of being assumed to be where it was told to go.
          positionMs: element.currentTime * 1_000,
          playing: !element.paused,
        },
        options.now() + offset(),
        options.toleranceMs,
      );
      await apply(correction);
      return correction;
    },

    dispose(): void {
      stop();
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// What is shown about it
// ---------------------------------------------------------------------------------------------------

const PLAYBACK_MESSAGES = Object.freeze({
  ok: 'liveMedia.playing',
  'autoplay-blocked': 'liveMedia.autoplayBlocked',
  'load-error': 'liveMedia.loadError',
} as const);

/** Says what the media is doing, and — for either failure — what recovers it. A failure is never left as
 *  unexplained silence on a surface somebody is standing in front of. */
export function presentMediaState(status: MediaStatusLike, state: MediaSurfaceState, locale: Locale): void {
  status.textContent = translate(locale, PLAYBACK_MESSAGES[state.playback]);
}

const FOLLOWER_MESSAGES = Object.freeze({
  silent: 'liveMedia.follower.silent',
  'in-sync': 'liveMedia.follower.synchronized',
  adjust: 'liveMedia.follower.resynchronized',
} as const);

/** Says which surface this one is in step with, by name, so a musician reading Stage knows what its
 *  picture is being held against rather than being told only that something synchronised. */
export function presentFollowerState(status: MediaStatusLike, correction: MediaCorrection, locale: Locale): void {
  const view = translate(locale, 'output.channel.audience');
  status.textContent = translate(locale, FOLLOWER_MESSAGES[correction.kind], { view });
}
