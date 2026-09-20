import { describe, expect, it } from 'vitest';

import {
  advanceLive,
  browseBy,
  browseTo,
  initialSingerView,
  moveLive,
  returnToLive,
  singerCue,
  singerPosition,
} from './singer-state.js';

import type { SingerSong } from './singer-state.js';

// Two songs the operator can be running, and one item with nothing to show. Only the slide count
// matters here: this module resolves where a Singer is looking, and `stage-state.ts`'s `surfaceCue`
// is what turns a position into words.
const ASCENT: SingerSong = { id: 'item-ascent', slideCount: 4 };
const PSALM: SingerSong = { id: 'item-psalm', slideCount: 3 };
const ANNOUNCEMENT: SingerSong = { id: 'item-announcement', slideCount: 0 };

// ---------------------------------------------------------------------------------------------------
// Browsing the current song locally
// ---------------------------------------------------------------------------------------------------

describe('a Singer browsing the current song', () => {
  it('looks away from the live slide without moving the public output', () => {
    const following = initialSingerView(ASCENT, 1);

    const browsing = browseTo(ASCENT, following, 3);

    expect(browsing.publicPosition).toBe(1);
    expect(singerPosition(browsing)).toBe(3);
    // Exactly one field moved: a write to the public position or to which song is live fails this.
    expect({ ...browsing, browsedPosition: following.browsedPosition }).toEqual(following);
    expect(following).toEqual({ songId: 'item-ascent', publicPosition: 1, browsedPosition: undefined });
  });

  it('is this one Singer’s own: another Singer on the same live position is untouched', () => {
    const mine = initialSingerView(ASCENT, 1);
    const theirs = initialSingerView(ASCENT, 1);

    const afterMine = browseTo(ASCENT, mine, 3);

    expect(singerPosition(afterMine)).toBe(3);
    expect(singerPosition(theirs)).toBe(1);
    expect(singerCue(theirs)).toEqual({ position: 1, browsing: false });
    expect(theirs.publicPosition).toBe(afterMine.publicPosition);
  });

  it('clamps a slide before the start or past the end onto the nearest real one', () => {
    const following = initialSingerView(ASCENT, 1);

    expect(browseTo(ASCENT, following, -5).browsedPosition).toBe(0);
    expect(browseTo(ASCENT, following, 99).browsedPosition).toBe(3);
  });

  it('steps from where this Singer is reading, not from the live slide', () => {
    const once = browseBy(ASCENT, initialSingerView(ASCENT, 0), 1);
    const twice = browseBy(ASCENT, once, 1);

    expect(twice.browsedPosition).toBe(2);
    expect(twice.publicPosition).toBe(0);
    expect(browseBy(ASCENT, twice, -9).browsedPosition).toBe(0);
  });

  it('refuses a song with no slides, leaving the Singer following live rather than parked nowhere', () => {
    const following = initialSingerView(ANNOUNCEMENT, 2);

    expect(following).toEqual({ songId: 'item-announcement', publicPosition: 0, browsedPosition: undefined });
    expect(browseTo(ANNOUNCEMENT, following, 1)).toEqual(following);
    expect(singerCue(browseTo(ANNOUNCEMENT, following, 1))).toEqual({ position: 0, browsing: false });
  });

  it('refuses a slide of a song this Singer is not the one reading', () => {
    const following = initialSingerView(ASCENT, 1);

    expect(browseTo(PSALM, following, 2)).toEqual(following);
    expect(browseBy(PSALM, following, 1)).toEqual(following);
  });

  it('starts on the live slide, clamped into the song it is a slide of', () => {
    expect(initialSingerView(ASCENT).publicPosition).toBe(0);
    expect(initialSingerView(ASCENT, 99).publicPosition).toBe(3);
    expect(initialSingerView(ASCENT, -2).publicPosition).toBe(0);
    expect(singerPosition(initialSingerView(PSALM, 2))).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------
// The cue the operator’s move sends
// ---------------------------------------------------------------------------------------------------

describe('the cue that reaches a browsing Singer', () => {
  it('appears the moment the operator advances off the slide this Singer is reading', () => {
    // Browsed onto the live slide itself: privately browsing, but with nothing yet to be told.
    const browsing = browseTo(ASCENT, initialSingerView(ASCENT, 1), 1);
    const before = singerCue(browsing);

    expect(before).toEqual({ position: 1, browsing: true });
    expect('awayFromLive' in before).toBe(false);

    const advanced = advanceLive(ASCENT, browsing);

    expect(advanced.publicPosition).toBe(2);
    expect(singerCue(advanced)).toEqual({
      position: 1,
      browsing: true,
      awayFromLive: { livePosition: 2, direction: 'ahead', slides: 1 },
    });
  });

  it('counts how far the operator has gone, not merely that they went', () => {
    const browsing = browseTo(ASCENT, initialSingerView(ASCENT, 0), 0);

    const twice = advanceLive(ASCENT, advanceLive(ASCENT, browsing));

    expect(singerCue(twice).awayFromLive).toEqual({ livePosition: 2, direction: 'ahead', slides: 2 });
    expect(twice.browsedPosition).toBe(0);
  });

  it('says live is behind when this Singer has read on past it', () => {
    const browsing = browseTo(ASCENT, initialSingerView(ASCENT, 1), 3);

    expect(singerCue(browsing).awayFromLive).toEqual({ livePosition: 1, direction: 'behind', slides: 2 });
  });

  it('never reaches a Singer who is following — their screen simply moves with the operator', () => {
    const advanced = advanceLive(ASCENT, initialSingerView(ASCENT, 1));

    expect(singerPosition(advanced)).toBe(2);
    expect(singerCue(advanced)).toEqual({ position: 2, browsing: false });
  });

  it('holds at the last slide when the operator advances past the end of the song', () => {
    const atEnd = moveLive(ASCENT, initialSingerView(ASCENT, 0), 3);

    expect(atEnd.publicPosition).toBe(3);
    expect(advanceLive(ASCENT, atEnd).publicPosition).toBe(3);
    expect(moveLive(ASCENT, atEnd, 99).publicPosition).toBe(3);
    expect(moveLive(ASCENT, atEnd, -7).publicPosition).toBe(0);
  });

  it('is abandoned when the operator moves on to another song, which this Singer then follows', () => {
    const browsing = browseTo(ASCENT, initialSingerView(ASCENT, 0), 3);

    const moved = moveLive(PSALM, browsing, 1);

    expect(moved).toEqual({ songId: 'item-psalm', publicPosition: 1, browsedPosition: undefined });
    expect(singerCue(moved)).toEqual({ position: 1, browsing: false });
    expect(moveLive(PSALM, browsing, 9).publicPosition).toBe(2);
    expect(advanceLive(PSALM, browsing)).toEqual({
      songId: 'item-psalm',
      publicPosition: 0,
      browsedPosition: undefined,
    });
  });
});

// ---------------------------------------------------------------------------------------------------
// Returning to the live position
// ---------------------------------------------------------------------------------------------------

describe('returning to the live position', () => {
  it('is one call, and lands this Singer exactly where the operator is', () => {
    const away = advanceLive(ASCENT, advanceLive(ASCENT, browseTo(ASCENT, initialSingerView(ASCENT, 0), 3)));

    expect(singerPosition(away)).toBe(3);
    expect(singerCue(away).awayFromLive).toEqual({ livePosition: 2, direction: 'behind', slides: 1 });

    const back = returnToLive(away);

    expect(back).toEqual({ songId: 'item-ascent', publicPosition: 2, browsedPosition: undefined });
    expect(singerPosition(back)).toBe(2);
    expect(singerCue(back)).toEqual({ position: 2, browsing: false });
  });

  it('never moves the public output on the way back', () => {
    const away = browseTo(ASCENT, initialSingerView(ASCENT, 1), 3);

    expect(returnToLive(away).publicPosition).toBe(1);
    expect(away.publicPosition).toBe(1);
  });

  it('leaves a Singer who never browsed exactly where they already were', () => {
    const following = initialSingerView(ASCENT, 2);

    expect(returnToLive(following)).toEqual(following);
    expect(singerCue(returnToLive(following))).toEqual({ position: 2, browsing: false });
  });
});
