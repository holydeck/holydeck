// REND-01's one seam between a service item and the renderer: the only place in this application that
// builds a `RenderModelInput`. Pure — spec 04's rehearsal reuses it exactly this way — so every surface
// (this preview, spec 04's offline rehearsal, later the live output) draws from the same box geometry.
//
// Phase A wires this from `ExactPreview` for reading, custom-slide and media items only; the slide-group
// and reading-with-a-real-layout branches below exist and are fully tested here because the shape is
// already known (Slide Layout's contracts types), but nothing calls them with a real layout until Tasks
// 21/22 fetch one. Until then `ExactPreview` always passes `layout: undefined` for a reading, and never
// builds a `slide-group` source at all — `preview.later` covers that kind (see ExactPreview.tsx).

import { aspectRatioOf, type SafeAreaMargins as ServiceSafeArea } from '@holydeck/contracts/snapshots';
import type { LayoutBox, TextBoxStyle } from '@holydeck/contracts/layouts';
import type { CustomSlideBody, CustomSlideBox, ReadingBody } from '@holydeck/contracts/services';
import type { AspectRatio, SafeAreaMargins as RendererSafeArea } from '@holydeck/renderer/output-profile';
import type { FontSpec, RenderModelInput, SlideBox, SlideInput } from '@holydeck/renderer/render-model';

import { fallbackLayout } from './fallback-layout.js';

/** A Slide Layout's own boxes — `SlideLayoutPreview.body`, mapped by binding. */
export type LayoutBody = { readonly boxes: readonly LayoutBox[] };

/** A song-generated slide's block: one language's words. */
type Block = { readonly language: string; readonly text: string };

/** A reading's passage: one translation's words. `languageKey` on a binding is documented as opaque
 *  until SEED-01 seeds it, so a reading Layout keys its boxes by translation abbreviation the same way a
 *  song Layout keys them by spoken language — both are matched below as a common `{key, text}` entry. */
type Passage = { readonly translation: string; readonly text: string };

/** The common shape `layoutBoxFrom`/`slideFrom` match a binding's `languageKey` against, whichever kind
 *  of content it came from. */
type Entry = { readonly key: string; readonly text: string };

export type PreviewSource =
  | {
    readonly kind: 'slide-group';
    readonly group: {
      readonly id: string;
      readonly revision: number;
      readonly slides: readonly { readonly id: string; readonly enabled: boolean; readonly blocks: readonly Block[] }[];
    };
    readonly layout?: LayoutBody;
  }
  | { readonly kind: 'reading'; readonly body: ReadingBody; readonly passages: readonly Passage[]; readonly layout?: LayoutBody }
  | { readonly kind: 'custom-slide'; readonly body: CustomSlideBody }
  | { readonly kind: 'media'; readonly mediaId: string; readonly mediaKind: 'image' | 'video'; readonly intrinsicSize: { readonly width: number; readonly height: number } };

export interface RenderInput {
  readonly model: RenderModelInput;
  readonly defaults: { readonly aspectRatio: AspectRatio; readonly safeArea: RendererSafeArea };
  readonly mediaOf: ReadonlyMap<string, string>;
}

/** The target the preview draws for until an operator picks another; `ExactPreview` overrides it. */
const DEFAULT_OUTPUT_TYPE = 'audience';

const FALLBACK_ASPECT_RATIO: AspectRatio = { width: 16, height: 9 };

/** P-24: the only place a safe-area percent becomes the renderer's fraction. Nothing downstream divides again. */
function rendererSafeArea(margins: ServiceSafeArea): RendererSafeArea {
  return {
    unit: 'percent',
    top: margins.top / 100,
    right: margins.right / 100,
    bottom: margins.bottom / 100,
    left: margins.left / 100,
  };
}

/** The renderer's `FontSpec` reads only what it has a field for; `TextBoxStyle.align`/`verticalAlign`
 *  have no home in the renderer's normalized model (grepped: no box anywhere carries alignment) and are
 *  dropped here rather than invented a place to put them. */
function fontFrom(style: TextBoxStyle): FontSpec {
  return { family: style.fontFamily, weight: style.fontWeight, sizeRatio: style.sizeRatio, lineHeight: style.lineHeight };
}

function frameFrom(frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }) {
  return { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
}

/** Maps one Slide Layout box against the entries (song-slide blocks or reading translations) it may bind
 *  to. A Media box in a Layout carries no binding yet (TMPL-03): nothing is bound to paint, so it
 *  degrades to a decoration placeholder — graded against the safe area, never blocking readiness. */
function layoutBoxFrom(box: LayoutBox, entries: readonly Entry[]): SlideBox {
  const frame = frameFrom(box.frame);
  if (box.kind === 'media') {
    return { id: box.id, kind: 'decoration', frame, importance: box.importance };
  }
  const binding = box.binding;
  const entry = binding.mode === 'keyed' ? entries.find((candidate) => candidate.key === binding.languageKey) : undefined;
  const text = binding.mode === 'static' ? binding.text : entry?.text ?? '';
  return { id: box.id, kind: 'text', text, frame, font: fontFrom(box.style), importance: box.importance };
}

/** One slide's boxes: the layout's own, mapped by binding, or P-26's fallback when there is none. */
function slideFrom(id: string, layout: LayoutBody | undefined, entries: readonly Entry[], safeArea: RendererSafeArea): SlideInput {
  if (layout === undefined || layout.boxes.length === 0) {
    const primary = entries[0];
    return { id, boxes: [fallbackLayout(id, primary?.text ?? '', primary?.key ?? '', safeArea)] };
  }
  return { id, boxes: layout.boxes.map((box) => layoutBoxFrom(box, entries)) };
}

/** A custom-slide box maps 1:1 onto the renderer's; `CUSTOM_MEDIA_FITS` is the renderer's `MEDIA_FITS`
 *  exactly, so `fit` passes through untouched. Nothing in `CustomSlideBox` carries importance, so every
 *  box authored directly onto a custom slide is `required` — there is no lesser tier to place it in. */
function customSlideBoxFrom(box: CustomSlideBox, mediaOf: Map<string, string>): SlideBox {
  const frame = frameFrom(box.frame);
  if (box.kind === 'text') {
    return { id: box.id, kind: 'text', text: box.text, frame, font: fontFrom(box.style), importance: 'required' };
  }
  mediaOf.set(box.id, box.mediaId);
  return {
    id: box.id,
    kind: 'media',
    mediaKind: box.mediaKind,
    frame,
    fit: box.fit,
    importance: 'required',
    intrinsicSize: box.intrinsicSize,
  };
}

/** `layer` is a custom slide's own authored z-order; the renderer paints in declaration order, so this
 *  is the one place that ordering is turned into array order. */
function customSlide(itemId: string, body: CustomSlideBody, mediaOf: Map<string, string>): SlideInput {
  const boxes = [...body.boxes].sort((left, right) => left.layer - right.layer).map((box) => customSlideBoxFrom(box, mediaOf));
  return { id: itemId, boxes };
}

/** A top-level media item: one full-frame box, letterboxed (never cropped) to the media's own ratio via
 *  `SlideInput.layoutAspectRatio` — the only sanctioned channel for a slide's own aspect ratio. A picture
 *  shown on its own is full-bleed by nature, so it is graded as decoration: reaching past the safe area
 *  warns rather than blocking every media item there is. */
function mediaSlide(itemId: string, source: Extract<PreviewSource, { kind: 'media' }>, mediaOf: Map<string, string>): SlideInput {
  const boxId = `${itemId}-media`;
  mediaOf.set(boxId, source.mediaId);
  return {
    id: itemId,
    boxes: [
      {
        id: boxId,
        kind: 'media',
        mediaKind: source.mediaKind,
        frame: { x: 0, y: 0, width: 1, height: 1 },
        fit: 'contain',
        importance: 'decoration',
        intrinsicSize: source.intrinsicSize,
      },
    ],
    layoutAspectRatio: source.intrinsicSize,
  };
}

export function renderInputFor(
  itemId: string,
  source: PreviewSource,
  output: { readonly aspectRatio: string; readonly safeAreaMargins: ServiceSafeArea },
): RenderInput {
  const safeArea = rendererSafeArea(output.safeAreaMargins);
  const aspectRatio = aspectRatioOf(output.aspectRatio) ?? FALLBACK_ASPECT_RATIO;
  const mediaOf = new Map<string, string>();

  const slides: readonly SlideInput[] = ((): readonly SlideInput[] => {
    switch (source.kind) {
      case 'slide-group':
        return source.group.slides
          .filter((slide) => slide.enabled)
          .map((slide) => slideFrom(slide.id, source.layout, slide.blocks.map((block) => ({ key: block.language, text: block.text })), safeArea));
      case 'reading':
        return [slideFrom(itemId, source.layout, source.passages.map((passage) => ({ key: passage.translation, text: passage.text })), safeArea)];
      case 'custom-slide':
        return [customSlide(itemId, source.body, mediaOf)];
      case 'media':
        return [mediaSlide(itemId, source, mediaOf)];
      /* v8 ignore start -- unreachable while PreviewSource's kinds are exhaustive above */
      default: {
        const unreachable: never = source;
        throw new TypeError(`unknown preview source ${String((unreachable as { kind: unknown }).kind)}`);
      }
      /* v8 ignore stop */
    }
  })();

  return {
    model: { id: itemId, outputType: DEFAULT_OUTPUT_TYPE, slides },
    defaults: { aspectRatio, safeArea },
    mediaOf,
  };
}
