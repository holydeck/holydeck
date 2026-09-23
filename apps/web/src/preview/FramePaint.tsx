// The one place a `RenderedBox` becomes DOM: absolutely positioned nodes scaled by `paint.scale`. A box's
// own `frame` is already resolved into the canvas's coordinate space (REND-01 bakes the letterbox offset
// in), so nothing here decides layout — it only paints what preparation already decided.

import type { JSX } from 'preact';

import type { RenderedBox } from '@holydeck/renderer/renderer';
import type { SurfaceRender } from '@holydeck/renderer/surfaces';

import { API } from '../api-routes.js';

export interface FramePaintProps {
  readonly render: SurfaceRender;
  readonly mediaOf: ReadonlyMap<string, string>;
  readonly label: string;
}

type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

function rectStyle(rect: Rect, scale: number): JSX.CSSProperties {
  return {
    position: 'absolute',
    left: `${rect.x * scale}px`,
    top: `${rect.y * scale}px`,
    width: `${rect.width * scale}px`,
    height: `${rect.height * scale}px`,
  };
}

function TextBoxView({ box, scale }: { readonly box: RenderedBox; readonly scale: number }): JSX.Element {
  return (
    <div
      style={{
        ...rectStyle(box.frame, scale),
        overflow: 'hidden',
        fontFamily: box.fontFamily,
        fontWeight: box.fontWeight,
        fontSize: `${(box.fontSizePx ?? 0) * scale}px`,
        lineHeight: `${(box.lineHeightPx ?? 0) * scale}px`,
        // The server measurer wraps with break-word and spaces letters; painting without either lets a
        // long word or a spaced theme run past the lines preparation counted.
        overflowWrap: 'break-word',
        ...(box.letterSpacingPx === undefined ? {} : { letterSpacing: `${box.letterSpacingPx * scale}px` }),
      }}
    >
      {box.text}
    </div>
  );
}

function MediaBoxView({ box, scale, mediaId }: { readonly box: RenderedBox; readonly scale: number; readonly mediaId: string | undefined }): JSX.Element {
  const rect = box.mediaRect;
  const src = mediaId === undefined ? undefined : box.mediaKind === 'video' ? API.mediaDerivative(mediaId, 'poster') : API.mediaContent(mediaId);
  return (
    <div style={{ ...rectStyle(box.frame, scale), overflow: 'hidden' }}>
      {src !== undefined && rect !== undefined ? (
        <img
          src={src}
          alt=""
          style={{
            position: 'absolute',
            left: `${(rect.x - box.frame.x) * scale}px`,
            top: `${(rect.y - box.frame.y) * scale}px`,
            width: `${rect.width * scale}px`,
            height: `${rect.height * scale}px`,
          }}
        />
      ) : null}
    </div>
  );
}

function BoxView({ box, scale, mediaOf }: { readonly box: RenderedBox; readonly scale: number; readonly mediaOf: ReadonlyMap<string, string> }): JSX.Element {
  if (box.kind === 'text') return <TextBoxView box={box} scale={scale} />;
  if (box.kind === 'media') return <MediaBoxView box={box} scale={scale} mediaId={mediaOf.get(box.id)} />;
  return <div style={rectStyle(box.frame, scale)} />;
}

/** Draws Phase A's single-slide preview (`render.frame.slides[0]`). A multi-slide render model exists
 *  only once slide-group sources are wired (Tasks 21/22) — a slide index belongs here when that lands. */
export function FramePaint({ render, mediaOf, label }: FramePaintProps): JSX.Element {
  const boxes = render.frame.slides[0]?.boxes ?? [];
  const text = boxes
    .filter((box): box is RenderedBox & { text: string } => box.kind === 'text' && box.text !== undefined)
    .map((box) => box.text)
    .join(' ');

  return (
    <div
      role="img"
      aria-label={label}
      style={{ position: 'relative', width: `${render.paint.widthPx}px`, height: `${render.paint.heightPx}px`, overflow: 'hidden' }}
    >
      {boxes.map((box) => (
        <BoxView key={box.id} box={box} scale={render.paint.scale} mediaOf={mediaOf} />
      ))}
      <span class="visually-hidden">{text}</span>
    </div>
  );
}
