// A stand-in for the pixel compositing later tasks wire up, for the one thing that can be settled before
// there are pixels: what shows through where nothing was drawn. It paints onto a coarse grid of cells
// rather than a canvas — a grid a failing assertion can print — in the order a compositor would: the
// slide's own ground first, where the layout lands, and then its boxes over it, in paint order.
//
// The point of reading the ground off the prepared slide rather than assuming it is absent is that this
// is the mechanism that would notice one arriving. A slide that grew a background field would paint it
// here, the backdrop would stop showing through, and the suite would say so.

import type { Canvas } from '../../src/output-profile.js';
import type { PixelFrame, PreparedSlide } from '../../src/render-model.js';

/** What is in a cell nothing was painted over: the group background, showing through. */
export const BACKDROP = 'backdrop';

/** Any field by which a slide could carry a ground of its own. */
const FILL = /^(?:background|fill|backdrop)/iu;

export interface Grid {
  readonly columns: number;
  readonly rows: number;
}

/** The ground a prepared slide paints under its boxes, or nothing when it carries none. */
export const fillOf = (slide: PreparedSlide): string | undefined => {
  const found = Object.entries(slide).find(([name]) => FILL.test(name));
  return found === undefined ? undefined : String(found[1]);
};

const covers = (frame: PixelFrame, x: number, y: number): boolean =>
  x >= frame.x && x < frame.x + frame.width && y >= frame.y && y < frame.y + frame.height;

/**
 * What every cell of the canvas shows once one slide is painted over a backdrop: the identifier of the
 * last box covering the cell's centre, the slide's own ground where it has one and the layout reaches,
 * and the backdrop everywhere else.
 */
export function composite(slide: PreparedSlide, canvas: Canvas, { columns, rows }: Grid): readonly string[][] {
  const ground = fillOf(slide);
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => {
      const x = ((column + 0.5) / columns) * canvas.width;
      const y = ((row + 0.5) / rows) * canvas.height;
      const painted = slide.boxes.findLast((box) => covers(box.frame, x, y));
      if (painted !== undefined) return painted.id;
      return ground !== undefined && covers(slide.letterbox, x, y) ? ground : BACKDROP;
    }),
  );
}
