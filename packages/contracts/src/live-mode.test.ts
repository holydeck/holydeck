import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  LIVE_MODES,
  enterStandby,
  initialLiveModeState,
  pause,
  publicFrameOf,
  resume,
  returnToLivePosition,
  select,
  takeSelectedLive,
} from './live-mode.js';

import type { LiveModeState } from './live-mode.js';

const EMPTY = 'empty-screen';
const start = (): LiveModeState<string> => initialLiveModeState(EMPTY);

describe('the three canonical modes and nothing else (C-06)', () => {
  it('names exactly live, paused, and standby', () => {
    expect(LIVE_MODES).toEqual(['live', 'paused', 'standby']);
  });

  it('never reintroduces the superseded "blank" mode as a literal anywhere in this module', () => {
    const source = readFileSync(new URL('./live-mode.ts', import.meta.url), 'utf8');
    expect(/(['"`])blank\1/u.test(source)).toBe(false);
  });
});

describe('live: Control navigation publishes immediately (spec 9.2)', () => {
  it('keeps publicPosition and selectedPosition equal across every select', () => {
    let state = start();
    state = select(state, 'verse-1');
    expect(state).toMatchObject({ mode: 'live', publicPosition: 'verse-1', selectedPosition: 'verse-1' });

    state = select(state, 'verse-2');
    expect(state).toMatchObject({ mode: 'live', publicPosition: 'verse-2', selectedPosition: 'verse-2' });
    expect(publicFrameOf(state)).toEqual({ position: 'verse-2' });
  });
});

describe('paused: private browsing moves selectedPosition only (spec 9.2)', () => {
  it('holds the last live publicPosition while selectedPosition moves freely', () => {
    let state = select(start(), 'verse-1');
    state = pause(state);
    expect(state.mode).toBe('paused');

    // LIVE-08's list, verbatim: private search, passage inspection, and offset inspection — each is
    // just another `select` call to this model, and none of them may reach the public side.
    for (const browsed of ['search:grace', 'passage:john-3-16', 'offset:+2']) {
      state = select(state, browsed);
      expect(state.selectedPosition).toBe(browsed);
      expect(state.publicPosition).toBe('verse-1');
      expect(publicFrameOf(state)).toEqual({ position: 'verse-1' });
    }
  });
});

describe('standby: the primary action is immediate; browsing inside it stays private until Resume', () => {
  it('shows the selected Standby screen on the public output the instant it is entered', () => {
    const state = enterStandby(select(start(), 'verse-1'), 'standby-screen');
    expect(state).toMatchObject({ mode: 'standby', publicPosition: 'standby-screen' });
    expect(publicFrameOf(state)).toEqual({ position: 'standby-screen' });
  });

  it('falls back to the default empty screen on media failure, never a partial or error frame', () => {
    const state = enterStandby(start(), 'video-that-fails-to-load', false);
    expect(state.publicPosition).toBe(EMPTY);
    expect(state.publicPosition).not.toBe('video-that-fails-to-load');
    expect(publicFrameOf(state)).toEqual({ position: EMPTY });
  });

  it('keeps browsing while in Standby private until Resume reveals it', () => {
    let state = enterStandby(select(start(), 'verse-1'), 'standby-screen');
    for (const browsed of ['search:grace', 'passage:john-3-16', 'offset:-1']) {
      state = select(state, browsed);
      expect(state.publicPosition).toBe('standby-screen');
      expect(publicFrameOf(state)).toEqual({ position: 'standby-screen' });
    }

    state = resume(state);
    expect(state).toMatchObject({ mode: 'live', publicPosition: 'offset:-1', selectedPosition: 'offset:-1' });
  });
});

describe('returning to live publishes the selected position explicitly, never implicitly (LIVE-08)', () => {
  const paused = (): LiveModeState<string> => {
    let state = select(start(), 'verse-1');
    state = pause(state);
    state = select(state, 'verse-9');
    return state;
  };

  it('"Return to Live Position" abandons the private selection without ever touching the public output', () => {
    const state = returnToLivePosition(paused());
    expect(state).toMatchObject({ mode: 'live', publicPosition: 'verse-1', selectedPosition: 'verse-1' });
  });

  it('"Take Selected Live" is the one explicit act that publishes the private selection', () => {
    const state = takeSelectedLive(paused());
    expect(state).toMatchObject({ mode: 'live', publicPosition: 'verse-9', selectedPosition: 'verse-9' });
  });
});

describe('the Audience frame never carries what the operator is privately doing (spec 9.3)', () => {
  it('carries only a position field — never selectedPosition, for a payload or DOM to leak', () => {
    let state = pause(select(start(), 'verse-1'));
    state = select(state, 'search:grace');
    const frame = publicFrameOf(state);
    expect(Object.keys(frame)).toEqual(['position']);
    expect('selectedPosition' in frame).toBe(false);
  });

  it('is unchanged by any amount of private paused or standby browsing', () => {
    let state = pause(select(start(), 'verse-1'));
    const before = publicFrameOf(state);
    for (const browsed of ['search:a', 'passage:b', 'offset:c']) state = select(state, browsed);
    state = enterStandby(state, 'standby-screen');
    // Entering Standby is itself the immediate primary action (spec 9.2), so the frame changes here —
    // browsing after this point is what must not move it again.
    const afterEnteringStandby = publicFrameOf(state);
    for (const browsed of ['search:d', 'passage:e']) state = select(state, browsed);
    expect(publicFrameOf(state)).toEqual(afterEnteringStandby);
    expect(before).toEqual({ position: 'verse-1' });
  });
});
