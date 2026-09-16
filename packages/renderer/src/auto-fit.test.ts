import { describe, expect, it } from 'vitest';

import { stubMeasurer } from '../test/helpers/measurer.js';
import { LYRIC, lyricBox, songModel } from '../test/helpers/model.js';
import { MAX_FIT_LADDER_RUNGS, autoFitText, chooseFit, fitLadder } from './auto-fit.js';
import { RenderConfigurationError } from './output-profile.js';
import { prepareRenderModel } from './render-model.js';
import { renderPrepared } from './renderer.js';

const style = { family: 'Inter', weight: 600, lineHeight: 1.2, letterSpacingPx: 0 };

describe('the auto-fit ladder', () => {
  it('descends from the requested size and never climbs above it', () => {
    expect(fitLadder({ requestedFontSizePx: 60, minimumFontSizePx: 56 })).toEqual([60, 59, 58, 57, 56]);
  });

  it('always ends on the effective minimum, whatever the step leaves over', () => {
    const ladder = fitLadder({ requestedFontSizePx: 60, minimumFontSizePx: 51.5, stepPx: 4 });
    expect(ladder[0]).toBe(60);
    expect(ladder.at(-1)).toBe(51.5);
    expect([...ladder].toSorted((a, b) => b - a)).toEqual([...ladder]);
  });

  it('holds only the minimum when the requested size is already below it', () => {
    expect(fitLadder({ requestedFontSizePx: 20, minimumFontSizePx: 44 })).toEqual([44]);
  });

  // A step that is zero, negative or not a number never walks the ladder down, and the loop that builds it
  // used to have nothing to stop it: it span for half a minute and then died on an array length. Failing
  // on the argument is the same defect reported in a hundredth of a second and in words.
  it('refuses a step that cannot walk the ladder down rather than spinning on it', () => {
    for (const stepPx of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => fitLadder({ requestedFontSizePx: 96, minimumFontSizePx: 40, stepPx })).toThrow(
        RenderConfigurationError,
      );
    }
  });

  // A step finer than the precision every rung is rounded to descends by nothing at all, which is the same
  // runaway wearing a plausible-looking number.
  it('refuses a step too fine to reach the floor before the ladder runs away', () => {
    expect(() => fitLadder({ requestedFontSizePx: 96, minimumFontSizePx: 40, stepPx: 0.001 })).toThrow(
      new RegExp(String(MAX_FIT_LADDER_RUNGS), 'u'),
    );
  });
});

describe('auto-fit reduces the font size and nothing else', () => {
  it('shrinks overflowing text without splitting, truncating, or hiding any of it', async () => {
    const measurer = stubMeasurer();
    const outcome = await autoFitText(measurer, {
      text: LYRIC,
      style,
      constraints: { requestedFontSizePx: 96, minimumFontSizePx: 20, maxWidthPx: 1536, maxHeightPx: 300 },
    });

    expect(outcome.fontSizePx).toBeLessThan(96);
    expect(outcome.reduced).toBe(true);
    expect(outcome.fits).toBe(true);
    expect(outcome.split).toBe(false);
    expect(outcome.truncated).toBe(false);
    expect(outcome.text).toBe(LYRIC);
    expect(outcome.metrics.heightPx).toBeLessThanOrEqual(300);
  });

  it('leaves text that already fits at exactly the requested size', async () => {
    const outcome = await autoFitText(stubMeasurer(), {
      text: 'Amen',
      style,
      constraints: { requestedFontSizePx: 40, minimumFontSizePx: 20, maxWidthPx: 1536, maxHeightPx: 540 },
    });

    expect(outcome.fontSizePx).toBe(40);
    expect(outcome.reduced).toBe(false);
  });

  it('never enlarges text to fill the room it was given', async () => {
    const outcome = await autoFitText(stubMeasurer(), {
      text: 'Amen',
      style,
      constraints: { requestedFontSizePx: 24, minimumFontSizePx: 20, maxWidthPx: 1900, maxHeightPx: 1000 },
    });

    expect(outcome.fontSizePx).toBe(24);
  });
});

describe('choosing a rung', () => {
  it('refuses to choose from nothing rather than inventing a size', () => {
    const constraints = { requestedFontSizePx: 40, minimumFontSizePx: 20, maxWidthPx: 100, maxHeightPx: 100 };
    expect(() => chooseFit({ text: 'Amen', ladder: [], metrics: [], constraints })).toThrow(RangeError);
  });

  it('skips a rung the measurer answered nothing for and keeps walking down', () => {
    const outcome = chooseFit({
      text: 'Amen',
      ladder: [40, 30, 20],
      metrics: [{ widthPx: 400, heightPx: 400, lineCount: 4 }, undefined, { widthPx: 90, heightPx: 90, lineCount: 1 }] as never,
      constraints: { requestedFontSizePx: 40, minimumFontSizePx: 20, maxWidthPx: 100, maxHeightPx: 100 },
    });

    expect(outcome.fontSizePx).toBe(20);
    expect(outcome.fits).toBe(true);
  });
});

describe('auto-fit through a whole preparation', () => {
  it('keeps one slide and the whole text when the requested size overflows', async () => {
    const prepared = await prepareRenderModel({
      model: songModel([lyricBox({ font: { family: 'Inter', weight: 600, sizeRatio: 0.2, lineHeight: 1.2 } })]),
      measurer: stubMeasurer(),
    });
    const frame = renderPrepared(prepared);

    expect(frame.slides).toHaveLength(1);
    const box = frame.slides[0]?.boxes[0];
    expect(box?.kind).toBe('text');
    expect(box?.text).toBe(LYRIC);
    expect(box?.fontSizePx).toBeLessThan(0.2 * prepared.canvas.height);
  });
});
