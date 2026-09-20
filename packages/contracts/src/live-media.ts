// The live media timeline (LIVE-11): which surface owns it, how a surface that does not own it stays on
// it across a reconnect and ordinary drift, and what a surface shows when the media will not play at all.
// This is the pure model alone — no hub, no element, no clock of its own — the same split `live-mode.ts`
// and `live-theme.ts` keep between a rule and whatever later wires a real surface to it.
//
// LIVE-11 settles the authority in one sentence: Stage and phone playback "remains synchronized to the
// Audience timeline ... without granting those views presentation control". So Audience is the authority
// and the other two output channels of `live.ts`'s `OUTPUT_CHANNELS` are followers, and that is expressed
// as a type rather than a convention: `FollowerChannel` excludes the authority, so a call that tries to
// correct Audience onto somebody else's timeline does not compile. Nothing a follower does here returns a
// new `MediaTimeline`; every function that produces one takes the authority's own state and a clock.
//
// There is deliberately no new live event class for any of this, and `live-events.ts` keeps the four
// LIVE-04 names it already has. A timeline is a clock, not a change: publishing a position would move
// `live-protocol.ts`'s `stateRevision` on every sample and make every command an operator had in flight
// stale, which is the opposite of what a live run needs. What a follower needs instead is an *anchor* —
// the server-stamped moment the media went live — and the protocol already carries one on every frame it
// sends: `EventFrame.at` on the `current-slide-changed` that put the slide up, replayed verbatim to a
// resuming client, and `SnapshotFrame.at`/`HeartbeatFrame.at` on the ordinary cadence in between. Every
// surface derives the same timeline from the same anchor, so the Audience picture is the reference the
// others reconstruct rather than a payload anybody has to ship.
//
// `MediaPlaybackState` and `MediaRecovery` live here rather than in `@holydeck/renderer` because both the
// renderer (which prepares a media box) and the web client (which owns a real media element, and does not
// depend on the renderer) have to say the same three words about the same failure. `render-model.ts`
// re-exports them, so the prepared model's vocabulary and the live transport's are one vocabulary.
//
// LIVE-20 (this file, as of T114): a slide group's own backing track is the same media machinery above,
// applied to a coarser unit than a slide. `slideGroupAudioAction` is the only addition this task makes
// here — one more pure decision, not a second timeline model — because a group's track already rides the
// same `MediaTimeline`, the same `MediaAuthority`/`MediaFollower` split, and the same anchor-on-the-frame
// wiring a single slide's media used before it. What is new is only the question of *whether* to touch
// any of that: moving within a group must not, and leaving one that was playing must, and this function
// is where that single decision is made and tested once rather than at every call site.

import { OUTPUT_CHANNELS } from './live.js';

import type { OutputChannel } from './live.js';

// ---------------------------------------------------------------------------------------------------
// Who owns the timeline
// ---------------------------------------------------------------------------------------------------

/** The one surface whose playback is the timeline; every other output channel tracks it. */
export const MEDIA_AUTHORITY_CHANNEL = 'audience' as const satisfies OutputChannel;

/** Stage and Singer — including a musician's or singer's phone, which is Stage on a smaller screen
 *  (LIVE-17). Excluding the authority at the type level is how "without granting those views
 *  presentation control" is kept by the compiler rather than by review. */
export type FollowerChannel = Exclude<OutputChannel, typeof MEDIA_AUTHORITY_CHANNEL>;

export const FOLLOWER_CHANNELS: readonly FollowerChannel[] = Object.freeze(
  OUTPUT_CHANNELS.filter((channel): channel is FollowerChannel => channel !== MEDIA_AUTHORITY_CHANNEL),
);

export const isFollowerChannel = (channel: OutputChannel): channel is FollowerChannel =>
  channel !== MEDIA_AUTHORITY_CHANNEL;

// ---------------------------------------------------------------------------------------------------
// What went wrong, and what is shown while it has
// ---------------------------------------------------------------------------------------------------

/**
 * What the presenting surface saw happen. A pure function cannot observe a browser refusing to autoplay
 * or a file failing to load, so the surface that did observe it hands the fact back in; nothing here goes
 * looking.
 */
export type MediaPlaybackState = 'ok' | 'autoplay-blocked' | 'load-error';

/**
 * What a surface may offer somebody standing in front of a stalled slide. `'none'` is the ordinary case;
 * the other two say which affordance recovers this particular failure, so the surface shows a way back
 * rather than a dead rectangle.
 */
export type MediaRecovery = 'none' | 'resume-playback' | 'retry-load';

const RECOVERY: Readonly<Record<MediaPlaybackState, MediaRecovery>> = Object.freeze({
  ok: 'none',
  'autoplay-blocked': 'resume-playback',
  'load-error': 'retry-load',
});

/** Which affordance gets a stalled slide going again. Every state has one, including the good one. */
export const recoveryFor = (state: MediaPlaybackState): MediaRecovery => RECOVERY[state];

/**
 * What the surface is showing while a playback state stands. There is no third member and there is never
 * going to be one: LIVE-11 asks that a failure be "visible and recoverable", and LIVE-19 says the same
 * thing from the other side — a failure "never replaces the last authoritative frame with an error or
 * blank browser surface". Blocked autoplay still has a picture (the element loaded; it is merely paused),
 * so only a load failure falls back, and it falls back to the frame that was already there.
 */
export type MediaFallback = 'media' | 'last-frame';

export const fallbackFor = (state: MediaPlaybackState): MediaFallback =>
  state === 'load-error' ? 'last-frame' : 'media';

// ---------------------------------------------------------------------------------------------------
// Preload
// ---------------------------------------------------------------------------------------------------

/** The three values a media element's own `preload` attribute takes, in its own spelling. */
export const MEDIA_PRELOADS = ['none', 'metadata', 'auto'] as const;
export type MediaPreload = (typeof MEDIA_PRELOADS)[number];

/**
 * The authority always preloads in full: a slide taken live has to start on the beat, and a cold fetch at
 * that moment is exactly the pause an audience reads as a fault. A follower that has opted in is playing
 * the same media and gets the same treatment. A follower that has not is held at `metadata` rather than
 * `none` — enough to know the clip's length and show its first frame, so opting in mid-service is a seek
 * rather than a cold start, and not so much that every Stage phone in the building pulls a whole video it
 * was never asked to play.
 */
export const preloadFor = (channel: OutputChannel, optedIn: boolean): MediaPreload =>
  channel === MEDIA_AUTHORITY_CHANNEL || optedIn ? 'auto' : 'metadata';

// ---------------------------------------------------------------------------------------------------
// The timeline itself
// ---------------------------------------------------------------------------------------------------

/**
 * Where the authoritative playback is, expressed as an anchor rather than a position: at
 * `anchorEpochMs` the media stood at `anchorPositionMs`, and it has been running since unless `playing`
 * says otherwise. Stated this way a sample never goes stale — a follower that has not heard anything for
 * three minutes still knows exactly where the clip is — which is what makes reconnect recovery arithmetic
 * instead of a request.
 *
 * `version` moves by exactly one on every transport act that changes something, the same one-per-change
 * counter `SurfaceThemeState` carries, so a surface can tell a new decision from a repeated sample.
 */
export interface MediaTimeline {
  readonly mediaId: string;
  readonly anchorEpochMs: number;
  readonly anchorPositionMs: number;
  /** Zero for a clip whose length is not known yet; nothing below clamps or wraps against a zero. */
  readonly durationMs: number;
  readonly loop: boolean;
  readonly playing: boolean;
  readonly version: number;
}

export interface MediaTimelineInput {
  readonly mediaId: string;
  readonly durationMs: number;
  readonly loop: boolean;
  /** Where in the clip this run of it starts — nonzero for a group re-entered where it was left. */
  readonly startAtMs?: number;
}

const finite = (value: number, what: string): number => {
  if (!Number.isFinite(value)) throw new RangeError(`${what} is ${value}, which is not a number`);
  return value;
};

const notNegative = (value: number, what: string): number => {
  if (finite(value, what) < 0) throw new RangeError(`${what} is ${value}, which is before the start of the media`);
  return value;
};

/** A clip taken live: playing, from wherever it was asked to start, at version one. */
export function beginMediaTimeline(input: MediaTimelineInput, atEpochMs: number): MediaTimeline {
  return {
    mediaId: input.mediaId,
    anchorEpochMs: finite(atEpochMs, 'the moment the media went live'),
    anchorPositionMs: notNegative(input.startAtMs ?? 0, 'the position the media starts from'),
    durationMs: notNegative(input.durationMs, "the media's length"),
    loop: input.loop,
    playing: true,
    version: 1,
  };
}

/**
 * The anchor the protocol already carries: the server-stamped `at` of the frame that put this media on
 * screen — an `EventFrame` for a `current-slide-changed`, or the `SnapshotFrame` a resuming client is
 * caught up with. Every surface reads the same string and lands on the same anchor, which is the whole
 * reason no payload and no fifth event class is needed to keep three screens in step.
 */
export function mediaTimelineFromEvent(event: { readonly at: string }, media: MediaTimelineInput): MediaTimeline {
  const at = Date.parse(event.at);
  if (Number.isNaN(at)) throw new RangeError(`${event.at} is not a time this timeline can be anchored to`);
  return beginMediaTimeline(media, at);
}

/** Where the media stands at a given moment. Paused stands still; looping wraps; a clip that does not
 *  loop stops at its end rather than running past it; and a clock reading behind the anchor reads as the
 *  anchor, because a surface whose clock is a little slow must not rewind the service. */
export function projectedMediaPositionMs(timeline: MediaTimeline, nowEpochMs: number): number {
  finite(nowEpochMs, 'the moment being projected to');
  const elapsed = timeline.playing ? Math.max(0, nowEpochMs - timeline.anchorEpochMs) : 0;
  const raw = timeline.anchorPositionMs + elapsed;
  if (timeline.durationMs <= 0) return raw;
  return timeline.loop ? raw % timeline.durationMs : Math.min(raw, timeline.durationMs);
}

/** Re-anchors to right now without moving the position, which is what every transport act below does. */
const reanchored = (timeline: MediaTimeline, positionMs: number, atEpochMs: number, playing: boolean): MediaTimeline => ({
  ...timeline,
  anchorEpochMs: atEpochMs,
  anchorPositionMs: positionMs,
  playing,
  version: timeline.version + 1,
});

/** Resumes from where the pause left it — never from where the clock has since reached. A play on
 *  something already playing changed nothing, so it returns the same timeline and does not move
 *  `version`: a repeated act is not a new decision for a follower to react to. */
export function playMediaTimeline(timeline: MediaTimeline, atEpochMs: number): MediaTimeline {
  if (timeline.playing) return timeline;
  return reanchored(timeline, timeline.anchorPositionMs, finite(atEpochMs, 'the moment playback resumed'), true);
}

/** Freezes the position the clip had reached at this moment. A pause on something already paused is the
 *  same no-change a repeated play is. */
export function pauseMediaTimeline(timeline: MediaTimeline, atEpochMs: number): MediaTimeline {
  if (!timeline.playing) return timeline;
  return reanchored(timeline, projectedMediaPositionMs(timeline, atEpochMs), atEpochMs, false);
}

/** Moves the position and leaves the transport where it was: seeking a playing clip keeps it playing.
 *  The target is bounded into the clip rather than refused, for the same reason the renderer bounds a
 *  volume instead of throwing — an operator dragging past the end asked for the end. */
export function seekMediaTimeline(timeline: MediaTimeline, toMs: number, atEpochMs: number): MediaTimeline {
  finite(toMs, 'the position being sought to');
  const ceiling = timeline.durationMs > 0 ? timeline.durationMs : Number.POSITIVE_INFINITY;
  const bounded = Math.min(Math.max(toMs, 0), ceiling);
  return reanchored(timeline, bounded, finite(atEpochMs, 'the moment of the seek'), timeline.playing);
}

// ---------------------------------------------------------------------------------------------------
// Following it
// ---------------------------------------------------------------------------------------------------

/**
 * How far a follower may be off the authority before it is worth a seek. Below this nothing is done at
 * all: a seek is itself a visible stutter, and correcting a twentieth of a second of jitter every beat
 * would be a worse picture than the drift it is chasing. A quarter of a second is comfortably above a
 * single frame interval at any frame rate this product presents at (17ms at 60fps, 42ms at 24fps) plus
 * the jitter of the heartbeat cadence a correction rides on, and comfortably below the roughly
 * four-hundred-millisecond offset at which a musician watching Stage sees it disagree with Audience.
 *
 * This is a tolerance for *pictures*, and it is deliberately not tight enough for two surfaces to be
 * heard together: a quarter of a second between two audible sources is an echo, not a synchronisation,
 * and no seek-based correction on a cadence this coarse could close it. That is why the browser half
 * starts every follower muted and only this device's own opt-in unmutes it (LIVE-20): a Stage phone with
 * an earpiece is one person's monitor feed, never a second speaker in the room. A deployment that does
 * put two surfaces through one PA passes its own, far tighter, `toleranceMs` below.
 */
export const MEDIA_DRIFT_TOLERANCE_MS = 250;

/** What a follower is doing right now, as its own surface sees itself — never as anybody else sees it. */
export interface FollowerPlayback {
  readonly channel: FollowerChannel;
  /** Set on this device alone (LIVE-20's "opt in device-locally"), and never readable as authority. */
  readonly optedIn: boolean;
  /** Absent for a follower that has never loaded any media. */
  readonly mediaId?: string;
  readonly positionMs: number;
  readonly playing: boolean;
}

/** Why a follower is being moved: it is on different media, it is on the wrong side of a transport act,
 *  or it has simply fallen behind — the three cases a status line has something different to say about. */
export type MediaCorrectionReason = 'media-changed' | 'transport' | 'drift';

/**
 * One whole correction, applied at once: load this media if it is not already loaded, put it here, and
 * have it playing or not. Deliberately not a list of steps — a follower converging over several beats is
 * a follower visibly hunting — and deliberately carrying no way to move the authority.
 */
export type MediaCorrection =
  | { readonly kind: 'in-sync' }
  | { readonly kind: 'silent' }
  | {
      readonly kind: 'adjust';
      readonly reason: MediaCorrectionReason;
      readonly mediaId: string;
      readonly toMs: number;
      readonly playing: boolean;
    };

/**
 * How far off the authority a follower is, measured the short way around a looping clip: a follower two
 * hundred milliseconds short of the end of a lap and an authority a hundred past the start of the next
 * one are three hundred milliseconds apart, not a whole clip apart, and a correction that read it the
 * long way would rewind the follower through the entire video once every lap.
 *
 * The gap is folded into the clip before it is read the short way, because a declared length is only ever
 * a claim: a file whose real duration runs past the metadata leaves a follower sitting beyond the end of
 * the clip it is supposed to be in, and an unfolded subtraction would hand back a negative distance —
 * which every tolerance comparison in this module would read as "close enough" and stop correcting
 * entirely. A distance is never negative, whatever the metadata said.
 */
export function driftMsBetween(timeline: MediaTimeline, follower: FollowerPlayback, nowEpochMs: number): number {
  const target = projectedMediaPositionMs(timeline, nowEpochMs);
  const apart = Math.abs(follower.positionMs - target);
  if (!timeline.loop || timeline.durationMs <= 0) return apart;
  const withinALap = apart % timeline.durationMs;
  return Math.min(withinALap, timeline.durationMs - withinALap);
}

/**
 * The one decision a following surface ever makes about media, and the whole of what LIVE-11 asks of one:
 * track the Audience timeline across reconnect and drift, and do it without ever being able to move it.
 * Reads the authority's timeline and never returns one, so there is no shape this call could take that a
 * caller could mistake for control.
 *
 * Every branch produces one whole correction carrying both a position and a transport, so the order only
 * decides which word explains it — and the order runs most specific first. Different media is not
 * "drift", however far apart the two positions are. A transport act is not "drift" either: a follower
 * still running after the authority paused is a beat behind a decision, not a decoder falling behind, and
 * a status line that called it drift would be telling a musician the wrong thing about a screen they can
 * see. Plain drift is what is left when the media and the transport already agree.
 */
export function correctionForFollower(
  timeline: MediaTimeline,
  follower: FollowerPlayback,
  nowEpochMs: number,
  toleranceMs: number = MEDIA_DRIFT_TOLERANCE_MS,
): MediaCorrection {
  if (!follower.optedIn) return { kind: 'silent' };

  const toMs = projectedMediaPositionMs(timeline, nowEpochMs);
  const adjust = (reason: MediaCorrectionReason): MediaCorrection => ({
    kind: 'adjust',
    reason,
    mediaId: timeline.mediaId,
    toMs,
    playing: timeline.playing,
  });

  if (follower.mediaId !== timeline.mediaId) return adjust('media-changed');
  if (follower.playing !== timeline.playing) return adjust('transport');
  if (driftMsBetween(timeline, follower, nowEpochMs) > toleranceMs) return adjust('drift');
  return { kind: 'in-sync' };
}

// ---------------------------------------------------------------------------------------------------
// The clock a follower projects against
// ---------------------------------------------------------------------------------------------------

/** One reading of the server's clock beside this device's own, taken from the `at` of any frame the
 *  session received — a snapshot on join or resume, or an ordinary heartbeat in between. */
export interface ClockSample {
  readonly serverAtEpochMs: number;
  readonly localAtEpochMs: number;
}

/** How many readings a surface keeps. Odd, so the median below is an actual sample rather than an
 *  average of two, and small, so a three-hour service holds nine of these and not ten thousand. */
export const MEDIA_CLOCK_SAMPLES = 9;

/**
 * How far this device's clock is behind the server's, as a median rather than a mean: a single beat that
 * arrived late is the ordinary condition of a network, and a mean would carry every one of those into
 * every projection afterwards. No samples is answered with no offset — an unknown offset of unknown sign
 * is better assumed zero than guessed at.
 */
export function serverClockOffsetMs(samples: readonly ClockSample[]): number {
  if (samples.length === 0) return 0;
  const offsets = samples.map((sample) => sample.serverAtEpochMs - sample.localAtEpochMs).sort((a, b) => a - b);
  const middle = offsets.length >> 1;
  const lower = offsets[middle - 1] ?? 0;
  const upper = offsets[middle] ?? 0;
  return offsets.length % 2 === 1 ? upper : (lower + upper) / 2;
}

// ---------------------------------------------------------------------------------------------------
// Slide-group backing audio (LIVE-20)
// ---------------------------------------------------------------------------------------------------

/** The one fact this decision needs about whatever is on screen: which group it belongs to, and which
 *  backing track (if any) that group carries. A slide's own content has no bearing on any of this — only
 *  its group does, because `@holydeck/contracts/slide-groups`' `audioTrackId` is a group-level field with
 *  no per-slide override. */
export interface PresentedSlideGroup {
  readonly slideGroupId: string;
  readonly audioTrackId?: string;
}

/** Where a group's track stood, in milliseconds, the moment its group was last left — keyed by
 *  `slideGroupId`. A group never left, or never entered, has no entry, which reads the same as "start
 *  from zero". This map is the caller's to keep: deciding what to do is stateless, but remembering where
 *  a stopped track was is not, and the caller is the one place that already owns a `MediaAuthority` to
 *  read a frozen position back off. */
export type SlideGroupAudioMemory = Readonly<Record<string, number>>;

/**
 * The whole of what taking a slide live decides about its group's backing track. `'none'` is a group with
 * nothing to play, staying that way — the ordinary case, and the only one a track-less service ever sees.
 * `'continue'` is moving between slides inside the same group: deliberately silent about whatever the
 * track is doing, because nothing about it changes. `'stop'` is leaving a group whose track was playing
 * for one with nothing to play; it says a stop is owed, not where the track stopped, because only the
 * caller — holding the live `MediaAuthority` — knows the position playback had actually reached. `'start'`
 * is entering a group with a track, carrying `startAtMs` already resolved from the memory handed in: zero
 * for a first entry, wherever it was left for a return.
 */
export type SlideGroupAudioAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'continue' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'start'; readonly audioTrackId: string; readonly startAtMs: number };

/**
 * The one decision taking a slide live ever makes about its group's backing track, worked out from
 * nothing but which group the previous and the next slide belonged to. Moving within a group is not "the
 * same track re-decided" — it is not decided at all, because `previous` and `next` naming the same
 * `slideGroupId` short-circuits before either one's `audioTrackId` is even read, which is what keeps a
 * mid-song slide advance from so much as glancing at the track, restarting it, or repositioning it.
 *
 * A caller that is actually leaving a group whose track was playing owns the other half of this: freezing
 * the authority and folding the position it had reached into `memory` before calling this function again
 * for wherever the operator goes next, so a `'start'` for a group already visited resumes rather than
 * restarts.
 */
export function slideGroupAudioAction(
  previous: PresentedSlideGroup | undefined,
  next: PresentedSlideGroup,
  memory: SlideGroupAudioMemory,
): SlideGroupAudioAction {
  if (previous !== undefined && previous.slideGroupId === next.slideGroupId) return { kind: 'continue' };
  if (next.audioTrackId === undefined) {
    return previous?.audioTrackId === undefined ? { kind: 'none' } : { kind: 'stop' };
  }
  return { kind: 'start', audioTrackId: next.audioTrackId, startAtMs: memory[next.slideGroupId] ?? 0 };
}
