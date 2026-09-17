// Where a picture or a video actually lands inside the box that holds it.
//
// A media box is two rectangles, not one: the frame the layout gave it, and the rectangle the media
// itself occupies once its own proportions are taken into account. Only the second one is a decision, so
// it is made here, once, at preparation, and frozen — a surface that scaled its own video would be a
// surface able to disagree with the thumbnail beside it about what the slide looks like.
//
// All four modes are the same centred computation with one number chosen differently: `contain` takes
// the smaller scale so the media fits inside the frame whole, `cover` takes the larger so the frame is
// filled completely, `original` takes 1 and leaves the intrinsic pixels alone, and `stretch` is the one
// mode that abandons the media's proportions and becomes the frame exactly.
//
// `cover` and `original` may reach past the frame, and that is the answer rather than a fault: this
// package reports geometry and never clips. Whether the overflow is hidden is the painting surface's
// concern, the same way the scale it paints at is.

import { geometry } from './internal/numbers.js';

import type { PixelFrame } from './render-model.js';

export const MEDIA_FITS = ['original', 'contain', 'cover', 'stretch'] as const;

export type MediaFit = (typeof MEDIA_FITS)[number];

/** The media's own pixel dimensions, supplied by the caller; this package opens no files to learn them. */
export interface IntrinsicSize {
  readonly width: number;
  readonly height: number;
}

/**
 * A size with nothing to scale reached `mediaRectFor`. The render model asks `isScalableSize` first and
 * refuses such a size as a `RenderModelError`, so a producer's bad number never arrives here; this is the
 * invariant for a caller that comes straight to this module. Re-exported from `render-model.ts` so that
 * caller can name it.
 */
export class MediaGeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaGeometryError';
  }
}

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

/**
 * Whether a shape is one this module can scale: two finite, positive numbers. One predicate, so the
 * refusal that happens before a measurement and the guard inside `mediaRectFor` cannot come to disagree
 * about which sizes are drawable.
 */
export const isScalableSize = (size: IntrinsicSize): boolean => positive(size.width) && positive(size.height);

const centredIn = (frame: PixelFrame, width: number, height: number): PixelFrame => ({
  x: geometry(frame.x + (frame.width - width) / 2),
  y: geometry(frame.y + (frame.height - height) / 2),
  width: geometry(width),
  height: geometry(height),
});

const scaleFor = (frame: PixelFrame, intrinsic: IntrinsicSize, fit: MediaFit): number => {
  const horizontal = frame.width / intrinsic.width;
  const vertical = frame.height / intrinsic.height;
  return fit === 'cover' ? Math.max(horizontal, vertical) : Math.min(horizontal, vertical);
};

/**
 * The rectangle the media occupies inside its frame. Pure: the same frame, size and mode are the same
 * pixels every time, on every surface.
 */
export function mediaRectFor(frame: PixelFrame, intrinsic: IntrinsicSize, fit: MediaFit): PixelFrame {
  if (!isScalableSize(intrinsic)) {
    throw new MediaGeometryError(
      `intrinsic size ${intrinsic.width}x${intrinsic.height} is not two positive numbers`,
    );
  }

  switch (fit) {
    case 'stretch':
      return centredIn(frame, frame.width, frame.height);
    case 'original':
      return centredIn(frame, intrinsic.width, intrinsic.height);
    case 'contain':
    case 'cover': {
      const scale = scaleFor(frame, intrinsic, fit);
      return centredIn(frame, intrinsic.width * scale, intrinsic.height * scale);
    }
    /* v8 ignore start -- unreachable while the switch is exhaustive; it exists to make it stay that way */
    default: {
      const unreachable: never = fit;
      throw new MediaGeometryError(`unknown media fit ${String(unreachable)}`);
    }
    /* v8 ignore stop */
  }
}
