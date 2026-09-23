// The renderer. Every slide this system ever puts in front of anybody comes out of this function.
//
// It takes a prepared model and produces a frame: the canvas, the resolved safe area an editor sees drawn
// over a preview, and, per slide, the letterboxed area the layout lands in and the boxes to paint inside
// it, in the order they were declared. It reads no defaults, measures nothing, and makes no choices —
// preparation already made them and froze them. That is deliberate and is the whole argument for why the
// four surfaces cannot drift: there is no decision left here for them to make differently.
//
// `serializeFrame` is the form the plan's first test compares. Canonical JSON — sorted keys, no
// whitespace — is already this repository's one canonical form, so an unchanged frame is the same bytes
// twice, the same way an unchanged export is (ADR 0001).

import { canonicalJson } from '@holydeck/contracts/canonical';

import { deepFreeze } from './internal/freeze.js';
import { MEASUREMENT_PRECISION, geometry, roundTo } from './internal/numbers.js';

import type { MediaFit } from './media-fit.js';
import type { AspectRatio, Canvas } from './output-profile.js';
import type { Readiness, ReadinessFinding } from './readiness.js';
import type {
  BoxImportance,
  MediaKind,
  MediaPlaybackState,
  MediaRecovery,
  PixelFrame,
  PreparedBox,
  PreparedMediaAudio,
  PreparedRenderModel,
} from './render-model.js';

export interface RenderedBox {
  readonly id: string;
  readonly kind: 'text' | 'decoration' | 'media';
  readonly importance: BoxImportance;
  /** Paint order, which is declaration order; a surface reordering boxes would be a different render. */
  readonly order: number;
  readonly frame: PixelFrame;
  readonly text?: string;
  readonly fontFamily?: string;
  readonly fontWeight?: number;
  readonly fontSizePx?: number;
  readonly lineHeightPx?: number;
  readonly lineCount?: number;
  /** Present only when the layout spaces its letters: the same canvas pixels preparation measured with. */
  readonly letterSpacingPx?: number;
  readonly mediaKind?: MediaKind;
  readonly fit?: MediaFit;
  /** Where to draw the picture inside `frame`; `cover` and `original` reach past it, and are clipped. */
  readonly mediaRect?: PixelFrame;
  readonly audio?: PreparedMediaAudio;
  readonly playbackState?: MediaPlaybackState;
  /** What to offer somebody in front of a stalled box, so a failure is never a blank rectangle. */
  readonly recovery?: MediaRecovery;
}

export interface RenderedSlide {
  readonly id: string;
  readonly index: number;
  readonly letterbox: PixelFrame;
  readonly boxes: readonly RenderedBox[];
}

export interface RenderFrame {
  readonly modelId: string;
  readonly outputType: string;
  readonly aspectRatio: AspectRatio;
  readonly canvas: Canvas;
  readonly safeArea: PixelFrame;
  readonly minimumFontSizePx: number;
  readonly slides: readonly RenderedSlide[];
  readonly findings: readonly ReadinessFinding[];
  readonly readiness: Readiness;
}

const paintBox = (box: PreparedBox, order: number, canvas: Canvas): RenderedBox => {
  const common = { id: box.id, importance: box.importance, order, frame: box.frame };
  if (box.kind === 'decoration') return { ...common, kind: 'decoration' };
  // A media box is painted whatever its playback state says, geometry and all. Withholding the rectangle
  // from a surface because the file would not load is how a slide becomes a hole nobody can act on.
  if (box.kind === 'media') {
    return {
      ...common,
      kind: 'media',
      mediaKind: box.mediaKind,
      fit: box.fit,
      mediaRect: box.mediaRect,
      ...(box.audio === undefined ? {} : { audio: box.audio }),
      playbackState: box.playbackState,
      recovery: box.recovery,
    };
  }
  return {
    ...common,
    kind: 'text',
    text: box.text,
    fontFamily: box.font.family,
    fontWeight: box.font.weight,
    fontSizePx: box.fontSizePx,
    lineHeightPx: geometry(box.fontSizePx * box.font.lineHeight),
    lineCount: box.lineCount,
    ...(box.font.letterSpacingRatio === undefined
      ? {}
      : { letterSpacingPx: roundTo(box.font.letterSpacingRatio * canvas.height, MEASUREMENT_PRECISION) }),
  };
};

export function renderPrepared(prepared: PreparedRenderModel): RenderFrame {
  return deepFreeze({
    modelId: prepared.modelId,
    outputType: prepared.outputType,
    aspectRatio: { width: prepared.profile.aspectRatio.width, height: prepared.profile.aspectRatio.height },
    canvas: { width: prepared.canvas.width, height: prepared.canvas.height },
    safeArea: prepared.safeAreaPx,
    minimumFontSizePx: prepared.minimumFontSizePx,
    slides: prepared.slides.map((slide, index) => ({
      id: slide.id,
      index,
      letterbox: slide.letterbox,
      boxes: slide.boxes.map((box, order) => paintBox(box, order, prepared.canvas)),
    })),
    findings: prepared.findings,
    readiness: prepared.readiness,
  });
}

export function serializeFrame(frame: RenderFrame): string {
  return canonicalJson(frame);
}

export function frameBytes(frame: RenderFrame): Uint8Array {
  return new TextEncoder().encode(serializeFrame(frame));
}
