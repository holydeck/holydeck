// The sustained-session budget of specification 14.4: "at least a three-hour normal session including
// media and reconnect behavior". A three-hour service is where the cheap version of media synchronisation
// falls over — a per-beat offset that slowly rots, a correction history nobody trims, a decoder whose
// quarter-percent slip is invisible at one minute and forty seconds out at three hours — so the whole run
// is played here at heartbeat cadence against a media element that slips, drops off the network twice, is
// refused an autoplay once, and loses its file once.
//
// Nothing is mocked away: the same `createMediaAuthority` and `createMediaFollower` a real surface uses
// are driven beat by beat, and the properties asserted are the ones that would actually be noticed in a
// building — the Stage picture never more than the tolerance from the Audience one after a beat, the
// retained state never growing, and the authoritative timeline never versioning on anything but an actual
// transport act.

import { describe, expect, it } from 'vitest';

import { MEDIA_CLOCK_SAMPLES, MEDIA_DRIFT_TOLERANCE_MS, driftMsBetween } from '@holydeck/contracts/live-media';

import { createMediaAuthority, createMediaFollower } from './live-media.js';

import type { MediaSettings } from './live-media.js';

const AT = '2026-09-20T09:00:00.000Z';
const ANCHOR = Date.parse(AT);

/** Three hours, the floor specification 14.4 sets for a sustained presentation test. */
const SESSION_MS = 3 * 60 * 60 * 1_000;
/** The cadence a correction rides on: the session's own heartbeat, not a timer this module owns. */
const BEAT_MS = 5_000;
const BEATS = SESSION_MS / BEAT_MS;

/** A six-minute loop, so the clip wraps thirty times across the service and the wrap arithmetic is
 *  exercised rather than assumed. */
const settings: MediaSettings = {
  mediaId: 'ambient-loop',
  durationMs: 360_000,
  loop: true,
  muted: false,
  volume: 0.7,
};

/**
 * A media element that behaves like one: it advances while it plays, wraps on loop, and runs a quarter of
 * a percent slow, which is the ordinary condition of a decoder on a phone and amounts to twenty-seven
 * seconds of drift across this session if nothing corrects it.
 */
const slippingElement = (slip: number) => {
  const listeners: (() => void)[] = [];
  return {
    currentTime: 0,
    loop: false,
    muted: false,
    volume: 1,
    preload: 'none',
    paused: true,
    error: null as { readonly code: number } | null,
    refuse: undefined as 'autoplay' | 'load' | undefined,
    async play(): Promise<void> {
      if (this.refuse === 'load') {
        this.error = { code: 4 };
        throw new Error('the media resource was not suitable');
      }
      if (this.refuse === 'autoplay') throw new Error('play() failed because the user did not interact first');
      this.paused = false;
    },
    pause(): void {
      this.paused = true;
    },
    load(): void {
      this.error = null;
    },
    addEventListener(_type: 'error', listener: () => void): void {
      listeners.push(listener);
    },
    removeEventListener(_type: 'error', listener: () => void): void {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
    /** What the browser does between beats while nobody is looking. */
    advance(ms: number): void {
      if (this.paused) return;
      const next = this.currentTime + (ms * slip) / 1_000;
      this.currentTime = this.loop ? next % (settings.durationMs / 1_000) : next;
    },
  };
};

const noSurface = () => ({ showMedia: () => undefined, holdLastFrame: () => undefined });

describe('a three-hour service with media on it', () => {
  it('keeps Stage on the Audience timeline across the whole session, its drift, and two reconnects', async () => {
    const startedAt = Date.now();
    let now = ANCHOR;

    const audience = slippingElement(1);
    const authority = createMediaAuthority(audience, noSurface(), { now: () => now });
    await authority.take({ at: AT }, settings);

    const stage = slippingElement(0.9975);
    const follower = createMediaFollower(stage, noSurface(), { channel: 'stage', now: () => now });
    follower.optIn();

    // The two stretches this Stage phone spends off the network: twenty minutes in it loses the room's
    // wifi for four minutes, and an hour and a half in it is put in a pocket for ten.
    const away = (beat: number): boolean => {
      const atMs = beat * BEAT_MS;
      return (atMs >= 20 * 60_000 && atMs < 24 * 60_000) || (atMs >= 90 * 60_000 && atMs < 100 * 60_000);
    };

    let corrections = 0;
    let worstDriftAfterABeat = 0;
    let caughtUpAfterReconnect = 0;
    let wasAway = false;

    for (let beat = 1; beat <= BEATS; beat += 1) {
      now = ANCHOR + beat * BEAT_MS;
      audience.advance(BEAT_MS);
      stage.advance(BEAT_MS);

      if (away(beat)) {
        // Nothing arrives, and nothing is sent: a follower off the network is simply not corrected.
        wasAway = true;
        continue;
      }

      follower.observeServerTime(new Date(now).toISOString());
      const timeline = authority.timeline;
      expect(timeline).toBeDefined();
      if (timeline === undefined) return;
      follower.follow(timeline, settings);

      const correction = await follower.synchronize();
      if (correction.kind === 'adjust') corrections += 1;
      if (wasAway) {
        // One beat back on the network is all it takes: the anchor alone says where the clip is, so the
        // ten minutes away cost nothing but the ten minutes.
        expect(correction.kind).toBe('adjust');
        caughtUpAfterReconnect += 1;
        wasAway = false;
      }

      const drift = driftMsBetween(
        timeline,
        { channel: 'stage', optedIn: true, mediaId: settings.mediaId, positionMs: stage.currentTime * 1_000, playing: !stage.paused },
        now,
      );
      worstDriftAfterABeat = Math.max(worstDriftAfterABeat, drift);
      expect(drift).toBeLessThanOrEqual(MEDIA_DRIFT_TOLERANCE_MS);
    }

    // Both gaps were closed on the first beat back.
    expect(caughtUpAfterReconnect).toBe(2);
    // A slipping decoder is corrected repeatedly across three hours, and each correction is one seek.
    expect(corrections).toBeGreaterThan(10);
    // Retained state does not grow with the service: nine clock readings at the end, as at the start.
    expect(follower.sampleCount).toBeLessThanOrEqual(MEDIA_CLOCK_SAMPLES);
    // The authoritative timeline never versioned: three hours of beats carry no transport act, which is
    // the point of anchoring on a frame time rather than publishing a position.
    expect(authority.timeline?.version).toBe(1);
    expect(worstDriftAfterABeat).toBeLessThanOrEqual(MEDIA_DRIFT_TOLERANCE_MS);
    // A three-hour service costs a fraction of a second to simulate; anything near a minute here would
    // mean per-beat work that a real session would pay for in a warm phone and a flat battery.
    expect(Date.now() - startedAt).toBeLessThan(30_000);

    follower.dispose();
    authority.dispose();
  });

  it('survives an autoplay block and a lost file mid-service and finishes the session playing', async () => {
    let now = ANCHOR;
    const audience = slippingElement(1);
    const authority = createMediaAuthority(audience, noSurface(), { now: () => now });

    // Blocked before a hand has touched the machine, which is the ordinary state of a browser opened
    // fresh onto an output URL.
    audience.refuse = 'autoplay';
    expect((await authority.take({ at: AT }, settings)).recovery).toBe('resume-playback');

    audience.refuse = undefined;
    expect((await authority.recover()).playback).toBe('ok');

    const seen: string[] = [];
    for (let beat = 1; beat <= BEATS; beat += 1) {
      now = ANCHOR + beat * BEAT_MS;
      audience.advance(BEAT_MS);

      // An hour in the file goes; a beat later the network that took it comes back.
      if (beat * BEAT_MS === 60 * 60_000) {
        audience.refuse = 'load';
        const failed = await authority.play();
        expect(failed).toEqual({ playback: 'load-error', recovery: 'retry-load', fallback: 'last-frame' });
        seen.push(failed.playback);

        audience.refuse = undefined;
        const recovered = await authority.recover();
        expect(recovered.playback).toBe('ok');
        seen.push(recovered.playback);
      }
    }

    expect(seen).toEqual(['load-error', 'ok']);
    expect(authority.state).toEqual({ playback: 'ok', recovery: 'none', fallback: 'media' });
    expect(audience.paused).toBe(false);
    authority.dispose();
  });
});
