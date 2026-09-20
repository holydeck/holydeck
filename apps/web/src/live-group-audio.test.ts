import { describe, expect, it, vi } from 'vitest';

import { correctionForFollower } from '@holydeck/contracts/live-media';

import { createMediaAuthority, createMediaFollower } from './live-media.js';
import { createSlideGroupAudioController } from './live-group-audio.js';

import type { MediaSettings, MediaSurfaceState } from './live-media.js';
import type { SlideGroupAudioSettings } from './live-group-audio.js';

const AT = '2026-09-20T10:00:00.000Z';
const ANCHOR = Date.parse(AT);

const TRACK_SETTINGS: SlideGroupAudioSettings = { durationMs: 300_000, loop: true, muted: false, volume: 0.6 };
const settingsFor = (): SlideGroupAudioSettings => TRACK_SETTINGS;

interface FakeElement {
  currentTime: number;
  loop: boolean;
  muted: boolean;
  volume: number;
  preload: string;
  paused: boolean;
  error: { readonly code: number } | null;
  playCalls: number;
  pauseCalls: number;
  loadCalls: number;
  refuse: 'autoplay' | 'load' | undefined;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(type: 'error', listener: () => void): void;
  removeEventListener(type: 'error', listener: () => void): void;
  fireError(): void;
}

const fakeElement = (): FakeElement => {
  const listeners: (() => void)[] = [];
  return {
    currentTime: 0,
    loop: false,
    muted: false,
    volume: 1,
    preload: 'none',
    paused: true,
    error: null,
    playCalls: 0,
    pauseCalls: 0,
    loadCalls: 0,
    refuse: undefined,
    async play(): Promise<void> {
      this.playCalls += 1;
      if (this.refuse === 'load') {
        this.error = { code: 4 };
        throw new Error('the media resource was not suitable');
      }
      if (this.refuse === 'autoplay') throw new Error('play() failed because the user did not interact first');
      this.paused = false;
    },
    pause(): void {
      this.pauseCalls += 1;
      this.paused = true;
    },
    load(): void {
      this.loadCalls += 1;
      this.error = null;
    },
    addEventListener(_type: 'error', listener: () => void): void {
      listeners.push(listener);
    },
    removeEventListener(_type: 'error', listener: () => void): void {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
    fireError(): void {
      this.error = { code: 4 };
      for (const listener of [...listeners]) listener();
    },
  };
};

const fakeSurface = (): { showMedia: ReturnType<typeof vi.fn<() => void>>; holdLastFrame: ReturnType<typeof vi.fn<() => void>> } => ({
  showMedia: vi.fn<() => void>(),
  holdLastFrame: vi.fn<() => void>(),
});

describe("driving a slide group's backing track off the same authority a single slide's media uses (LIVE-20)", () => {
  it('starts the track the first time a group carrying one is taken live, as an authoritative take', async () => {
    const element = fakeElement();
    const authority = createMediaAuthority(element, fakeSurface(), { now: () => ANCHOR });
    const controller = createSlideGroupAudioController(authority);

    const action = await controller.present({ slideGroupId: 'group-1', audioTrackId: 'hymn-1' }, { at: AT }, settingsFor);

    expect(action).toEqual({ kind: 'start', audioTrackId: 'hymn-1', startAtMs: 0 });
    expect(authority.timeline).toMatchObject({ mediaId: 'hymn-1', playing: true, version: 1 });
    expect(element.playCalls).toBe(1);
  });

  it('does not restart, stop, or reposition the track when the next slide is still in the same group', async () => {
    const element = fakeElement();
    let now = ANCHOR;
    const authority = createMediaAuthority(element, fakeSurface(), { now: () => now });
    const controller = createSlideGroupAudioController(authority);

    await controller.present({ slideGroupId: 'group-1', audioTrackId: 'hymn-1' }, { at: AT }, settingsFor);
    now = ANCHOR + 8_000;
    const action = await controller.present({ slideGroupId: 'group-1', audioTrackId: 'hymn-1' }, { at: AT }, settingsFor);

    expect(action).toEqual({ kind: 'continue' });
    expect(element.playCalls).toBe(1);
    expect(element.pauseCalls).toBe(0);
    expect(authority.timeline?.version).toBe(1);
  });

  it('stops the track on leaving the group and resumes from the stopped position on return, not the start', async () => {
    const element = fakeElement();
    let now = ANCHOR;
    const authority = createMediaAuthority(element, fakeSurface(), { now: () => now });
    const controller = createSlideGroupAudioController(authority);

    await controller.present({ slideGroupId: 'group-1', audioTrackId: 'hymn-1' }, { at: AT }, settingsFor);

    now = ANCHOR + 40_000;
    const leaving = { slideGroupId: 'group-2' };
    const stopAction = await controller.present(leaving, { at: new Date(now).toISOString() }, settingsFor);
    expect(stopAction).toEqual({ kind: 'stop' });
    expect(element.pauseCalls).toBe(1);
    expect(authority.timeline?.playing).toBe(false);
    expect(authority.timeline?.anchorPositionMs).toBe(40_000);

    now = ANCHOR + 90_000;
    const returning = { slideGroupId: 'group-1', audioTrackId: 'hymn-1' };
    const resumeAt = new Date(now).toISOString();
    const startAction = await controller.present(returning, { at: resumeAt }, settingsFor);

    expect(startAction).toEqual({ kind: 'start', audioTrackId: 'hymn-1', startAtMs: 40_000 });
    expect(element.currentTime).toBe(40);
    expect(authority.timeline?.anchorPositionMs).toBe(40_000);
  });

  it('leaves the group audio behind for a follower to reach through the same drift correction T87 already asserts', async () => {
    const authorityElement = fakeElement();
    let now = ANCHOR;
    const authority = createMediaAuthority(authorityElement, fakeSurface(), { now: () => now });
    const controller = createSlideGroupAudioController(authority);
    await controller.present({ slideGroupId: 'group-1', audioTrackId: 'hymn-1' }, { at: AT }, settingsFor);

    now = ANCHOR + 10_000;
    const timeline = authority.timeline;
    if (timeline === undefined) throw new Error('expected a timeline');

    const optedIn = { channel: 'stage' as const, optedIn: true, mediaId: 'hymn-1', positionMs: 10_100, playing: true };
    expect(correctionForFollower(timeline, optedIn, now)).toEqual({ kind: 'in-sync' });

    const optedOut = { ...optedIn, optedIn: false };
    expect(correctionForFollower(timeline, optedOut, now)).toEqual({ kind: 'silent' });

    const drifted = { ...optedIn, positionMs: 3_000 };
    expect(correctionForFollower(timeline, drifted, now)).toMatchObject({ kind: 'adjust', reason: 'drift' });

    // The Control-side half of the same bullet: a seek issued straight on the authority (not through
    // this controller, which never re-decides an in-group move) is what a follower reading the timeline
    // afterward has to reflect.
    authority.seek(20_000);
    const seeked = authority.timeline;
    if (seeked === undefined) throw new Error('expected a timeline');
    expect(correctionForFollower(seeked, { ...optedIn, positionMs: 20_000 }, now)).toEqual({ kind: 'in-sync' });
    expect(correctionForFollower(seeked, optedIn, now)).toMatchObject({ kind: 'adjust', reason: 'drift' });
  });

  it('never lets a local follower action move the authoritative timeline it is reading', async () => {
    const authorityElement = fakeElement();
    const authority = createMediaAuthority(authorityElement, fakeSurface(), { now: () => ANCHOR });
    const controller = createSlideGroupAudioController(authority);
    await controller.present({ slideGroupId: 'group-1', audioTrackId: 'hymn-1' }, { at: AT }, settingsFor);
    const before = authority.timeline;

    const followerElement = fakeElement();
    const follower = createMediaFollower(followerElement, fakeSurface(), { channel: 'stage', now: () => ANCHOR + 1_000 });
    follower.optIn();
    if (authority.timeline === undefined) throw new Error('expected a timeline');
    const followedSettings: MediaSettings = { ...TRACK_SETTINGS, mediaId: 'hymn-1' };
    follower.follow(authority.timeline, followedSettings);
    await follower.synchronize();
    followerElement.pause();
    followerElement.currentTime = 999;

    expect(authority.timeline).toEqual(before);
  });

  it('holds the running track through Standby and Paused, which never call present with a different group', async () => {
    const element = fakeElement();
    const authority = createMediaAuthority(element, fakeSurface(), { now: () => ANCHOR });
    const controller = createSlideGroupAudioController(authority);
    await controller.present({ slideGroupId: 'group-1', audioTrackId: 'hymn-1' }, { at: AT }, settingsFor);

    // A public-output hold (Standby/Paused) touches nothing here because it never presents a different
    // slide group — the same slide's group is what keeps coming back, which this controller already
    // treats as `'continue'`.
    const held = await controller.present({ slideGroupId: 'group-1', audioTrackId: 'hymn-1' }, { at: AT }, settingsFor);

    expect(held).toEqual({ kind: 'continue' });
    expect(element.pauseCalls).toBe(0);
    expect(authority.timeline?.playing).toBe(true);
  });

  it('surfaces a refused autoplay on Control without blocking the decision or the slide navigation', async () => {
    const element = fakeElement();
    element.refuse = 'autoplay';
    const authority = createMediaAuthority(element, fakeSurface(), { now: () => ANCHOR });
    const controller = createSlideGroupAudioController(authority);

    const action = await controller.present({ slideGroupId: 'group-1', audioTrackId: 'hymn-1' }, { at: AT }, settingsFor);

    expect(action).toEqual({ kind: 'start', audioTrackId: 'hymn-1', startAtMs: 0 });
    expect(authority.state.playback).toBe('autoplay-blocked');
    expect(authority.state.recovery).toBe('resume-playback');

    const next = await controller.present({ slideGroupId: 'group-1', audioTrackId: 'hymn-1' }, { at: AT }, settingsFor);
    expect(next).toEqual({ kind: 'continue' });
  });

  it('surfaces a mid-run failure without replacing the authoritative frame or blocking slide navigation', async () => {
    const element = fakeElement();
    const states: MediaSurfaceState[] = [];
    const authority = createMediaAuthority(element, fakeSurface(), { now: () => ANCHOR, onState: (state) => states.push(state) });
    const controller = createSlideGroupAudioController(authority);
    await controller.present({ slideGroupId: 'group-1', audioTrackId: 'hymn-1' }, { at: AT }, settingsFor);

    element.fireError();
    expect(authority.state.playback).toBe('load-error');
    expect(authority.state.fallback).toBe('last-frame');
    expect(states.map((state) => state.playback)).toEqual(['ok', 'load-error']);

    const next = await controller.present({ slideGroupId: 'group-1', audioTrackId: 'hymn-1' }, { at: AT }, settingsFor);
    expect(next).toEqual({ kind: 'continue' });
  });

  it('leaves a group with no track behaving exactly as it does today — zero calls onto the authority', async () => {
    const element = fakeElement();
    const authority = createMediaAuthority(element, fakeSurface(), { now: () => ANCHOR });
    const controller = createSlideGroupAudioController(authority);

    await controller.present({ slideGroupId: 'group-1' }, { at: AT }, settingsFor);
    await controller.present({ slideGroupId: 'group-1' }, { at: AT }, settingsFor);
    const action = await controller.present({ slideGroupId: 'group-2' }, { at: AT }, settingsFor);

    expect(action).toEqual({ kind: 'none' });
    expect(element.playCalls).toBe(0);
    expect(element.pauseCalls).toBe(0);
    expect(authority.timeline).toBeUndefined();
  });
});
