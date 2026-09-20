import { describe, expect, it, vi } from 'vitest';

import { MEDIA_DRIFT_TOLERANCE_MS, mediaTimelineFromEvent } from '@holydeck/contracts/live-media';
import { LOCALES } from '@holydeck/localization/locales';
import { translate } from '@holydeck/localization/messages';

import {
  applyMediaSettings,
  createMediaAuthority,
  createMediaFollower,
  presentFollowerState,
  presentMediaState,
  watchMediaFailure,
} from './live-media.js';

import type { MediaSettings, MediaStatusLike } from './live-media.js';

const AT = '2026-09-20T10:00:00.000Z';
const ANCHOR = Date.parse(AT);

const settings: MediaSettings = {
  mediaId: 'clip-1',
  durationMs: 60_000,
  loop: true,
  muted: false,
  volume: 0.8,
};

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
  listenerCount(): number;
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
    listenerCount: (): number => listeners.length,
  };
};

const fakeSurface = (): {
  showMedia: ReturnType<typeof vi.fn<() => void>>;
  holdLastFrame: ReturnType<typeof vi.fn<() => void>>;
} => ({
  showMedia: vi.fn<() => void>(),
  holdLastFrame: vi.fn<() => void>(),
});

const status = (): MediaStatusLike => ({ textContent: null });

describe('applying what the item configured', () => {
  it('sets looping, mute, volume and preload on the authoritative surface as asked', () => {
    const element = fakeElement();
    applyMediaSettings(element, settings, { channel: 'audience', optedIn: false });
    expect(element.loop).toBe(true);
    expect(element.muted).toBe(false);
    expect(element.volume).toBe(0.8);
    expect(element.preload).toBe('auto');
  });

  it('keeps a following surface muted until this device opts in, whatever the item asked for', () => {
    const element = fakeElement();
    applyMediaSettings(element, settings, { channel: 'stage', optedIn: false });
    expect(element.muted).toBe(true);
    expect(element.volume).toBe(0.8);
    expect(element.preload).toBe('metadata');
  });

  it('unmutes a following surface once this device has opted in, and preloads it in full', () => {
    const element = fakeElement();
    applyMediaSettings(element, settings, { channel: 'stage', optedIn: true });
    expect(element.muted).toBe(false);
    expect(element.preload).toBe('auto');
  });

  it('leaves an item that asked to be silent silent, even on the authority', () => {
    const element = fakeElement();
    applyMediaSettings(element, { ...settings, muted: true }, { channel: 'audience', optedIn: false });
    expect(element.muted).toBe(true);
  });
});

describe('the Audience surface, which owns the timeline', () => {
  it('anchors the timeline on the server-stamped time of the event that took the slide live', async () => {
    const element = fakeElement();
    const surface = fakeSurface();
    const authority = createMediaAuthority(element, surface, { now: () => ANCHOR });

    await expect(authority.take({ at: AT }, settings)).resolves.toMatchObject({ playback: 'ok', recovery: 'none' });
    expect(authority.timeline).toMatchObject({ mediaId: 'clip-1', anchorEpochMs: ANCHOR, playing: true, version: 1 });
    expect(element.playCalls).toBe(1);
    expect(surface.showMedia).toHaveBeenCalledTimes(1);
  });

  it('holds the position where a pause left it and resumes from there, not from the clock', async () => {
    const element = fakeElement();
    let now = ANCHOR;
    const authority = createMediaAuthority(element, fakeSurface(), { now: () => now });
    await authority.take({ at: AT }, settings);

    now = ANCHOR + 5_000;
    authority.pause();
    expect(element.pauseCalls).toBe(1);
    expect(authority.timeline?.playing).toBe(false);

    now = ANCHOR + 95_000;
    await authority.play();
    expect(authority.timeline?.anchorPositionMs).toBe(5_000);
    expect(authority.timeline?.version).toBe(3);
  });

  it('moves the element and the timeline together on a seek', async () => {
    const element = fakeElement();
    let now = ANCHOR;
    const authority = createMediaAuthority(element, fakeSurface(), { now: () => now });
    await authority.take({ at: AT }, settings);

    now = ANCHOR + 1_000;
    authority.seek(30_000);
    expect(element.currentTime).toBe(30);
    expect(authority.timeline?.anchorPositionMs).toBe(30_000);
  });

  it('does nothing to a surface that has taken no media', async () => {
    const element = fakeElement();
    const authority = createMediaAuthority(element, fakeSurface(), { now: () => ANCHOR });
    authority.pause();
    authority.seek(1_000);
    await expect(authority.play()).resolves.toMatchObject({ playback: 'ok' });
    expect(authority.timeline).toBeUndefined();
    expect(element.playCalls).toBe(0);
    expect(element.pauseCalls).toBe(0);
  });
});

describe('autoplay blocked mid-run', () => {
  it('reads a refused play as blocked autoplay, with a way to resume', async () => {
    const element = fakeElement();
    element.refuse = 'autoplay';
    const surface = fakeSurface();
    const seen: string[] = [];
    const authority = createMediaAuthority(element, surface, {
      now: () => ANCHOR,
      onState: (state) => seen.push(state.playback),
    });

    await expect(authority.take({ at: AT }, settings)).resolves.toEqual({
      playback: 'autoplay-blocked',
      recovery: 'resume-playback',
      fallback: 'media',
    });
    expect(seen).toEqual(['autoplay-blocked']);
    // Blocked autoplay still has a picture: the element loaded and is merely paused.
    expect(surface.showMedia).toHaveBeenCalledTimes(1);
    expect(surface.holdLastFrame).not.toHaveBeenCalled();
  });

  it('recovers on the operator resuming it, without reloading anything', async () => {
    const element = fakeElement();
    element.refuse = 'autoplay';
    const authority = createMediaAuthority(element, fakeSurface(), { now: () => ANCHOR });
    await authority.take({ at: AT }, settings);

    element.refuse = undefined;
    await expect(authority.recover()).resolves.toEqual({ playback: 'ok', recovery: 'none', fallback: 'media' });
    expect(element.loadCalls).toBe(0);
    expect(element.paused).toBe(false);
  });

  it('stays blocked, and stays recoverable, when the browser refuses the resume too', async () => {
    const element = fakeElement();
    element.refuse = 'autoplay';
    const authority = createMediaAuthority(element, fakeSurface(), { now: () => ANCHOR });
    await authority.take({ at: AT }, settings);
    await expect(authority.recover()).resolves.toMatchObject({ playback: 'autoplay-blocked', recovery: 'resume-playback' });
  });

  it('blocks a following surface the same way, without that surface touching the timeline', async () => {
    const element = fakeElement();
    element.refuse = 'autoplay';
    const timeline = mediaTimelineFromEvent({ at: AT }, settings);
    const before = { ...timeline };
    const follower = createMediaFollower(element, fakeSurface(), { channel: 'stage', now: () => ANCHOR });
    follower.optIn();
    follower.follow(timeline, settings);

    await follower.synchronize();
    expect(follower.state.playback).toBe('autoplay-blocked');
    expect(follower.state.recovery).toBe('resume-playback');
    expect(timeline).toEqual(before);
  });
});

describe('a media load failure mid-run', () => {
  it('never leaves the authoritative surface blank', async () => {
    const element = fakeElement();
    element.refuse = 'load';
    const surface = fakeSurface();
    const authority = createMediaAuthority(element, surface, { now: () => ANCHOR });

    await expect(authority.take({ at: AT }, settings)).resolves.toEqual({
      playback: 'load-error',
      recovery: 'retry-load',
      fallback: 'last-frame',
    });
    expect(surface.holdLastFrame).toHaveBeenCalledTimes(1);
    expect(surface.showMedia).not.toHaveBeenCalled();
  });

  it('reports a failure the element raises after it was already playing', () => {
    const element = fakeElement();
    const seen: string[] = [];
    const stop = watchMediaFailure(element, (state) => seen.push(state.playback));
    expect(element.listenerCount()).toBe(1);

    element.fireError();
    expect(seen).toEqual(['load-error']);

    stop();
    expect(element.listenerCount()).toBe(0);
    element.fireError();
    expect(seen).toEqual(['load-error']);
  });

  it('retries the load on the affordance the failure named, and shows the media once it works', async () => {
    const element = fakeElement();
    element.refuse = 'load';
    const surface = fakeSurface();
    const authority = createMediaAuthority(element, surface, { now: () => ANCHOR });
    await authority.take({ at: AT }, settings);

    element.refuse = undefined;
    await expect(authority.recover()).resolves.toEqual({ playback: 'ok', recovery: 'none', fallback: 'media' });
    expect(element.loadCalls).toBe(1);
    expect(surface.showMedia).toHaveBeenCalledTimes(1);
  });

  it('keeps holding the last frame when the retry fails too', async () => {
    const element = fakeElement();
    element.refuse = 'load';
    const surface = fakeSurface();
    const authority = createMediaAuthority(element, surface, { now: () => ANCHOR });
    await authority.take({ at: AT }, settings);
    await expect(authority.recover()).resolves.toMatchObject({ playback: 'load-error', fallback: 'last-frame' });
    expect(surface.holdLastFrame).toHaveBeenCalledTimes(2);
    expect(surface.showMedia).not.toHaveBeenCalled();
  });

  it('has nothing to recover when nothing went wrong', async () => {
    const element = fakeElement();
    const authority = createMediaAuthority(element, fakeSurface(), { now: () => ANCHOR });
    await authority.take({ at: AT }, settings);
    const playsBefore = element.playCalls;
    await expect(authority.recover()).resolves.toMatchObject({ playback: 'ok', recovery: 'none' });
    expect(element.playCalls).toBe(playsBefore);
  });
});

describe('a Stage surface following the Audience timeline', () => {
  const followerOn = (element: FakeElement, now: () => number) =>
    createMediaFollower(element, fakeSurface(), { channel: 'stage', now });

  it('plays nothing at all until this device opts in', async () => {
    const element = fakeElement();
    element.paused = false;
    const follower = followerOn(element, () => ANCHOR + 5_000);
    follower.follow(mediaTimelineFromEvent({ at: AT }, settings), settings);

    await expect(follower.synchronize()).resolves.toEqual({ kind: 'silent' });
    expect(element.muted).toBe(true);
    expect(element.pauseCalls).toBe(1);
    expect(element.playCalls).toBe(0);
  });

  it('loads and places the media the first time this device opts in mid-clip', async () => {
    const element = fakeElement();
    const follower = followerOn(element, () => ANCHOR + 5_000);
    follower.follow(mediaTimelineFromEvent({ at: AT }, settings), settings);
    follower.optIn();

    await expect(follower.synchronize()).resolves.toMatchObject({ kind: 'adjust', reason: 'media-changed' });
    expect(element.currentTime).toBe(5);
    expect(element.muted).toBe(false);
    expect(element.paused).toBe(false);
  });

  it('leaves a follower already in step alone rather than seeking it every beat', async () => {
    const element = fakeElement();
    let now = ANCHOR + 5_000;
    const follower = followerOn(element, () => now);
    follower.follow(mediaTimelineFromEvent({ at: AT }, settings), settings);
    follower.optIn();
    await follower.synchronize();

    const before = element.currentTime;
    now = ANCHOR + 5_000 + MEDIA_DRIFT_TOLERANCE_MS;
    await expect(follower.synchronize()).resolves.toEqual({ kind: 'in-sync' });
    expect(element.currentTime).toBe(before);
  });

  it('seeks a follower that has drifted past the tolerance back onto the Audience position', async () => {
    const element = fakeElement();
    let now = ANCHOR + 5_000;
    const follower = followerOn(element, () => now);
    follower.follow(mediaTimelineFromEvent({ at: AT }, settings), settings);
    follower.optIn();
    await follower.synchronize();

    // The device's own decoder fell a second behind while the clock carried on.
    element.currentTime = 5;
    now = ANCHOR + 6_500;
    await expect(follower.synchronize()).resolves.toMatchObject({ kind: 'adjust', reason: 'drift' });
    expect(element.currentTime).toBe(6.5);
  });

  it('catches up in one step after a reconnect, from the anchor alone', async () => {
    const element = fakeElement();
    let now = ANCHOR + 5_000;
    const follower = followerOn(element, () => now);
    follower.follow(mediaTimelineFromEvent({ at: AT }, { ...settings, loop: false, durationMs: 600_000 }), {
      ...settings,
      loop: false,
      durationMs: 600_000,
    });
    follower.optIn();
    await follower.synchronize();

    // Thirty seconds with no session at all: nothing arrived, and nothing needed to.
    now = ANCHOR + 35_000;
    element.currentTime = 5;
    await expect(follower.synchronize()).resolves.toMatchObject({ kind: 'adjust', reason: 'drift', toMs: 35_000 });
    expect(element.currentTime).toBe(35);
  });

  it('follows a pause the Audience surface made without ever having asked for it', async () => {
    const element = fakeElement();
    let now = ANCHOR;
    const audience = fakeElement();
    const authority = createMediaAuthority(audience, fakeSurface(), { now: () => now });
    await authority.take({ at: AT }, settings);

    const follower = followerOn(element, () => now);
    follower.optIn();
    const started = authority.timeline;
    expect(started).toBeDefined();
    if (started !== undefined) follower.follow(started, settings);
    await follower.synchronize();

    now = ANCHOR + 5_000;
    authority.pause();
    const paused = authority.timeline;
    expect(paused).toBeDefined();
    if (paused !== undefined) follower.follow(paused, settings);
    await expect(follower.synchronize()).resolves.toMatchObject({ kind: 'adjust', reason: 'transport', playing: false });
    expect(element.paused).toBe(true);
    expect(element.currentTime).toBe(5);
  });

  it('reports whether this device has opted in, and nothing about any other one', () => {
    const follower = createMediaFollower(fakeElement(), fakeSurface(), { channel: 'singer', now: () => ANCHOR });
    expect(follower.optedIn).toBe(false);
    follower.optIn();
    expect(follower.optedIn).toBe(true);
    follower.optOut();
    expect(follower.optedIn).toBe(false);
  });

  it('carries no way to move the timeline at all', () => {
    const follower = createMediaFollower(fakeElement(), fakeSurface(), { channel: 'stage', now: () => ANCHOR });
    for (const verb of ['take', 'play', 'pause', 'seek']) {
      expect(follower).not.toHaveProperty(verb);
    }
  });

  it('stays silent while it has been handed no timeline to follow', async () => {
    const element = fakeElement();
    const follower = followerOn(element, () => ANCHOR);
    follower.optIn();
    await expect(follower.synchronize()).resolves.toEqual({ kind: 'silent' });
  });

  it('goes silent again the moment this device opts out', async () => {
    const element = fakeElement();
    const follower = followerOn(element, () => ANCHOR + 1_000);
    follower.follow(mediaTimelineFromEvent({ at: AT }, settings), settings);
    follower.optIn();
    await follower.synchronize();
    expect(element.paused).toBe(false);

    follower.optOut();
    await expect(follower.synchronize()).resolves.toEqual({ kind: 'silent' });
    expect(element.muted).toBe(true);
    expect(element.paused).toBe(true);
  });

  it("projects against the server clock the heartbeats carry, not this phone's own", async () => {
    const element = fakeElement();
    const skewMs = 2_000;
    let serverNow = ANCHOR;
    const follower = followerOn(element, () => serverNow + skewMs);
    follower.follow(mediaTimelineFromEvent({ at: AT }, settings), settings);
    follower.optIn();

    for (const beat of [0, 1, 2]) {
      serverNow = ANCHOR + beat * 1_000;
      follower.observeServerTime(new Date(serverNow).toISOString());
    }
    expect(follower.clockOffsetMs).toBe(-skewMs);

    serverNow = ANCHOR + 5_000;
    await follower.synchronize();
    // Five seconds into the clip, which is where the server says it is — not the seven this phone's
    // own clock would have put it.
    expect(element.currentTime).toBe(5);
  });

  it('ignores a frame time it cannot read, rather than poisoning every projection after it', () => {
    const follower = createMediaFollower(fakeElement(), fakeSurface(), { channel: 'stage', now: () => ANCHOR });
    follower.observeServerTime('not a time at all');
    expect(follower.clockOffsetMs).toBe(0);
  });

  it('keeps only a small, fixed window of clock readings', () => {
    let now = ANCHOR;
    const follower = createMediaFollower(fakeElement(), fakeSurface(), { channel: 'stage', now: () => now });
    for (let beat = 0; beat < 500; beat += 1) {
      now = ANCHOR + beat * 1_000;
      follower.observeServerTime(new Date(now).toISOString());
    }
    expect(follower.sampleCount).toBeLessThanOrEqual(9);
    expect(follower.clockOffsetMs).toBe(0);
  });

  it('lets go of its own failure listener when the surface closes', () => {
    const element = fakeElement();
    const follower = createMediaFollower(element, fakeSurface(), { channel: 'stage', now: () => ANCHOR });
    expect(element.listenerCount()).toBe(1);
    follower.dispose();
    expect(element.listenerCount()).toBe(0);
  });

  it('reports a load failure on its own surface without disturbing the service', () => {
    const element = fakeElement();
    const follower = createMediaFollower(element, fakeSurface(), { channel: 'stage', now: () => ANCHOR });
    element.fireError();
    expect(follower.state).toEqual({ playback: 'load-error', recovery: 'retry-load', fallback: 'last-frame' });
  });
});

describe('what a person standing in front of the surface is told', () => {
  it('names the way back from each failure, in every shipped locale', () => {
    for (const locale of LOCALES) {
      const line = status();
      presentMediaState(line, { playback: 'autoplay-blocked', recovery: 'resume-playback', fallback: 'media' }, locale);
      expect(line.textContent).toBe(translate(locale, 'liveMedia.autoplayBlocked'));

      presentMediaState(line, { playback: 'load-error', recovery: 'retry-load', fallback: 'last-frame' }, locale);
      expect(line.textContent).toBe(translate(locale, 'liveMedia.loadError'));

      presentMediaState(line, { playback: 'ok', recovery: 'none', fallback: 'media' }, locale);
      expect(line.textContent).toBe(translate(locale, 'liveMedia.playing'));
    }
  });

  it('never leaves a failure as silence nobody can explain', () => {
    for (const locale of LOCALES) {
      const line = status();
      presentMediaState(line, { playback: 'load-error', recovery: 'retry-load', fallback: 'last-frame' }, locale);
      expect(line.textContent).not.toBe('');
      expect(line.textContent).not.toBeNull();
    }
  });

  it('tells a following surface which surface it is in step with', () => {
    for (const locale of LOCALES) {
      const view = translate(locale, 'output.channel.audience');
      const line = status();

      presentFollowerState(line, { kind: 'silent' }, locale);
      expect(line.textContent).toBe(translate(locale, 'liveMedia.follower.silent', { view }));

      presentFollowerState(line, { kind: 'in-sync' }, locale);
      expect(line.textContent).toBe(translate(locale, 'liveMedia.follower.synchronized', { view }));

      presentFollowerState(
        line,
        { kind: 'adjust', reason: 'drift', mediaId: 'clip-1', toMs: 1_000, playing: true },
        locale,
      );
      expect(line.textContent).toBe(translate(locale, 'liveMedia.follower.resynchronized', { view }));
    }
  });
});
