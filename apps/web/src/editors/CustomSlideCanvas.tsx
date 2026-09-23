// WS-09's Custom Slide canvas: text and media boxes placed freely on one slide. Every way of changing a
// box — keys, drag, the eight resize handles, the inline text field, the toolbar and the numeric fields in
// the Properties panel — goes through `canvas-ops`, so they share one undo stack and one autosave (800 ms
// after the last step, P-12); an undo or redo is one more step and so one more save. Arrow keys move a box
// 4 px on screen (Shift: 16 px) at the current zoom, which is a share of the slide, not a fixed amount.
// The boxes here are an editing surface; the exact render is `ExactPreview` below the canvas. The
// Properties panel reads the selected box through `activeCanvas`, because it lives in another region.

import { parseMediaManifestEntry } from '@holydeck/contracts/media';
import { isRecord } from '@holydeck/contracts/problems';
import type { CustomMediaFit, CustomSlideBody, CustomSlideBox } from '@holydeck/contracts/services';
import type { MessageKey } from '@holydeck/localization/messages';
import { signal, type Signal } from '@preact/signals';
import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { API } from '../api-routes.js';
import { can } from '../app-state.js';
import { showToast } from '../components/toast.js';
import { t } from '../i18n.js';
import { placeholderRatio } from '../preview/preview-model.js';
import { isReadOnly, mutate, service } from '../state/workspace-store.js';
import { findItem } from '../workspace/service-data.js';
import { MediaTab, type MediaPick } from '../workspace/tabs/MediaTab.js';
import {
  apply, clampFrame, duplicateBox, invert, nextLayer, nudge, relayer, resize, type CanvasOp, type CanvasPx, type ResizeHandle,
} from './canvas-ops.js';
import { createUndoStack, useUndoKeys } from './undo-stack.js';
import { useAutosave } from './use-autosave.js';

/** The slide's width on screen at 100% zoom: a full-HD output's own pixels. */
export const BASE_WIDTH = 1920;

/** The zoom range and step, in percent. */
export const ZOOM = Object.freeze({ min: 25, max: 400, step: 25, initial: 50 });

const HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** How a media box's fit is shown on the canvas; `original` draws the asset at its own size. */
const OBJECT_FIT: Readonly<Record<CustomMediaFit, string>> = { original: 'none', contain: 'contain', cover: 'cover', stretch: 'fill' };

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

const EMPTY_SLIDE: CustomSlideBody = { kind: 'custom-slide', boxes: [] };

/** What the Properties panel needs from the open canvas: the selected box and a way to change it. */
export type CanvasController = {
  readonly box: CustomSlideBox | undefined;
  readonly readOnly: boolean;
  /** Applies one change to the selected box as an undoable step; answers the box as it now stands. */
  change(label: MessageKey, after: Partial<CustomSlideBox>): CustomSlideBox | undefined;
};

/** The canvas currently open in the Editor region, if any. */
export const activeCanvas: Signal<CanvasController | undefined> = signal(undefined);

type Step = { readonly ops: readonly CanvasOp[]; readonly label: MessageKey };
type Drag = { readonly box: CustomSlideBox; readonly handle: ResizeHandle | undefined; readonly x: number; readonly y: number; readonly px: CanvasPx };
/** An image or video from the media library that a box or background can show. */
export type MediaChoice = { readonly id: string; readonly kind: 'image' | 'video' };

/** A box's accessible name: its kind and the first few words it says, or the asset it shows. */
export function boxLabel(box: CustomSlideBox): string {
  if (box.kind === 'media') return t('canvas.mediaBox', { title: box.mediaId });
  return t('canvas.textBox', { text: box.text.trim().split(/\s+/u).slice(0, 4).join(' ') });
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The usable images and videos in a media listing, or undefined when the listing is unreadable. */
export const readMediaChoices = (data: unknown): MediaChoice[] | undefined => {
  if (!Array.isArray(data)) return undefined;
  return data.flatMap((record): MediaChoice[] => {
    const parsed = parseMediaManifestEntry(isRecord(record) ? record.manifest : undefined, 'media');
    if (!parsed.ok || parsed.value.processingState === 'failed') return [];
    const kind = parsed.value.type.startsWith('image/') ? 'image' : parsed.value.type.startsWith('video/') ? 'video' : undefined;
    return kind === undefined ? [] : [{ id: parsed.value.id, kind }];
  });
};

function InlineText({ box, onDone }: { readonly box: CustomSlideBox & { kind: 'text' }; readonly onDone: (text: string | undefined) => void }): JSX.Element {
  const { frame } = box;
  const field = useRef<HTMLTextAreaElement>(null);
  // Escape moves focus back to the box, and that blur must not then save what Escape just discarded.
  const done = useRef(false);
  const finish = (text: string | undefined): void => {
    if (done.current) return;
    done.current = true;
    onDone(text);
  };
  useEffect(() => field.current?.focus(), []);
  return (
    <textarea
      class="canvas-inline-text" aria-label={t('canvas.text.edit')} defaultValue={box.text} ref={field}
      style={{ left: `${frame.x * 100}%`, top: `${frame.y * 100}%`, width: `${frame.width * 100}%`, height: `${frame.height * 100}%` }}
      onBlur={(event) => finish(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') finish(undefined);
      }}
    />
  );
}

const STATUS_KEYS: Readonly<Record<string, MessageKey | undefined>> = {
  pending: 'editor.saving', saving: 'editor.saving', saved: 'editor.saved', failed: 'editor.saveFailed',
};

/** Edits one custom slide's boxes in place. */
export function CustomSlideCanvas({ itemId }: { readonly itemId: string }): JSX.Element | null {
  const view = service.value;
  const item = view === undefined ? undefined : findItem(view, itemId);
  const [slide, setSlide] = useState<CustomSlideBody>(() => (item?.body?.kind === 'custom-slide' ? item.body : EMPTY_SLIDE));
  const latest = useRef(slide);
  const [dirty, setDirty] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [zoom, setZoom] = useState<number>(ZOOM.initial);
  const [live, setLive] = useState<{ readonly id: string; readonly frame: CustomSlideBox['frame'] } | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const stack = useMemo(() => createUndoStack<Step>(), []);
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const boxRefs = useRef(new Map<string, HTMLDivElement>());
  const readOnly = isReadOnly.value;

  const [ratioW, ratioH] = placeholderRatio(view).split('/').map(Number) as [number, number];
  const px: CanvasPx = { width: (BASE_WIDTH * zoom) / 100, height: (BASE_WIDTH * zoom * ratioH) / (100 * ratioW) };

  const serviceId = view?.id;
  const save = useCallback(async (next: CustomSlideBody): Promise<boolean> => {
    if (serviceId === undefined) return false;
    return (await mutate(API.itemAction(serviceId, itemId, 'body'), { method: 'PUT', body: next })).ok;
  }, [serviceId, itemId]);
  const complete = slide.boxes.every((box) => box.kind !== 'text' || box.text.trim() !== '');
  const { state, flush } = useAutosave(slide, save, { enabled: dirty && complete && !readOnly });

  const run = useCallback((ops: readonly CanvasOp[]): void => {
    latest.current = ops.reduce(apply, latest.current);
    setSlide(latest.current);
    setDirty(true);
  }, []);
  const commit = (step: Step): void => {
    if (step.ops.length === 0) return;
    stack.push(step);
    run(step.ops);
  };
  const replay = useCallback((step: Step, direction: 'undo' | 'redo'): void => {
    run(direction === 'undo' ? [...step.ops].reverse().map(invert) : step.ops);
    showToast({ message: t(direction === 'undo' ? 'editor.undone' : 'editor.redone', { action: t(step.label) }) });
  }, [run]);
  useUndoKeys(stack, replay, root);

  const change = (id: string, label: MessageKey, after: Partial<CustomSlideBox>): CustomSlideBox | undefined => {
    const box = latest.current.boxes.find((candidate) => candidate.id === id);
    if (box === undefined || readOnly) return box;
    const next: Partial<CustomSlideBox> = after.frame === undefined ? after : { ...after, frame: clampFrame(after.frame) };
    const keys = Object.keys(next) as (keyof CustomSlideBox)[];
    if (keys.every((key) => sameValue(box[key], next[key]))) return box;
    const before = Object.fromEntries(keys.map((key) => [key, box[key]])) as Partial<CustomSlideBox>;
    commit({ ops: [{ kind: 'change', id, before, after: next, label }], label });
    return latest.current.boxes.find((candidate) => candidate.id === id);
  };

  const add = (box: CustomSlideBox): void => {
    commit({ ops: [{ kind: 'add', box }], label: 'canvas.op.add' });
    setSelectedId(box.id);
  };

  const remove = (id: string): void => {
    const index = latest.current.boxes.findIndex((box) => box.id === id);
    const box = latest.current.boxes[index];
    if (box === undefined) return;
    const removal: Step = { ops: [{ kind: 'remove', box, index }], label: 'canvas.op.remove' };
    commit(removal);
    setSelectedId(undefined);
    showToast({
      message: t('canvas.removed'),
      action: {
        label: t('order.undo'),
        // Only while the removal is still the latest step: anything done since stays done.
        run: () => {
          const step = stack.undo();
          if (step === removal) replay(step, 'undo');
          else if (step !== undefined) stack.redo();
        },
      },
    });
  };

  useEffect(() => {
    activeCanvas.value = {
      box: slide.boxes.find((box) => box.id === selectedId),
      readOnly,
      change: (label, after) => (selectedId === undefined ? undefined : change(selectedId, label, after)),
    };
  });
  useEffect(() => () => {
    activeCanvas.value = undefined;
  }, []);

  const fit = (): void => {
    const width = viewport.current?.clientWidth ?? 0;
    setZoom(Math.min(ZOOM.max, Math.max(ZOOM.min, Math.floor((width / BASE_WIDTH) * 100))));
  };
  useEffect(() => {
    if ((viewport.current?.clientWidth ?? 0) > 0) fit();
  }, []);

  if (item === undefined || item.kind !== 'custom-slide') return null;

  const selected = slide.boxes.find((box) => box.id === selectedId);

  const addText = (): void => add({
    id: globalThis.crypto.randomUUID(), kind: 'text', layer: nextLayer(latest.current), text: t('canvas.text.default'),
    frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.2 },
    style: { fontFamily: 'var(--font-latin)', fontWeight: 400, sizeRatio: 0.08, lineHeight: 1.2, align: 'center', verticalAlign: 'center' },
  });

  const addMedia = (pick: MediaPick): void => {
    setPicking(false);
    add({
      id: globalThis.crypto.randomUUID(), kind: 'media', layer: nextLayer(latest.current), mediaId: pick.mediaId,
      mediaKind: pick.mediaKind, fit: 'contain', frame: { x: 0, y: 0, width: 1, height: 1 }, intrinsicSize: pick.intrinsicSize,
    });
  };

  const startDrag = (event: PointerEvent, box: CustomSlideBox, handle: ResizeHandle | undefined): void => {
    event.stopPropagation();
    setSelectedId(box.id);
    if (readOnly) return;
    const drag: Drag = { box, handle, x: event.clientX, y: event.clientY, px };
    const frameAt = (moved: PointerEvent): CustomSlideBox['frame'] => {
      const dx = moved.clientX - drag.x;
      const dy = moved.clientY - drag.y;
      return drag.handle === undefined ? nudge(drag.box, dx, dy, drag.px) : resize(drag.box, drag.handle, dx, dy, drag.px);
    };
    const move = (moved: PointerEvent): void => setLive({ id: box.id, frame: frameAt(moved) });
    const up = (ended: PointerEvent): void => {
      globalThis.removeEventListener('pointermove', move);
      globalThis.removeEventListener('pointerup', up);
      setLive(undefined);
      change(box.id, handle === undefined ? 'canvas.op.move' : 'canvas.op.resize', { frame: frameAt(ended) });
    };
    globalThis.addEventListener('pointermove', move);
    globalThis.addEventListener('pointerup', up);
  };

  const keyDown = (event: KeyboardEvent, box: CustomSlideBox): void => {
    if (readOnly) return;
    const arrow = ARROWS[event.key];
    if (arrow !== undefined) {
      event.preventDefault();
      const step = event.shiftKey ? 16 : 4;
      change(box.id, 'canvas.op.move', { frame: nudge(box, arrow[0] * step, arrow[1] * step, px) });
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      remove(box.id);
    } else if (event.key === 'Enter' && box.kind === 'text') {
      event.preventDefault();
      setEditingId(box.id);
    }
  };

  const finishText = (id: string, text: string | undefined): void => {
    setEditingId(undefined);
    if (text !== undefined && text.trim() !== '') change(id, 'canvas.op.edit', { text });
    boxRefs.current.get(id)?.focus();
  };

  const layer = (direction: 'forward' | 'backward'): void => {
    if (selectedId !== undefined) commit({ ops: relayer(latest.current, selectedId, direction), label: 'canvas.op.layer' });
  };

  const canPickMedia = can('content.edit');
  const editing = slide.boxes.find((box) => box.id === editingId);
  const statusKey = STATUS_KEYS[state];
  const drawn = [...slide.boxes].sort((a, b) => a.layer - b.layer);

  return (
    <div class="custom-slide-canvas" ref={root}>
      <h2>{t('canvas.heading')}</h2>
      {readOnly ? null : (
        <div role="toolbar" aria-label={t('canvas.toolbar')} class="canvas-toolbar">
          <button type="button" onClick={addText}>{t('canvas.addText')}</button>
          <button
            type="button" disabled={!canPickMedia} aria-describedby={canPickMedia ? undefined : 'canvas-media-later'}
            aria-expanded={canPickMedia ? picking : undefined} onClick={() => setPicking(!picking)}
          >
            {t('canvas.addMedia')}
          </button>
          <button type="button" disabled={selected === undefined} onClick={() => {
            if (selectedId !== undefined) {
              const op = duplicateBox(latest.current, selectedId, globalThis.crypto.randomUUID());
              if (op.kind === 'add') add(op.box);
            }
          }}>{t('canvas.duplicate')}</button>
          <button type="button" disabled={selected === undefined} onClick={() => selectedId !== undefined && remove(selectedId)}>{t('canvas.remove')}</button>
          <button type="button" disabled={selected === undefined} onClick={() => layer('forward')}>{t('canvas.forward')}</button>
          <button type="button" disabled={selected === undefined} onClick={() => layer('backward')}>{t('canvas.backward')}</button>
        </div>
      )}
      {readOnly || canPickMedia ? null : <p id="canvas-media-later">{t('canvas.media.later')}</p>}
      {picking && canPickMedia && !readOnly ? <MediaTab mode="pick" onPick={addMedia} /> : null}
      <div class="canvas-zoom">
        <button type="button" onClick={fit}>{t('canvas.fit')}</button>
        <button type="button" disabled={zoom <= ZOOM.min} onClick={() => setZoom(Math.max(ZOOM.min, Math.ceil(zoom / ZOOM.step) * ZOOM.step - ZOOM.step))}>
          {t('canvas.zoomOut')}
        </button>
        <button type="button" disabled={zoom >= ZOOM.max} onClick={() => setZoom(Math.min(ZOOM.max, Math.floor(zoom / ZOOM.step) * ZOOM.step + ZOOM.step))}>
          {t('canvas.zoomIn')}
        </button>
        <span aria-live="polite">{t('canvas.zoom', { percent: zoom })}</span>
      </div>
      <div class="canvas-viewport" ref={viewport}>
        <div
          class="canvas-slide" style={{ width: `${px.width}px`, height: `${px.height}px`, background: slide.background ?? '#000' }}
          onPointerDown={() => setSelectedId(undefined)}
        >
          {drawn.map((box) => {
            const frame = live?.id === box.id ? live.frame : box.frame;
            const isSelected = box.id === selectedId;
            return (
              <div
                key={box.id} role="button" tabIndex={0} class="canvas-box" aria-label={boxLabel(box)} aria-pressed={isSelected}
                aria-disabled={readOnly ? true : undefined}
                ref={(element) => {
                  if (element === null) boxRefs.current.delete(box.id);
                  else boxRefs.current.set(box.id, element);
                }}
                style={{ left: `${frame.x * 100}%`, top: `${frame.y * 100}%`, width: `${frame.width * 100}%`, height: `${frame.height * 100}%`, zIndex: box.layer }}
                onFocus={() => setSelectedId(box.id)}
                onPointerDown={(event) => startDrag(event, box, undefined)}
                onKeyDown={(event) => keyDown(event, box)}
                onDblClick={() => !readOnly && box.kind === 'text' && setEditingId(box.id)}
              >
                {box.kind === 'text' ? (
                  <span style={{ fontSize: `${box.style.sizeRatio * px.height}px`, fontWeight: box.style.fontWeight, textAlign: box.style.align }}>{box.text}</span>
                ) : (
                  <img
                    alt="" draggable={false} style={{ objectFit: OBJECT_FIT[box.fit] }}
                    src={box.mediaKind === 'image' ? API.mediaContent(box.mediaId) : API.mediaDerivative(box.mediaId, 'poster')}
                  />
                )}
                {isSelected && !readOnly ? HANDLES.map((handle) => (
                  <span key={handle} aria-hidden="true" class={`canvas-handle canvas-handle-${handle}`} onPointerDown={(event) => startDrag(event, box, handle)} />
                )) : null}
              </div>
            );
          })}
          {editing?.kind === 'text' ? <InlineText box={editing} onDone={(text) => finishText(editing.id, text)} /> : null}
        </div>
      </div>
      <p role="status" class="editor-save-state">{statusKey === undefined ? '' : t(statusKey)}</p>
      <button type="button" onClick={() => void flush()}>{t('editor.checkpoint')}</button>
    </div>
  );
}
