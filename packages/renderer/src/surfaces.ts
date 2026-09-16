// The four surfaces REND-01 names, and the one thing they are allowed to differ in.
//
// An editor preview is a live node scaled into a pane; a thumbnail is an offscreen raster at whatever
// width a list wants; an output view fills a display of unknown shape; the offline presenter has no
// options and, crucially, no browser. Four genuinely different calling conventions — and every one of
// them ends at `renderPrepared`, so the frame each receives is the same frame, byte for byte. What a
// surface gets to decide is `paint`: how many device pixels that frame is drawn into, and at what scale.
// Nothing about the scale reaches the frame, which is the reason a 320px thumbnail wraps a lyric exactly
// where the wall does.
//
// Later tasks wire real surfaces to these entry points. None of them may add a second renderer.

import { renderPrepared } from './renderer.js';

import type { Canvas } from './output-profile.js';
import type { PreparedRenderModel } from './render-model.js';
import type { RenderFrame } from './renderer.js';

export const RENDER_SURFACES = ['editor-preview', 'thumbnail', 'output-view', 'offline-render'] as const;

export type RenderSurface = (typeof RENDER_SURFACES)[number];

export interface PaintTarget {
  readonly widthPx: number;
  readonly heightPx: number;
  /** Device pixels per reference pixel. Applied when painting, never when laying out. */
  readonly scale: number;
}

export interface SurfaceRender {
  readonly surface: RenderSurface;
  readonly frame: RenderFrame;
  readonly paint: PaintTarget;
}

export const DEFAULT_THUMBNAIL_WIDTH_PX = 480;

const paintAt = (canvas: Canvas, scale: number): PaintTarget => ({
  widthPx: Math.round(canvas.width * scale),
  heightPx: Math.round(canvas.height * scale),
  scale,
});

export interface EditorPreviewOptions {
  /** Width of the pane the preview is scaled into; the reference canvas when the editor does not say. */
  readonly viewportWidthPx?: number;
}

export interface ThumbnailOptions {
  readonly widthPx?: number;
}

export interface OutputViewOptions {
  readonly displayWidthPx?: number;
  readonly displayHeightPx?: number;
}

/** A live editor preview: one frame, scaled to the width of the pane it is shown in. */
export function renderEditorPreview(
  prepared: PreparedRenderModel,
  { viewportWidthPx }: EditorPreviewOptions = {},
): SurfaceRender {
  const canvas = prepared.canvas;
  return {
    surface: 'editor-preview',
    frame: renderPrepared(prepared),
    paint: paintAt(canvas, (viewportWidthPx ?? canvas.width) / canvas.width),
  };
}

/** An offscreen raster job: the same frame at whatever width the list showing it asked for. */
export function renderThumbnail(prepared: PreparedRenderModel, { widthPx }: ThumbnailOptions = {}): SurfaceRender {
  const canvas = prepared.canvas;
  return {
    surface: 'thumbnail',
    frame: renderPrepared(prepared),
    paint: paintAt(canvas, (widthPx ?? DEFAULT_THUMBNAIL_WIDTH_PX) / canvas.width),
  };
}

/** A display of unknown shape: the frame fits inside it whole rather than being cropped to fill it. */
export function renderOutputView(
  prepared: PreparedRenderModel,
  { displayWidthPx, displayHeightPx }: OutputViewOptions = {},
): SurfaceRender {
  const canvas = prepared.canvas;
  const width = displayWidthPx ?? canvas.width;
  const height = displayHeightPx ?? canvas.height;
  return {
    surface: 'output-view',
    frame: renderPrepared(prepared),
    paint: paintAt(canvas, Math.min(width / canvas.width, height / canvas.height)),
  };
}

/**
 * The offline presenter, and the prepared snapshot it replays. No options, no defaults to resolve and no
 * browser to measure with — everything it needs was frozen into the prepared model.
 */
export function renderOfflineRender(prepared: PreparedRenderModel): SurfaceRender {
  return { surface: 'offline-render', frame: renderPrepared(prepared), paint: paintAt(prepared.canvas, 1) };
}

export type SurfaceOptions = EditorPreviewOptions & ThumbnailOptions & OutputViewOptions;

export function renderForSurface(
  surface: RenderSurface,
  prepared: PreparedRenderModel,
  options: SurfaceOptions = {},
): SurfaceRender {
  switch (surface) {
    case 'editor-preview':
      return renderEditorPreview(prepared, options);
    case 'thumbnail':
      return renderThumbnail(prepared, options);
    case 'output-view':
      return renderOutputView(prepared, options);
    default:
      return renderOfflineRender(prepared);
  }
}
