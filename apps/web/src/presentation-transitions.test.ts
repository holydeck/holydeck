import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRANSITION,
  TRANSITIONS,
  TRANSITION_BUDGET_MS,
  beginTransition,
  isTransitionName,
  selectTransition,
  settleTransition,
  settledOn,
  transitionDurationMs,
  transitionFallbackFor,
} from './presentation-transitions.js';

// What a surface is standing on before anything moves. Only the frame's identity matters here: what a
// frame is made of belongs to whatever renders one, and every rule below is about which frame is the
// authoritative one.
const VERSE = settledOn('slide-verse-2');

// ---------------------------------------------------------------------------------------------------
// What an admin configures
// ---------------------------------------------------------------------------------------------------

describe('the transition an admin configures', () => {
  it('offers an explicit none alongside the ones that animate', () => {
    expect(TRANSITIONS).toContain('none');
    expect(isTransitionName('none')).toBe(true);
    expect(selectTransition('crossfade', 'none')).toBe('none');
    expect(DEFAULT_TRANSITION).toBe('none');
  });

  it('cuts straight to the incoming frame when none is the one configured', () => {
    const cut = beginTransition(VERSE, 'none', 'slide-verse-3');

    expect(cut.frameId).toBe('slide-verse-3');
    // Not a zero-length transition that still has to finish: there is nothing running to finish.
    expect('running' in cut).toBe(false);
    expect(transitionDurationMs('none')).toBe(0);
  });

  it('runs the configured transition for every other choice, holding the frame until it commits', () => {
    const moving = beginTransition(VERSE, 'crossfade', 'slide-verse-3');

    expect(moving.running).toEqual({
      transition: 'crossfade',
      durationMs: transitionDurationMs('crossfade'),
      toFrameId: 'slide-verse-3',
    });
    // The outgoing frame is still what this surface is authoritatively showing while the move runs.
    expect(moving.frameId).toBe('slide-verse-2');
    expect(VERSE).toEqual({ frameId: 'slide-verse-2' });
  });

  it('keeps what the admin already had when asked for a transition this build does not offer', () => {
    expect(selectTransition('fade', 'swirl')).toBe('fade');
    expect(selectTransition('none', '')).toBe('none');
    expect(isTransitionName('swirl')).toBe(false);
  });

  it('offers each of its transitions by its own name and no two of the same', () => {
    for (const name of TRANSITIONS) {
      expect(isTransitionName(name)).toBe(true);
      expect(selectTransition('none', name)).toBe(name);
    }
    expect(new Set(TRANSITIONS).size).toBe(TRANSITIONS.length);
  });
});

// ---------------------------------------------------------------------------------------------------
// A transition that does not complete
// ---------------------------------------------------------------------------------------------------

describe('a transition that fails', () => {
  it('leaves the frame that was already up on screen, never a blank one', () => {
    const moving = beginTransition(VERSE, 'fade', 'slide-verse-3');

    const held = settleTransition(moving, 'failed');

    expect(held.frameId).toBe('slide-verse-2');
    expect(held).toEqual({ frameId: 'slide-verse-2' });
    expect(transitionFallbackFor('failed')).toBe('last-frame');
  });

  it('commits the incoming frame when it completes instead', () => {
    const moving = beginTransition(VERSE, 'push', 'slide-verse-3');

    const shown = settleTransition(moving, 'completed');

    expect(shown).toEqual({ frameId: 'slide-verse-3' });
    expect(transitionFallbackFor('completed')).toBe('incoming-frame');
  });

  it('cannot be blanked by an outcome arriving after the move already settled', () => {
    const shown = settleTransition(beginTransition(VERSE, 'fade', 'slide-verse-3'), 'completed');

    expect(settleTransition(shown, 'failed')).toEqual({ frameId: 'slide-verse-3' });
    expect(settleTransition(settleTransition(shown, 'failed'), 'completed')).toEqual({
      frameId: 'slide-verse-3',
    });
    expect(settleTransition(VERSE, 'failed')).toEqual(VERSE);
  });

  it('refuses a move to no frame at all, so nothing can be transitioned onto nothing', () => {
    expect(beginTransition(VERSE, 'fade', '')).toEqual(VERSE);
    expect(beginTransition(VERSE, 'none', '   ')).toEqual(VERSE);
    expect(settledOn('   ').frameId).toBe('');
  });

  it('holds the frame the room is looking at when the operator moves on mid-transition', () => {
    const first = beginTransition(VERSE, 'crossfade', 'slide-verse-3');

    // The second move supersedes the first: what the operator asked for last is what is coming.
    const second = beginTransition(first, 'crossfade', 'slide-verse-4');

    expect(second.running?.toFrameId).toBe('slide-verse-4');
    expect(second.frameId).toBe('slide-verse-2');
    // And if that one fails, the frame that stays up is still the one that was really on screen.
    expect(settleTransition(second, 'failed')).toEqual({ frameId: 'slide-verse-2' });
    expect(settleTransition(second, 'completed')).toEqual({ frameId: 'slide-verse-4' });
  });
});

// ---------------------------------------------------------------------------------------------------
// How long one is allowed to take
// ---------------------------------------------------------------------------------------------------

describe('the interaction budget a transition runs inside', () => {
  it('holds every transition this build offers inside it', () => {
    for (const name of TRANSITIONS) {
      expect(transitionDurationMs(name)).toBeLessThanOrEqual(TRANSITION_BUDGET_MS);
      expect(transitionDurationMs(name)).toBeGreaterThanOrEqual(0);
    }
  });

  it('is the figure the module declares, so moving it is a deliberate change and not a drift', () => {
    expect(TRANSITION_BUDGET_MS).toBe(250);
  });

  it('carries the same budget into what a running transition tells a surface to animate for', () => {
    const moving = beginTransition(VERSE, 'push', 'slide-verse-3');

    expect(moving.running?.durationMs).toBeLessThanOrEqual(TRANSITION_BUDGET_MS);
    expect(moving.running?.durationMs).toBe(transitionDurationMs('push'));
  });
});
