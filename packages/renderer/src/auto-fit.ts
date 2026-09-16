// Auto-fit, which §11.6 defines by what it may not do: "deterministic font-size reduction only. No
// automatic slide splitting, no truncation, no hidden text."
//
// So this engine has exactly one lever. It builds a ladder of candidate sizes from the requested size
// down to the effective minimum, has every rung measured in one go, and takes the first rung that fits.
// The text it was given is the text that comes out — `split` and `truncated` are typed as the literal
// `false` so that a later change wanting either has to change this file's contract in front of a
// reviewer rather than quietly return `true`.
//
// The ladder is built before anything is measured, which is what lets one preparation ask the browser
// once for every candidate of every box rather than walking a loop of round trips.

import { FIT_TOLERANCE_PX, roundTo } from './internal/numbers.js';
import { MEASUREMENT_PRECISION } from './measure.js';

import type { MeasureRequest, TextMeasurer, TextMetrics } from './measure.js';

/** Default rung spacing. One pixel is finer than any display this renders to can show. */
export const DEFAULT_FIT_STEP_PX = 1;

export interface FitLadderInput {
  readonly requestedFontSizePx: number;
  /** The effective floor: the administrative minimum, raised by a Slide Layout box if it asked for more. */
  readonly minimumFontSizePx: number;
  readonly stepPx?: number;
}

export interface FitConstraints extends FitLadderInput {
  readonly maxWidthPx: number;
  readonly maxHeightPx: number;
}

export interface FitStyle {
  readonly family: string;
  readonly weight: number;
  readonly lineHeight: number;
  readonly letterSpacingPx: number;
}

export interface FitOutcome {
  readonly text: string;
  readonly fontSizePx: number;
  readonly requestedFontSizePx: number;
  readonly minimumFontSizePx: number;
  readonly metrics: TextMetrics;
  /** Whether the chosen size actually holds the text inside the box. */
  readonly fits: boolean;
  readonly reduced: boolean;
  /** The layout asked for text below the floor, so the floor was used instead. */
  readonly raisedToMinimum: boolean;
  readonly split: false;
  readonly truncated: false;
}

/**
 * Candidate sizes, largest first, ending on the effective minimum. A requested size already below the
 * floor yields the floor alone: auto-fit only ever reduces, so there is nothing to walk down from.
 */
export function fitLadder({ requestedFontSizePx, minimumFontSizePx, stepPx = DEFAULT_FIT_STEP_PX }: FitLadderInput): readonly number[] {
  const minimum = roundTo(minimumFontSizePx, MEASUREMENT_PRECISION);
  const requested = roundTo(requestedFontSizePx, MEASUREMENT_PRECISION);
  if (requested <= minimum) return [minimum];

  const rungs: number[] = [];
  for (let index = 0; ; index += 1) {
    const rung = roundTo(requested - index * stepPx, MEASUREMENT_PRECISION);
    if (rung <= minimum) break;
    rungs.push(rung);
  }
  rungs.push(minimum);
  return rungs;
}

/**
 * The style half of a font spec, in reference pixels. Letter spacing is a fraction of the canvas height
 * rather than of the font size on purpose: it stays the same on every rung, so walking the ladder down
 * changes one thing — the size — instead of re-spacing the glyphs at the same time.
 */
export function autoFitStyle(
  font: { readonly family: string; readonly weight: number; readonly lineHeight: number; readonly letterSpacingRatio?: number },
  canvas: { readonly height: number },
): FitStyle {
  return {
    family: font.family,
    weight: font.weight,
    lineHeight: font.lineHeight,
    letterSpacingPx: roundTo((font.letterSpacingRatio ?? 0) * canvas.height, MEASUREMENT_PRECISION),
  };
}

export function fitRequests(
  text: string,
  style: FitStyle,
  ladder: readonly number[],
  maxWidthPx: number,
): readonly MeasureRequest[] {
  return ladder.map((fontSizePx) => ({
    text,
    fontFamily: style.family,
    fontWeight: style.weight,
    fontSizePx,
    lineHeight: style.lineHeight,
    letterSpacingPx: style.letterSpacingPx,
    maxWidthPx,
  }));
}

const holds = (metrics: TextMetrics, constraints: FitConstraints): boolean =>
  metrics.widthPx <= constraints.maxWidthPx + FIT_TOLERANCE_PX &&
  metrics.heightPx <= constraints.maxHeightPx + FIT_TOLERANCE_PX;

export interface FitChoice {
  readonly text: string;
  readonly ladder: readonly number[];
  readonly metrics: readonly TextMetrics[];
  readonly constraints: FitConstraints;
}

/**
 * The first rung that holds the text wins. None of them holding is not an error and not a reason to cut
 * the text: the floor is used, the whole text renders, and readiness blocks on the finding the caller
 * raises from `fits === false`.
 */
export function chooseFit({ text, ladder, metrics, constraints }: FitChoice): FitOutcome {
  const lastRung = ladder.at(-1);
  const lastMetrics = metrics.at(-1);
  if (lastRung === undefined || lastMetrics === undefined) {
    throw new RangeError('auto-fit needs at least one measured candidate size');
  }

  let chosen = { fontSizePx: lastRung, metrics: lastMetrics, fits: false };
  for (const [index, rung] of ladder.entries()) {
    const measured = metrics[index];
    if (measured === undefined) continue;
    if (holds(measured, constraints)) {
      chosen = { fontSizePx: rung, metrics: measured, fits: true };
      break;
    }
  }

  const requested = roundTo(constraints.requestedFontSizePx, MEASUREMENT_PRECISION);
  return {
    text,
    fontSizePx: chosen.fontSizePx,
    requestedFontSizePx: requested,
    minimumFontSizePx: roundTo(constraints.minimumFontSizePx, MEASUREMENT_PRECISION),
    metrics: chosen.metrics,
    fits: chosen.fits,
    reduced: chosen.fontSizePx < requested,
    raisedToMinimum: chosen.fontSizePx > requested,
    split: false,
    truncated: false,
  };
}

export interface AutoFitRequest {
  readonly text: string;
  readonly style: FitStyle;
  readonly constraints: FitConstraints;
}

/** One box, measured and fitted on its own. Preparation batches instead; this is the single-box door. */
export async function autoFitText(measurer: TextMeasurer, request: AutoFitRequest): Promise<FitOutcome> {
  const ladder = fitLadder(request.constraints);
  const metrics = await measurer.measure(fitRequests(request.text, request.style, ladder, request.constraints.maxWidthPx));
  return chooseFit({ text: request.text, ladder, metrics, constraints: request.constraints });
}
