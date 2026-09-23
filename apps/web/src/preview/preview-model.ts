// What `ExactPreview` and `Thumbnail` share: turning one service item into a prepared render model. Both
// surfaces draw from this one preparation (WS-10: "both render from the same `prepareRenderModel` input"),
// so a thumbnail can never wrap a line where the preview does not. Fetching lives here — the verses of a
// reading, the manifest and pixel size of a media item — and `render-input.ts` stays the one pure place a
// `RenderModelInput` is built.
//
// Reading, custom-slide and media items are prepared from their own body or content; a song or slide group
// item is prepared from the slide group revision it pins (P-6) and that group's Slide Layout. Sermons still
// answer `'later'`; the caller shows `preview.later` for them.

import { parseCorpusVerses } from '@holydeck/contracts/corpus';
import { parseSlideLayoutBody } from '@holydeck/contracts/layouts';
import { isRecord } from '@holydeck/contracts/problems';
import type { RevisionRef, ServiceItem } from '@holydeck/contracts/services';
import { prepareRenderModel, type PreparedRenderModel } from '@holydeck/renderer/render-model';
import { useEffect, useRef, useState } from 'preact/hooks';

import { API } from '../api-routes.js';
import { request } from '../request.js';
import { saveState, service } from '../state/workspace-store.js';
import { loadOutputDefaults, outputDefaults, resolvedOutput, type OutputDefaults } from '../workspace/output-defaults.js';
import { findItem, type ServiceView } from '../workspace/service-data.js';
import { readSlideGroup } from '../workspace/tabs/song-sources.js';
import { domMeasurer } from './dom-measurer.js';
import { intrinsicSizeOf } from './media-size.js';
import { renderInputFor, type LayoutBody, type PreviewSource } from './render-input.js';

/** The code a failed preparation shows in its disclosure: a server refusal's own code, or a local one. */
export class PreviewError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = 'PreviewError';
  }
}

/** The output types the target selector offers; each only changes the preview's `outputType`. */
export const PREVIEW_TARGETS = ['audience', 'stage', 'singer'] as const;
export type PreviewTarget = (typeof PREVIEW_TARGETS)[number];

export type PreparedPreview = { readonly prepared: PreparedRenderModel; readonly mediaOf: ReadonlyMap<string, string> };

export type PreviewState =
  | { readonly status: 'loading' }
  | { readonly status: 'later' }
  | { readonly status: 'error'; readonly code: string }
  | ({ readonly status: 'ready' } & PreparedPreview);

async function answered(path: string): Promise<unknown> {
  const answer = await request(path);
  if (!answer.ok) throw new PreviewError(answer.code, answer.message);
  return answer.data;
}

/** A passage's verses, in verse order, as one run of text. */
async function passageText(abbr: string, book: string, chapter: number, verses: string): Promise<string> {
  const data = await answered(API.verses(abbr, book, chapter, verses));
  const parsed = parseCorpusVerses(isRecord(data) ? data['verses'] : undefined);
  if (!parsed.ok) throw new PreviewError('client.unreadable_response');
  return Object.entries(parsed.value.verses)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, text]) => text)
    .join(' ');
}

/** Whether the manifest's sniffed media type is a picture or a moving one; fonts are never previewed. */
async function mediaKindOf(mediaId: string): Promise<'image' | 'video'> {
  const data = await answered(API.media(mediaId));
  const manifest = isRecord(data) && isRecord(data['manifest']) ? data['manifest'] : undefined;
  const type = typeof manifest?.['type'] === 'string' ? manifest['type'] : '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  throw new PreviewError('preview.media_unsupported');
}

/** The pinned revision of a slide group, read from its history — whose place in the list is its ordinal. */
async function pinnedGroup(ref: RevisionRef) {
  const data = await answered(API.contentHistory('slideGroup', ref.id));
  const record: unknown = Array.isArray(data) ? data[ref.revision - 1] : undefined;
  const group = readSlideGroup(record);
  if (group === undefined) throw new PreviewError('preview.group_missing');
  return group;
}

/** The group's Slide Layout: the revision a generation pinned, else the Layout's newest. */
async function groupLayout(layoutId: string, generatedFrom: Readonly<Record<string, unknown>> | undefined): Promise<LayoutBody> {
  const pinned = generatedFrom?.['slideLayoutRevision'];
  const data = await answered(API.slideLayout(layoutId, typeof pinned === 'number' ? pinned : undefined));
  const parsed = parseSlideLayoutBody(isRecord(data) ? data['body'] : undefined);
  if (!parsed.ok) throw new PreviewError('client.unreadable_response');
  return parsed.value;
}

/** The item's source for `renderInputFor`, or `'later'` for a kind Phase A does not prepare yet. */
export async function previewSourceFor(item: ServiceItem): Promise<PreviewSource | 'later'> {
  switch (item.kind) {
    case 'custom-slide':
      return { kind: 'custom-slide', body: item.body?.kind === 'custom-slide' ? item.body : { kind: 'custom-slide', boxes: [] } };
    case 'reading': {
      const body = item.body;
      if (body?.kind !== 'reading') return 'later';
      const translations = [body.translation, ...body.compare];
      const passages: { translation: string; text: string }[] = [];
      // Sequential, so the stacked order is always the reading's own order.
      for (const translation of translations) {
        passages.push({ translation, text: await passageText(translation, body.book, body.chapter, body.verses) });
      }
      return { kind: 'reading', body, passages };
    }
    case 'media': {
      const mediaId = item.content?.id;
      if (mediaId === undefined) throw new PreviewError('preview.media_missing');
      const mediaKind = await mediaKindOf(mediaId);
      let intrinsicSize;
      try {
        intrinsicSize = await intrinsicSizeOf(mediaId, mediaKind);
      } catch {
        throw new PreviewError('media.derivative_missing');
      }
      return { kind: 'media', mediaId, mediaKind, intrinsicSize };
    }
    case 'song':
    case 'slide-group': {
      if (item.content === undefined) throw new PreviewError('preview.group_missing');
      const group = await pinnedGroup(item.content);
      const layout = await groupLayout(group.body.slideLayoutId, group.body.generatedFrom);
      return {
        kind: 'slide-group',
        group: {
          id: group.id,
          revision: item.content.revision,
          slides: group.body.slides.map((slide) => ({
            id: slide.id,
            enabled: slide.enabled,
            blocks: slide.languageBlocks.map((block) => ({ language: block.languageKey, text: block.text })),
          })),
        },
        layout,
      };
    }
    default:
      return 'later';
  }
}

/** Prepares one item for one target at the service's resolved output profile. */
export async function preparePreview(
  view: ServiceView,
  item: ServiceItem,
  target: PreviewTarget,
  defaults: OutputDefaults,
): Promise<PreparedPreview | 'later'> {
  const source = await previewSourceFor(item);
  if (source === 'later') return 'later';
  const input = renderInputFor(item.id, source, resolvedOutput(view, defaults));
  const measurer = domMeasurer();
  try {
    const prepared = await prepareRenderModel({
      model: { ...input.model, outputType: target },
      measurer,
      service: { aspectRatio: input.defaults.aspectRatio, safeArea: input.defaults.safeArea },
    });
    return { prepared, mediaOf: input.mediaOf };
  } finally {
    await measurer.close();
  }
}

/** The CSS `aspect-ratio` a placeholder takes before anything is drawn: the service's resolved ratio. */
export function placeholderRatio(view: ServiceView | undefined): string {
  const defaults = outputDefaults.value;
  const ratio = view === undefined || defaults === undefined ? '16:9' : resolvedOutput(view, defaults).aspectRatio;
  return ratio.replace(':', ' / ');
}

function codeOf(error: unknown): string {
  if (error instanceof PreviewError) return error.code;
  return error instanceof Error ? error.name : 'preview.failed';
}

/**
 * The live preview state of one item. Re-prepares whenever the item, the service's output or the target
 * changes, and on `retry`. Offline, nothing is re-fetched: the last render stays on screen read-only.
 */
export function usePreview(itemId: string, target: PreviewTarget, active = true): { readonly state: PreviewState; readonly retry: () => void } {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const last = useRef<PreviewState>(state);
  last.current = state;

  const view = service.value;
  const item = view === undefined ? undefined : findItem(view, itemId);
  // Keys, not identities: every save hands back a fresh service object, and only a change to what this
  // item draws from is a reason to redraw.
  const itemKey = item === undefined ? '' : JSON.stringify(item);
  const outputKey = JSON.stringify(view?.output ?? {});
  const defaults = outputDefaults.value;
  const offline = saveState.value === 'offline';

  useEffect(() => {
    if (!active || view === undefined || item === undefined) return undefined;
    if (offline && last.current.status === 'ready') return undefined;
    let current = true;
    setState({ status: 'loading' });
    // Defaults first, on their own: their arrival re-runs this effect, so preparing before they land
    // would fetch the item's reads twice.
    if (defaults === undefined) {
      void loadOutputDefaults().then(() => {
        if (current && outputDefaults.value === undefined) setState({ status: 'error', code: 'preview.defaults_unavailable' });
      });
      return (): void => { current = false; };
    }
    preparePreview(view, item, target, defaults).then(
      (answer) => { if (current) setState(answer === 'later' ? { status: 'later' } : { status: 'ready', ...answer }); },
      (error: unknown) => { if (current) setState({ status: 'error', code: codeOf(error) }); },
    );
    return (): void => { current = false; };
  }, [active, itemKey, outputKey, defaults, target, attempt, offline]);

  return { state, retry: () => setAttempt((count) => count + 1) };
}
