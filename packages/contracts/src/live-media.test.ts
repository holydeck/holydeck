import { describe, expect, it } from 'vitest';

import { OUTPUT_CHANNELS } from './live.js';
import {
  FOLLOWER_CHANNELS,
  MEDIA_AUTHORITY_CHANNEL,
  MEDIA_CLOCK_SAMPLES,
  MEDIA_DRIFT_TOLERANCE_MS,
  MEDIA_PRELOADS,
  beginMediaTimeline,
  correctionForFollower,
  driftMsBetween,
  fallbackFor,
  isFollowerChannel,
  mediaTimelineFromEvent,
  pauseMediaTimeline,
  playMediaTimeline,
  preloadFor,
  projectedMediaPositionMs,
  recoveryFor,
  seekMediaTimeline,
  serverClockOffsetMs,
  slideGroupAudioAction,
} from './live-media.js';

import type {
  FollowerPlayback,
  MediaPlaybackState,
  MediaTimeline,
  PresentedSlideGroup,
  SlideGroupAudioMemory,
} from './live-media.js';

const AT = Date.parse('2026-09-20T10:00:00.000Z');

const timeline = (over: Partial<MediaTimeline> = {}): MediaTimeline => ({
  mediaId: 'clip-1',
  anchorEpochMs: AT,
  anchorPositionMs: 0,
  durationMs: 60_000,
  loop: false,
  playing: true,
  version: 1,
  ...over,
});

const follower = (over: Partial<FollowerPlayback> = {}): FollowerPlayback => ({
  channel: 'stage',
  optedIn: true,
  mediaId: 'clip-1',
  positionMs: 0,
  playing: true,
  ...over,
});

describe('which surface owns the timeline', () => {
  it('names Audience the authority and every other output channel a follower', () => {
    expect(MEDIA_AUTHORITY_CHANNEL).toBe('audience');
    expect(FOLLOWER_CHANNELS).toEqual(['stage', 'singer']);
  });

  it('derives the followers from the channels the live contract already declares', () => {
    expect([MEDIA_AUTHORITY_CHANNEL, ...FOLLOWER_CHANNELS].sort()).toEqual([...OUTPUT_CHANNELS].sort());
  });

  it('reads the authority itself as something that never follows', () => {
    expect(isFollowerChannel('audience')).toBe(false);
    expect(isFollowerChannel('stage')).toBe(true);
    expect(isFollowerChannel('singer')).toBe(true);
  });
});

describe('the failure vocabulary a live surface reports through', () => {
  it('offers a way back from each of the two failures and nothing to do about success', () => {
    expect(recoveryFor('ok')).toBe('none');
    expect(recoveryFor('autoplay-blocked')).toBe('resume-playback');
    expect(recoveryFor('load-error')).toBe('retry-load');
  });

  it('never answers a failure with a blank surface', () => {
    const states: readonly MediaPlaybackState[] = ['ok', 'autoplay-blocked', 'load-error'];
    for (const state of states) expect(['media', 'last-frame']).toContain(fallbackFor(state));
  });

  it('holds the last authoritative frame when the media itself will not load', () => {
    expect(fallbackFor('load-error')).toBe('last-frame');
    // Blocked autoplay still has a picture: the element loaded, it is only paused.
    expect(fallbackFor('autoplay-blocked')).toBe('media');
    expect(fallbackFor('ok')).toBe('media');
  });
});

describe('preload', () => {
  it('always has the authority ready to start the instant a slide goes live', () => {
    expect(preloadFor('audience', false)).toBe('auto');
    expect(preloadFor('audience', true)).toBe('auto');
  });

  it('keeps an opted-out follower at metadata, so opting in mid-run is not a cold start', () => {
    expect(preloadFor('stage', false)).toBe('metadata');
    expect(preloadFor('singer', false)).toBe('metadata');
    expect(preloadFor('stage', true)).toBe('auto');
  });

  it('answers only with a preload a media element actually takes', () => {
    for (const channel of OUTPUT_CHANNELS) {
      for (const optedIn of [true, false]) expect(MEDIA_PRELOADS).toContain(preloadFor(channel, optedIn));
    }
  });
});

describe('the authoritative timeline', () => {
  it('starts at the beginning, playing, at version one', () => {
    const started = beginMediaTimeline({ mediaId: 'clip-1', durationMs: 60_000, loop: false }, AT);
    expect(started).toEqual({
      mediaId: 'clip-1',
      anchorEpochMs: AT,
      anchorPositionMs: 0,
      durationMs: 60_000,
      loop: false,
      playing: true,
      version: 1,
    });
  });

  it('can start part-way in, for a group re-entered where it was left', () => {
    const started = beginMediaTimeline({ mediaId: 'clip-1', durationMs: 60_000, loop: true, startAtMs: 12_000 }, AT);
    expect(started.anchorPositionMs).toBe(12_000);
    expect(started.loop).toBe(true);
  });

  it('refuses a duration or an anchor that is not a number', () => {
    expect(() => beginMediaTimeline({ mediaId: 'clip-1', durationMs: Number.NaN, loop: false }, AT)).toThrow(RangeError);
    expect(() => beginMediaTimeline({ mediaId: 'clip-1', durationMs: 60_000, loop: false }, Number.NaN)).toThrow(RangeError);
    expect(() => beginMediaTimeline({ mediaId: 'clip-1', durationMs: -1, loop: false }, AT)).toThrow(RangeError);
  });

  it('advances with the clock while it is playing', () => {
    expect(projectedMediaPositionMs(timeline(), AT + 5_000)).toBe(5_000);
  });

  it('stands still while it is paused, whatever the clock does', () => {
    const paused = pauseMediaTimeline(timeline(), AT + 5_000);
    expect(projectedMediaPositionMs(paused, AT + 90_000)).toBe(5_000);
    expect(paused.playing).toBe(false);
    expect(paused.version).toBe(2);
  });

  it('wraps a looping clip rather than running past its end', () => {
    const looping = timeline({ loop: true });
    expect(projectedMediaPositionMs(looping, AT + 65_000)).toBe(5_000);
    expect(projectedMediaPositionMs(looping, AT + 180_000)).toBe(0);
  });

  it('stops at the end of a clip that does not loop', () => {
    expect(projectedMediaPositionMs(timeline(), AT + 120_000)).toBe(60_000);
  });

  it('never runs backwards for a surface whose own clock is behind the anchor', () => {
    expect(projectedMediaPositionMs(timeline(), AT - 5_000)).toBe(0);
  });

  it('leaves a clip of unknown length to run on rather than clamping it to nothing', () => {
    expect(projectedMediaPositionMs(timeline({ durationMs: 0 }), AT + 5_000)).toBe(5_000);
  });

  it('refuses to project against a clock reading that is not a number', () => {
    expect(() => projectedMediaPositionMs(timeline(), Number.NaN)).toThrow(RangeError);
  });

  it('resumes from where a pause left it, not from where the clock has since reached', () => {
    const paused = pauseMediaTimeline(timeline(), AT + 5_000);
    const resumed = playMediaTimeline(paused, AT + 95_000);
    expect(resumed.version).toBe(3);
    expect(projectedMediaPositionMs(resumed, AT + 97_000)).toBe(7_000);
  });

  it('treats a transport act that changes nothing as no change at all', () => {
    const playing = timeline();
    expect(playMediaTimeline(playing, AT + 5_000)).toBe(playing);
    const paused = pauseMediaTimeline(playing, AT + 5_000);
    expect(pauseMediaTimeline(paused, AT + 9_000)).toBe(paused);
  });

  it('seeks within the clip and keeps playing from there', () => {
    const sought = seekMediaTimeline(timeline(), 30_000, AT + 5_000);
    expect(sought.version).toBe(2);
    expect(projectedMediaPositionMs(sought, AT + 7_000)).toBe(32_000);
  });

  it('bounds a seek into the clip rather than leaving a surface a position it cannot hold', () => {
    expect(seekMediaTimeline(timeline(), -5_000, AT).anchorPositionMs).toBe(0);
    expect(seekMediaTimeline(timeline(), 90_000, AT).anchorPositionMs).toBe(60_000);
    expect(() => seekMediaTimeline(timeline(), Number.NaN, AT)).toThrow(RangeError);
  });

  it('bounds a seek by nothing at all while the clip length is still unknown', () => {
    // A stream, or a clip whose metadata has not arrived: there is no end to hold a seek short of yet.
    expect(seekMediaTimeline(timeline({ durationMs: 0 }), 90_000, AT).anchorPositionMs).toBe(90_000);
  });

  it('is built from the server-stamped time of the event that put the media live', () => {
    const built = mediaTimelineFromEvent(
      { at: '2026-09-20T10:00:00.000Z' },
      { mediaId: 'clip-1', durationMs: 60_000, loop: true },
    );
    expect(built.anchorEpochMs).toBe(AT);
    expect(built.loop).toBe(true);
    expect(() => mediaTimelineFromEvent({ at: 'not a time' }, { mediaId: 'clip-1', durationMs: 1, loop: false })).toThrow(
      RangeError,
    );
  });
});

describe('a follower correcting itself onto the Audience timeline', () => {
  it('plays nothing at all until this device has opted in', () => {
    expect(correctionForFollower(timeline(), follower({ optedIn: false }), AT + 5_000)).toEqual({ kind: 'silent' });
  });

  it('leaves a follower already in step alone', () => {
    expect(correctionForFollower(timeline(), follower({ positionMs: 5_000 }), AT + 5_000)).toEqual({ kind: 'in-sync' });
  });

  it('tolerates the drift a frame interval and a beat of jitter produce', () => {
    const almost = follower({ positionMs: 5_000 + MEDIA_DRIFT_TOLERANCE_MS });
    expect(correctionForFollower(timeline(), almost, AT + 5_000)).toEqual({ kind: 'in-sync' });
  });

  it('seeks a follower that has drifted past the tolerance back onto the timeline', () => {
    const drifted = follower({ positionMs: 5_000 + MEDIA_DRIFT_TOLERANCE_MS + 1 });
    expect(correctionForFollower(timeline(), drifted, AT + 5_000)).toEqual({
      kind: 'adjust',
      reason: 'drift',
      mediaId: 'clip-1',
      toMs: 5_000,
      playing: true,
    });
  });

  it('catches a follower up after a reconnect it spent away from the session', () => {
    // Thirty seconds off the network, on a ten-minute clip: the anchor alone is enough to land it back
    // on the timeline in one correction, with nothing having been sent to it while it was away.
    const long = timeline({ durationMs: 600_000 });
    const away = follower({ positionMs: 30_000 });
    expect(correctionForFollower(long, away, AT + 60_000)).toEqual({
      kind: 'adjust',
      reason: 'drift',
      mediaId: 'clip-1',
      toMs: 60_000,
      playing: true,
    });
  });

  it('needs no correction for a looping clip whose lap brought the follower back round', () => {
    // A quirk worth stating: a follower exactly one whole lap behind on a looping clip is showing the
    // same frame as the authority, and seeking it would be a stutter with nothing to gain.
    const looping = timeline({ loop: true });
    expect(correctionForFollower(looping, follower({ positionMs: 5_000 }), AT + 185_000)).toEqual({ kind: 'in-sync' });
  });

  it('reads a wrap around the loop point as the small drift it is, not a whole clip of it', () => {
    const looping = timeline({ loop: true });
    // The authority has just wrapped to 100ms; the follower is 200ms short of the end of the same lap.
    const nearlyWrapped = follower({ positionMs: 59_800 });
    expect(driftMsBetween(looping, nearlyWrapped, AT + 60_100)).toBe(300);
    expect(correctionForFollower(looping, nearlyWrapped, AT + 60_100)).toEqual({
      kind: 'adjust',
      reason: 'drift',
      mediaId: 'clip-1',
      toMs: 100,
      playing: true,
    });
  });

  it('still reads a distance as a distance when the file outruns the length it declared', () => {
    // A declared length is a claim, and a file whose real duration runs past its metadata leaves a
    // follower sitting beyond the end of the clip it is supposed to be in. Folded into the lap that is
    // three seconds of drift; subtracted raw it would be a negative number, which every tolerance
    // comparison in this module would read as "close enough" and stop correcting on entirely.
    const looping = timeline({ loop: true });
    const pastTheEnd = follower({ positionMs: 63_000 });
    expect(driftMsBetween(looping, pastTheEnd, AT)).toBe(3_000);
    expect(correctionForFollower(looping, pastTheEnd, AT)).toMatchObject({ kind: 'adjust', reason: 'drift' });
  });

  it('loads the other clip when the authority has moved on to different media', () => {
    const behind = follower({ mediaId: 'clip-0', positionMs: 5_000 });
    expect(correctionForFollower(timeline(), behind, AT + 5_000)).toEqual({
      kind: 'adjust',
      reason: 'media-changed',
      mediaId: 'clip-1',
      toMs: 5_000,
      playing: true,
    });
  });

  it('loads the clip for a follower that has never had one', () => {
    const empty = follower({ mediaId: undefined, positionMs: 0 });
    expect(correctionForFollower(timeline(), empty, AT)).toEqual({
      kind: 'adjust',
      reason: 'media-changed',
      mediaId: 'clip-1',
      toMs: 0,
      playing: true,
    });
  });

  it('pauses a follower still playing after the authority paused, without moving its position', () => {
    const paused = pauseMediaTimeline(timeline(), AT + 5_000);
    const running = follower({ positionMs: 5_000, playing: true });
    expect(correctionForFollower(paused, running, AT + 5_100)).toEqual({
      kind: 'adjust',
      reason: 'transport',
      mediaId: 'clip-1',
      toMs: 5_000,
      playing: false,
    });
  });

  it('calls a follower left behind by a pause a transport act, not a drifting decoder', () => {
    // Both wrong at once: the authority paused five seconds in, and this surface is still running and is
    // nowhere near that position. One correction puts it in both places, and it is named for the decision
    // that caused it rather than for the distance that decision opened up.
    const paused = pauseMediaTimeline(timeline(), AT + 5_000);
    const adrift = follower({ positionMs: 0, playing: true });
    expect(correctionForFollower(paused, adrift, AT + 5_000)).toEqual({
      kind: 'adjust',
      reason: 'transport',
      mediaId: 'clip-1',
      toMs: 5_000,
      playing: false,
    });
  });

  it('takes its own tolerance when a deployment asks for a tighter one', () => {
    const drifted = follower({ positionMs: 5_100 });
    expect(correctionForFollower(timeline(), drifted, AT + 5_000, 50)).toMatchObject({ kind: 'adjust', reason: 'drift' });
    expect(correctionForFollower(timeline(), drifted, AT + 5_000)).toEqual({ kind: 'in-sync' });
  });

  it('never moves the timeline it was handed', () => {
    const authoritative = Object.freeze(timeline());
    const before = { ...authoritative };
    correctionForFollower(authoritative, follower({ positionMs: 90_000, mediaId: 'clip-0' }), AT + 5_000);
    expect(authoritative).toEqual(before);
  });
});

describe('reading the server clock a surface is synchronising against', () => {
  it('reads no samples as no offset, rather than as an offset of unknown sign', () => {
    expect(serverClockOffsetMs([])).toBe(0);
  });

  it('takes the middle sample, so one late beat does not drag the offset with it', () => {
    const samples = [
      { serverAtEpochMs: AT + 40, localAtEpochMs: AT },
      { serverAtEpochMs: AT + 50, localAtEpochMs: AT },
      { serverAtEpochMs: AT + 5_000, localAtEpochMs: AT },
    ];
    expect(serverClockOffsetMs(samples)).toBe(50);
  });

  it('averages the middle pair when the sample count is even', () => {
    const samples = [
      { serverAtEpochMs: AT + 40, localAtEpochMs: AT },
      { serverAtEpochMs: AT + 60, localAtEpochMs: AT },
    ];
    expect(serverClockOffsetMs(samples)).toBe(50);
  });

  it('keeps the sample window odd and small enough to hold for a whole service', () => {
    expect(MEDIA_CLOCK_SAMPLES % 2).toBe(1);
    expect(MEDIA_CLOCK_SAMPLES).toBeLessThanOrEqual(15);
  });
});

describe("deciding what a slide group's backing track does when a slide goes live (LIVE-20)", () => {
  const NO_MEMORY: SlideGroupAudioMemory = {};
  const group = (over: Partial<PresentedSlideGroup> = {}): PresentedSlideGroup => ({
    slideGroupId: 'group-1',
    ...over,
  });

  it('does nothing for a group with no track, entered from nothing before it — the ordinary service', () => {
    expect(slideGroupAudioAction(undefined, group(), NO_MEMORY)).toEqual({ kind: 'none' });
  });

  it('starts a track from the beginning the first time its group is entered', () => {
    const next = group({ audioTrackId: 'clip-1' });
    expect(slideGroupAudioAction(undefined, next, NO_MEMORY)).toEqual({
      kind: 'start',
      audioTrackId: 'clip-1',
      startAtMs: 0,
    });
  });

  it('carries on without a fresh decision when the next slide is still in the same group', () => {
    const previous = group({ audioTrackId: 'clip-1' });
    const next = group({ audioTrackId: 'clip-1' });
    expect(slideGroupAudioAction(previous, next, NO_MEMORY)).toEqual({ kind: 'continue' });
  });

  it('carries on for a same-group move even when the group has no track at all', () => {
    const previous = group();
    const next = group();
    expect(slideGroupAudioAction(previous, next, NO_MEMORY)).toEqual({ kind: 'continue' });
  });

  it('says stop when leaving a group whose track was playing for one with nothing to play', () => {
    const previous = group({ slideGroupId: 'group-1', audioTrackId: 'clip-1' });
    const next = group({ slideGroupId: 'group-2' });
    expect(slideGroupAudioAction(previous, next, NO_MEMORY)).toEqual({ kind: 'stop' });
  });

  it('stays at none when moving between two groups that never had a track', () => {
    const previous = group({ slideGroupId: 'group-1' });
    const next = group({ slideGroupId: 'group-2' });
    expect(slideGroupAudioAction(previous, next, NO_MEMORY)).toEqual({ kind: 'none' });
  });

  it('resumes a returned-to group from where its memory says it was left, not from the start', () => {
    const previous = group({ slideGroupId: 'group-2' });
    const next = group({ slideGroupId: 'group-1', audioTrackId: 'clip-1' });
    const memory: SlideGroupAudioMemory = { 'group-1': 47_000 };
    expect(slideGroupAudioAction(previous, next, memory)).toEqual({
      kind: 'start',
      audioTrackId: 'clip-1',
      startAtMs: 47_000,
    });
  });

  it('starts a track fresh from a group memory has no entry for, even with other groups remembered', () => {
    const previous = group({ slideGroupId: 'group-2' });
    const next = group({ slideGroupId: 'group-3', audioTrackId: 'clip-3' });
    const memory: SlideGroupAudioMemory = { 'group-1': 47_000, 'group-2': 12_000 };
    expect(slideGroupAudioAction(previous, next, memory)).toEqual({
      kind: 'start',
      audioTrackId: 'clip-3',
      startAtMs: 0,
    });
  });

  it('never returns a MediaTimeline itself — only a decision, kept from being mistaken for one', () => {
    const action = slideGroupAudioAction(undefined, group({ audioTrackId: 'clip-1' }), NO_MEMORY);
    expect(action).not.toHaveProperty('anchorEpochMs');
    expect(action).not.toHaveProperty('version');
  });
});
