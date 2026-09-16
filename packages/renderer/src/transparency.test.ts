import { describe, expect, it } from 'vitest';

import { BACKDROP, composite, fillOf } from '../test/helpers/composite.js';
import { stubMeasurer } from '../test/helpers/measurer.js';
import { lyricBox } from '../test/helpers/model.js';
import { prepareRenderModel } from './render-model.js';
import { renderPrepared } from './renderer.js';

import type { Canvas } from './output-profile.js';
import type {
  DecorationBox,
  PreparedDecorationBox,
  PreparedRenderModel,
  PreparedSlide,
  PreparedTextBox,
  RenderModelInput,
  SlideInput,
  TextBox,
} from './render-model.js';
import type { RenderFrame, RenderedBox, RenderedSlide } from './renderer.js';

// TMPL-03 asks for Slide Layouts that "remain background-transparent", and SLID-02 says what that is for:
// "a slide inherits its group background". The way the promise is kept is by having nothing to keep — no
// slide, box or frame in this model carries a ground of its own — so it is asserted in the types as well
// as on a value, because a field added later is the moment it would break.
type Fill = `background${string}` | `fill${string}` | `backdrop${string}`;

type Transparent<T> = [Extract<keyof T, Fill>] extends [never] ? true : false;

const TRANSPARENT: readonly boolean[] = [
  true satisfies Transparent<RenderModelInput>,
  true satisfies Transparent<SlideInput>,
  true satisfies Transparent<TextBox>,
  true satisfies Transparent<DecorationBox>,
  true satisfies Transparent<PreparedRenderModel>,
  true satisfies Transparent<PreparedSlide>,
  true satisfies Transparent<PreparedTextBox>,
  true satisfies Transparent<PreparedDecorationBox>,
  true satisfies Transparent<RenderFrame>,
  true satisfies Transparent<RenderedSlide>,
  true satisfies Transparent<RenderedBox>,
];

/** Every field name anywhere in a value, however deeply nested. */
const namesIn = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.flatMap(namesIn)
    : typeof value === 'object' && value !== null
      ? Object.entries(value).flatMap(([name, held]) => [name, ...namesIn(held)])
      : [];

const strap: DecorationBox = {
  id: 'strap',
  kind: 'decoration',
  frame: { x: 0, y: 0.8, width: 1, height: 0.2 },
  importance: 'decoration',
};

const model: RenderModelInput = {
  id: 'set-1',
  outputType: 'main',
  slides: [{ id: 'slide-1', boxes: [lyricBox(), strap] }],
};

const CANVAS: Canvas = { width: 1920, height: 1080 };

const GRID = { columns: 10, rows: 10 };

/** One character per cell, so a composite that came out wrong is read rather than diffed. */
const MARKS: Readonly<Record<string, string>> = { [BACKDROP]: '.', lyric: 'l', strap: 's' };

const picture = (cells: readonly (readonly string[])[]): readonly string[] =>
  cells.map((row) => row.map((cell) => MARKS[cell] ?? '?').join(''));

/** Hand-written rather than derived from the frames, so it is a second opinion and not an echo. */
const SHOWING_THROUGH = [
  '..........',
  '..........',
  '.llllllll.',
  '.llllllll.',
  '.llllllll.',
  '.llllllll.',
  '.llllllll.',
  '..........',
  'ssssssssss',
  'ssssssssss',
];

/** How many of the hundred cells the lyric and the strap leave the group background showing through. */
const UNCOVERED = SHOWING_THROUGH.join('').replaceAll(/[^.]/gu, '').length;

const preparing = async (): Promise<PreparedSlide> => {
  const prepared = await prepareRenderModel({ model, measurer: stubMeasurer() });
  const slide = prepared.slides[0];
  if (slide === undefined) throw new Error('the model was prepared without its only slide');
  return slide;
};

const showing = (cells: readonly (readonly string[])[]): number =>
  cells.flat().filter((cell) => cell === BACKDROP).length;

describe('a slide the group background shows through', () => {
  it('leaves the backdrop standing everywhere no box covers, and covers it where one does', async () => {
    const cells = composite(await preparing(), CANVAS, GRID);
    expect(picture(cells)).toEqual(SHOWING_THROUGH);
    expect(showing(cells)).toBe(UNCOVERED);
  });

  // The control for the test above: the same composite, over a slide that does carry a ground, hides the
  // backdrop everywhere the layout lands. Without this, the assertion above could be passing because the
  // composite paints nothing at all rather than because a Slide Layout fills nothing.
  it('would hide the backdrop if a slide ever carried a ground of its own', async () => {
    const grounded = { ...(await preparing()), backgroundFill: 'ground' } as PreparedSlide;
    const cells = composite(grounded, CANVAS, GRID).flat();

    expect(fillOf(grounded)).toBe('ground');
    expect(cells).not.toContain(BACKDROP);
    expect(cells.filter((cell) => cell === 'ground')).toHaveLength(UNCOVERED);
  });

  // And a ground, if one ever existed, would end where the layout ends: the bars a letterboxed layout
  // leaves are not part of the slide, so the group background shows through them either way.
  it('leaves the backdrop in the bars a letterboxed layout does not reach', async () => {
    const letterboxed: RenderModelInput = {
      ...model,
      slides: [{ ...(model.slides[0] as SlideInput), layoutAspectRatio: { width: 4, height: 3 } }],
    };
    const prepared = await prepareRenderModel({ model: letterboxed, measurer: stubMeasurer() });
    const grounded = { ...(prepared.slides[0] as PreparedSlide), backgroundFill: 'ground' } as PreparedSlide;

    const cells = composite(grounded, CANVAS, GRID);
    expect(cells.map((row) => row[0])).toEqual(Array.from({ length: GRID.rows }, () => BACKDROP));
    expect(cells.map((row) => row.at(-1))).toEqual(Array.from({ length: GRID.rows }, () => BACKDROP));
    expect(cells.flat().filter((cell) => cell === BACKDROP)).toHaveLength(2 * GRID.rows);
  });

  it('carries no ground of its own in the model it is prepared from or the frame it is rendered to', async () => {
    expect(TRANSPARENT).toEqual(Array.from({ length: 11 }, () => true));
    expect(fillOf(await preparing())).toBeUndefined();

    const prepared = await prepareRenderModel({ model, measurer: stubMeasurer() });
    const frame = renderPrepared(prepared);
    expect(namesIn(frame).filter((name) => /^(?:background|fill|backdrop)/iu.test(name))).toEqual([]);
  });
});
