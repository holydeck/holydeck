// Rounding, in one place, because determinism is the whole point of this package. Binary floating point
// makes `97.2 - 1 - 1` and `97.2 - 2` different numbers, and a candidate font size that differs in the
// fifteenth decimal is a different byte in the serialized frame. Every number this package emits or
// steps through goes past here first.

export const GEOMETRY_PRECISION = 3;

export const roundTo = (value: number, places: number): number => Number(value.toFixed(places));

export const geometry = (value: number): number => roundTo(value, GEOMETRY_PRECISION);

/** Subpixel slack when asking whether something fits: a box is not overflowing by a hundredth of a pixel. */
export const FIT_TOLERANCE_PX = 0.01;

/** Subpixel noise below this is not a layout decision; rounding it keeps a re-preparation byte-stable. It
 *  lives here rather than in `measure.ts` so the layout half never pulls the lazy puppeteer import into a
 *  browser bundle. */
export const MEASUREMENT_PRECISION = 2;
