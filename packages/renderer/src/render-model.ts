// The normalized render model, and the one moment anything about a slide is decided.
//
// REND-01 asks for "one deterministic renderer and the same normalized render model" behind the editor
// preview, thumbnails, output views, prepared snapshots and the offline presenter. The way that promise
// is kept here is a split: preparation decides, rendering draws, surfaces scale. Preparation is the only
// step that reads a default, the only step that measures text, and the only step allowed to make a
// choice; everything it decided is frozen into the value it returns. A surface that wanted to disagree
// would have to re-prepare, which is a different model and a visibly different set of bytes.
//
// "Normalized" is literal: a box's frame is a fraction of its slide and a font size is a fraction of the
// canvas height, so nothing in the authored model knows what a pixel is. Preparation resolves those
// against one reference canvas — never against a surface's own viewport — which is why a 320px thumbnail
// and a 4K output view wrap a lyric in exactly the same place.
//
// Administration owns the ratio, the margins and the readable floor, and a service may override them.
// Items and slides may not, and this file refuses a model that tries: a slide carrying an `aspectRatio`
// is a defect in whatever produced it, not a preference to be honoured.

import { autoFitStyle, chooseFit, fitLadder, fitRequests } from './auto-fit.js';
import { deepFreeze } from './internal/freeze.js';
import { geometry, roundTo } from './internal/numbers.js';
import { MEASUREMENT_PRECISION } from './measure.js';
import { canvasFor, resolveOutputProfile } from './output-profile.js';
import { blocker, readinessOf, warning } from './readiness.js';

import type { FitConstraints } from './auto-fit.js';
import type { MeasureRequest, TextMeasurer, TextMetrics } from './measure.js';
import type {
  AdministrativeRenderDefaults,
  AspectRatio,
  Canvas,
  ResolvedOutputProfile,
  ServiceRenderOverrides,
} from './output-profile.js';
import type { Readiness, ReadinessFinding } from './readiness.js';

export class RenderModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderModelError';
  }
}

/** Fractions of the slide the box sits on: `{ x: 0.1, width: 0.8 }` is a box inset a tenth on each side. */
export interface NormalizedFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PixelFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FontSpec {
  readonly family: string;
  readonly weight: number;
  /** Requested size as a fraction of the canvas height. Auto-fit may reduce it and never raises it. */
  readonly sizeRatio: number;
  readonly lineHeight: number;
  readonly letterSpacingRatio?: number;
}

/** REND-01 grades the safe area differently for the two: required content blocks, decoration warns. */
export type BoxImportance = 'required' | 'decoration';

export interface TextBox {
  readonly id: string;
  readonly kind: 'text';
  readonly text: string;
  readonly frame: NormalizedFrame;
  readonly font: FontSpec;
  readonly importance: BoxImportance;
  /** A Slide Layout box may raise the administrative floor. A lower number is clamped up to it. */
  readonly minimumReadableHeightRatio?: number;
}

export interface DecorationBox {
  readonly id: string;
  readonly kind: 'decoration';
  readonly frame: NormalizedFrame;
  readonly importance: BoxImportance;
}

export type SlideBox = TextBox | DecorationBox;

export interface SlideInput {
  readonly id: string;
  readonly boxes: readonly SlideBox[];
  /**
   * The ratio the Slide Layout was authored at, when it is not the output's. Not an override: the frame
   * is letterboxed to fit this completely rather than cropped, and readiness says so.
   */
  readonly layoutAspectRatio?: AspectRatio;
}

export interface RenderModelInput {
  readonly id: string;
  readonly outputType: string;
  readonly slides: readonly SlideInput[];
}

export interface PreparedBoxBase {
  readonly id: string;
  readonly importance: BoxImportance;
  readonly frame: PixelFrame;
}

export interface PreparedTextBox extends PreparedBoxBase {
  readonly kind: 'text';
  readonly text: string;
  readonly font: FontSpec;
  readonly fontSizePx: number;
  readonly requestedFontSizePx: number;
  readonly minimumFontSizePx: number;
  readonly lineCount: number;
  readonly metrics: TextMetrics;
  readonly fits: boolean;
}

export interface PreparedDecorationBox extends PreparedBoxBase {
  readonly kind: 'decoration';
}

export type PreparedBox = PreparedTextBox | PreparedDecorationBox;

/** Narrows a prepared box to the half that carries type, for callers walking a slide. */
export const isPreparedTextBox = (box: PreparedBox): box is PreparedTextBox => box.kind === 'text';

export interface PreparedSlide {
  readonly id: string;
  /** Where the authored layout lands on the canvas. The whole canvas unless the ratios differ. */
  readonly letterbox: PixelFrame;
  readonly boxes: readonly PreparedBox[];
}

export interface PreparedRenderModel {
  readonly modelId: string;
  readonly outputType: string;
  readonly profile: ResolvedOutputProfile;
  readonly canvas: Canvas;
  readonly safeAreaPx: PixelFrame;
  /** The administrative floor in reference pixels. A box may hold a higher one of its own. */
  readonly minimumFontSizePx: number;
  readonly slides: readonly PreparedSlide[];
  readonly findings: readonly ReadinessFinding[];
  readonly readiness: Readiness;
}

export interface PreparationRequest {
  readonly model: RenderModelInput;
  readonly measurer: TextMeasurer;
  readonly defaults?: AdministrativeRenderDefaults;
  readonly service?: ServiceRenderOverrides;
  /** Rung spacing for the auto-fit ladder; one pixel unless a caller wants it coarser. */
  readonly stepPx?: number;
}

const letterboxFor = (canvas: Canvas, ratio: AspectRatio): PixelFrame => {
  const shape = ratio.width / ratio.height;
  const width = Math.min(canvas.width, canvas.height * shape);
  const height = width / shape;
  return {
    x: geometry((canvas.width - width) / 2),
    y: geometry((canvas.height - height) / 2),
    width: geometry(width),
    height: geometry(height),
  };
};

const frameWithin = (host: PixelFrame, frame: NormalizedFrame): PixelFrame => ({
  x: geometry(host.x + frame.x * host.width),
  y: geometry(host.y + frame.y * host.height),
  width: geometry(frame.width * host.width),
  height: geometry(frame.height * host.height),
});

const contains = (host: PixelFrame, inner: PixelFrame): boolean =>
  inner.x >= host.x &&
  inner.y >= host.y &&
  inner.x + inner.width <= host.x + host.width &&
  inner.y + inner.height <= host.y + host.height;

const sameRatio = (left: AspectRatio, right: AspectRatio): boolean =>
  left.width * right.height === right.width * left.height;

// A slide or a box that carries a ratio is refused rather than ignored. §11.6 is explicit that "a service
// may override it; items and slides may not", and silently dropping the field would let a producer go on
// believing it had been honoured.
const refuseOwnRatio = (holder: object, what: string): void => {
  if ('aspectRatio' in holder) {
    throw new RenderModelError(`${what} carries an aspect ratio of its own; only administration and a service may set one`);
  }
};

/**
 * How a text box is fitted: the ladder of candidate sizes and the box it has to fit inside. Derived
 * twice per preparation — once to collect the measurement requests, once to read the answers back — so
 * it lives in one function rather than in two places that could drift apart.
 */
const fitFor = (
  box: TextBox,
  frame: PixelFrame,
  profile: ResolvedOutputProfile,
  canvas: Canvas,
  stepPx: number | undefined,
): { readonly constraints: FitConstraints; readonly ladder: readonly number[] } => {
  const constraints: FitConstraints = {
    requestedFontSizePx: roundTo(box.font.sizeRatio * canvas.height, MEASUREMENT_PRECISION),
    minimumFontSizePx: roundTo(
      Math.max(profile.minimumReadableHeightRatio, box.minimumReadableHeightRatio ?? 0) * canvas.height,
      MEASUREMENT_PRECISION,
    ),
    maxWidthPx: frame.width,
    maxHeightPx: frame.height,
    ...(stepPx === undefined ? {} : { stepPx }),
  };
  return { constraints, ladder: fitLadder(constraints) };
};

export async function prepareRenderModel({
  model,
  measurer,
  defaults,
  service,
  stepPx,
}: PreparationRequest): Promise<PreparedRenderModel> {
  const profile = resolveOutputProfile({ outputType: model.outputType, defaults, service });
  const canvas = canvasFor(profile.aspectRatio);
  const { top, right, bottom, left } = profile.safeArea;
  const safeAreaPx: PixelFrame = {
    x: geometry(left * canvas.width),
    y: geometry(top * canvas.height),
    width: geometry((1 - left - right) * canvas.width),
    height: geometry((1 - top - bottom) * canvas.height),
  };
  const floorPx = roundTo(profile.minimumReadableHeightRatio * canvas.height, MEASUREMENT_PRECISION);
  const letterboxOf = (slide: SlideInput): PixelFrame =>
    letterboxFor(canvas, slide.layoutAspectRatio ?? profile.aspectRatio);

  // Everything every box could be asked, gathered before anything is measured, so one preparation is one
  // trip to the layout engine however many slides it holds.
  const requests: MeasureRequest[] = [];
  for (const slide of model.slides) {
    refuseOwnRatio(slide, `slide ${slide.id}`);
    const letterbox = letterboxOf(slide);
    for (const box of slide.boxes) {
      refuseOwnRatio(box, `box ${box.id} on slide ${slide.id}`);
      if (box.kind !== 'text') continue;
      const frame = frameWithin(letterbox, box.frame);
      const { ladder } = fitFor(box, frame, profile, canvas, stepPx);
      requests.push(...fitRequests(box.text, autoFitStyle(box.font, canvas), ladder, frame.width));
    }
  }

  const measured = await measurer.measure(requests);

  // The second walk is the same walk, in the same order, so the cursor lands each box on the rungs that
  // were collected for it. Nothing is decided here that was not decided above.
  let cursor = 0;
  const findings: ReadinessFinding[] = [];
  const slides: PreparedSlide[] = model.slides.map((slide) => {
    const letterbox = letterboxOf(slide);
    if (slide.layoutAspectRatio !== undefined && !sameRatio(slide.layoutAspectRatio, profile.aspectRatio)) {
      findings.push(
        warning(
          'layout.ratioMismatch',
          { slideId: slide.id },
          `the layout is ${slide.layoutAspectRatio.width}:${slide.layoutAspectRatio.height} and the output is ` +
            `${profile.aspectRatio.width}:${profile.aspectRatio.height}; the frame is letterboxed rather than cropped`,
        ),
      );
    }

    const boxes: PreparedBox[] = slide.boxes.map((box) => {
      const frame = frameWithin(letterbox, box.frame);
      const site = { slideId: slide.id, boxId: box.id };

      if (!contains(safeAreaPx, frame)) {
        findings.push(
          box.importance === 'required'
            ? blocker('content.outsideSafeArea', site, 'required content sits outside the resolved safe area')
            : warning('decoration.outsideSafeArea', site, 'decoration sits outside the resolved safe area'),
        );
      }

      if (box.kind !== 'text') return { id: box.id, kind: 'decoration', importance: box.importance, frame };

      const { constraints, ladder } = fitFor(box, frame, profile, canvas, stepPx);
      const outcome = chooseFit({
        text: box.text,
        ladder,
        metrics: measured.slice(cursor, cursor + ladder.length),
        constraints,
      });
      cursor += ladder.length;

      if (outcome.raisedToMinimum) {
        findings.push(
          blocker(
            'text.belowMinimumReadableSize',
            site,
            `the layout asks for ${outcome.requestedFontSizePx}px, below the effective minimum of ` +
              `${outcome.minimumFontSizePx}px; the minimum was used instead`,
          ),
        );
      }
      if (!outcome.fits) {
        findings.push(
          blocker(
            'text.overflowsAtMinimumReadableSize',
            site,
            `the text does not fit at the effective minimum of ${outcome.minimumFontSizePx}px, and is neither ` +
              'split nor truncated to make it',
          ),
        );
      }

      return {
        id: box.id,
        kind: 'text',
        importance: box.importance,
        frame,
        text: outcome.text,
        // A copy, because the prepared model is deep-frozen on the way out and the caller's own font spec
        // is not this package's to freeze.
        font: { ...box.font },
        fontSizePx: outcome.fontSizePx,
        requestedFontSizePx: outcome.requestedFontSizePx,
        minimumFontSizePx: outcome.minimumFontSizePx,
        lineCount: outcome.metrics.lineCount,
        metrics: outcome.metrics,
        fits: outcome.fits,
      };
    });

    return { id: slide.id, letterbox, boxes };
  });

  return deepFreeze({
    modelId: model.id,
    outputType: profile.outputType,
    profile,
    canvas,
    safeAreaPx,
    minimumFontSizePx: floorPx,
    slides,
    findings,
    readiness: readinessOf(findings),
  });
}
