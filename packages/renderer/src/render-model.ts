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
// Administration owns the ratio, the margins, the readable floor and the volume bound, and a service may
// override them. Items and slides may not, and this file refuses a model that tries: a slide carrying an
// `aspectRatio` is a defect in whatever produced it, not a preference to be honoured.

import { autoFitStyle, chooseFit, fitLadder, fitRequests } from './auto-fit.js';
import { deepFreeze } from './internal/freeze.js';
import { geometry, roundTo } from './internal/numbers.js';
import { isScalableSize, mediaRectFor } from './media-fit.js';
import { MEASUREMENT_PRECISION } from './measure.js';
import { canvasFor, resolveOutputProfile } from './output-profile.js';
import { blocker, readinessOf, warning } from './readiness.js';

import type { FitConstraints } from './auto-fit.js';
import type { IntrinsicSize, MediaFit } from './media-fit.js';
import type { MeasureRequest, TextMeasurer, TextMetrics } from './measure.js';
import type {
  AdministrativeRenderDefaults,
  AspectRatio,
  Canvas,
  ResolvedOutputProfile,
  ServiceRenderOverrides,
} from './output-profile.js';
import type { FindingSite, Readiness, ReadinessFinding } from './readiness.js';

export type { IntrinsicSize, MediaFit } from './media-fit.js';
export { MEDIA_FITS, MediaGeometryError } from './media-fit.js';

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

/** A still and a moving picture are laid out identically; only the second one can be heard. */
export type MediaKind = 'image' | 'video';

/** MEDI-02's audio settings. A caller's request, not the last word: the volume is bounded below. */
export interface MediaAudio {
  readonly loop: boolean;
  readonly muted: boolean;
  /** As a fraction of the output's own volume, bounded by the resolved profile. */
  readonly volume: number;
}

/**
 * What the presenting surface saw happen. A pure function cannot observe a browser refusing to autoplay
 * or a file failing to load, so the surface that did observe it hands the fact back in and re-prepares;
 * nothing here goes looking.
 */
export type MediaPlaybackState = 'ok' | 'autoplay-blocked' | 'load-error';

export interface MediaBox {
  readonly id: string;
  readonly kind: 'media';
  readonly mediaKind: MediaKind;
  readonly frame: NormalizedFrame;
  readonly fit: MediaFit;
  readonly importance: BoxImportance;
  /** Supplied by the caller: this package reads no files and measures no pictures. */
  readonly intrinsicSize: IntrinsicSize;
  /** Video only; an image carrying one is a defect in whatever produced the box. */
  readonly audio?: MediaAudio;
  /** Absent means nothing has gone wrong, which is the same thing as `'ok'`. */
  readonly playbackState?: MediaPlaybackState;
}

export type SlideBox = TextBox | DecorationBox | MediaBox;

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

/**
 * The audio a surface plays, after the bound has been applied. The request is kept beside the answer for
 * the same reason a text box keeps its requested size beside the size it got: an editor showing why the
 * volume is not what the item asked for needs both numbers, not a finding to parse.
 */
export interface PreparedMediaAudio {
  readonly loop: boolean;
  readonly muted: boolean;
  /** The volume to play at: what was asked for, clamped into the bound. */
  readonly volume: number;
  readonly requestedVolume: number;
  readonly maximumVolume: number;
}

/**
 * What a surface may offer somebody standing in front of a stalled slide. `'none'` is the ordinary case;
 * the other two say which affordance recovers this particular failure, so the surface shows a way back
 * rather than a dead rectangle. Never absent, whatever the playback state.
 */
export type MediaRecovery = 'none' | 'resume-playback' | 'retry-load';

export interface PreparedMediaBox extends PreparedBoxBase {
  readonly kind: 'media';
  readonly mediaKind: MediaKind;
  readonly fit: MediaFit;
  readonly intrinsicSize: IntrinsicSize;
  /** Where the media itself lands inside `frame`. `cover` and `original` may reach past it. */
  readonly mediaRect: PixelFrame;
  readonly audio?: PreparedMediaAudio;
  readonly playbackState: MediaPlaybackState;
  readonly recovery: MediaRecovery;
}

export type PreparedBox = PreparedTextBox | PreparedDecorationBox | PreparedMediaBox;

/** Narrows a prepared box to the one that carries type, for callers walking a slide. */
export const isPreparedTextBox = (box: PreparedBox): box is PreparedTextBox => box.kind === 'text';

/** Narrows a prepared box to the one that carries a picture. */
export const isPreparedMediaBox = (box: PreparedBox): box is PreparedMediaBox => box.kind === 'media';

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

// Letterboxing a layout is the same computation a `contain` media box gets: scale a shape to fit inside
// a rectangle whole, and centre it. One function, so the bars beside a 4:3 layout and the bars beside a
// 4:3 video cannot land in different places.
const letterboxFor = (canvas: Canvas, ratio: AspectRatio): PixelFrame =>
  mediaRectFor({ x: 0, y: 0, width: canvas.width, height: canvas.height }, ratio, 'contain');

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

// An image has no soundtrack to configure, so audio settings on one are a producer's mistake rather than
// a preference — refused for the same reason a slide's own aspect ratio is, and not quietly dropped. A
// volume that is not a number is refused here too: clamping it would leave a `NaN` in a frame whose bytes
// are supposed to be comparable.
const refuseUnplayableAudio = (box: MediaBox, what: string): void => {
  if (box.audio === undefined) return;
  if (box.mediaKind !== 'video') {
    throw new RenderModelError(`${what} is an image carrying audio settings; only a video can be heard`);
  }
  if (!Number.isFinite(box.audio.volume)) {
    throw new RenderModelError(`${what} asks to play at a volume of ${box.audio.volume}, which is not a number`);
  }
};

// A shape with nothing to scale — a picture of no width, a layout ratio of 0:9 — is refused here with the
// rest of the producer defects rather than left to the geometry helper, which would otherwise be the one
// thing in this file throwing something other than a `RenderModelError` at a caller sorting bad input from
// an unexpected crash. `mediaRectFor` keeps its own guard for callers that reach it directly.
const refuseUnscalableSize = (size: IntrinsicSize, what: string): void => {
  if (!isScalableSize(size)) {
    throw new RenderModelError(`${what} is ${size.width}x${size.height}, which is not two positive numbers`);
  }
};

/** Which affordance gets a stalled slide going again. Every state has one, including the good one. */
const RECOVERY: Readonly<Record<MediaPlaybackState, MediaRecovery>> = Object.freeze({
  ok: 'none',
  'autoplay-blocked': 'resume-playback',
  'load-error': 'retry-load',
});

/**
 * The volume a surface actually plays at. Out-of-bound is clamped and said out loud rather than thrown:
 * the same shape as text below the readable floor, for the same reason — the slide still shows, and an
 * editor gets to see what was corrected instead of an error page in place of the service. Both ends of the
 * range say so, because a correction nobody is told about is how a producer comes to believe a defect was
 * honoured.
 */
const boundedAudio = (
  audio: MediaAudio | undefined,
  maximumVolume: number,
  site: FindingSite,
  findings: ReadinessFinding[],
): PreparedMediaAudio | undefined => {
  if (audio === undefined) return undefined;

  if (audio.volume > maximumVolume) {
    findings.push(
      warning(
        'media.volumeAboveBound',
        site,
        `the item asks to play at ${audio.volume}, above the resolved bound of ${maximumVolume}; the bound ` +
          'was used instead',
      ),
    );
  }
  if (audio.volume < 0) {
    findings.push(
      warning(
        'media.volumeBelowSilence',
        site,
        `the item asks to play at ${audio.volume}, below silence; silence was used instead`,
      ),
    );
  }

  return {
    loop: audio.loop,
    muted: audio.muted,
    volume: Math.min(Math.max(audio.volume, 0), maximumVolume),
    requestedVolume: audio.volume,
    maximumVolume,
  };
};

/**
 * A media box, decided. The geometry is computed the same way whatever the playback state says, because a
 * box that failed to load still occupies its rectangle: a surface with a frame to draw can put a way back
 * inside it, and a surface handed nothing can only leave a hole.
 */
const prepareMedia = (
  box: MediaBox,
  frame: PixelFrame,
  maximumVolume: number,
  site: FindingSite,
  findings: ReadinessFinding[],
): PreparedMediaBox => {
  const playbackState = box.playbackState ?? 'ok';
  const audio = boundedAudio(box.audio, maximumVolume, site, findings);

  return {
    id: box.id,
    kind: 'media',
    importance: box.importance,
    frame,
    mediaKind: box.mediaKind,
    fit: box.fit,
    // A copy, for the same reason the font spec is copied: the prepared model is frozen on the way out
    // and the caller's own object is not this package's to freeze.
    intrinsicSize: { width: box.intrinsicSize.width, height: box.intrinsicSize.height },
    mediaRect: mediaRectFor(frame, box.intrinsicSize, box.fit),
    ...(audio === undefined ? {} : { audio }),
    playbackState,
    recovery: RECOVERY[playbackState],
  };
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
    if (slide.layoutAspectRatio !== undefined) {
      refuseUnscalableSize(slide.layoutAspectRatio, `the layout aspect ratio of slide ${slide.id}`);
    }
    const letterbox = letterboxOf(slide);
    for (const box of slide.boxes) {
      const what = `box ${box.id} on slide ${slide.id}`;
      refuseOwnRatio(box, what);
      if (box.kind === 'media') {
        refuseUnscalableSize(box.intrinsicSize, `the intrinsic size of ${what}`);
        refuseUnplayableAudio(box, what);
      }
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

      // The frame is what the safe area grades, deliberately never a media box's `mediaRect`: `cover` and
      // `original` are meant to reach past their frame, and whether that overflow is hidden is the painting
      // surface's concern. Grading it here would report a blocker for a box doing exactly what was asked.
      if (!contains(safeAreaPx, frame)) {
        findings.push(
          box.importance === 'required'
            ? blocker('content.outsideSafeArea', site, 'required content sits outside the resolved safe area')
            : warning('decoration.outsideSafeArea', site, 'decoration sits outside the resolved safe area'),
        );
      }

      if (box.kind === 'decoration') return { id: box.id, kind: 'decoration', importance: box.importance, frame };
      if (box.kind === 'media') return prepareMedia(box, frame, profile.maximumAudioVolume, site, findings);

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
