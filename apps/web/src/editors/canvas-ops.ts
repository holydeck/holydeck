// Every change the Custom Slide canvas makes is one of three small, reversible operations on the slide's
// boxes, so the canvas's undo stack, its autosave and its keyboard/mouse/numeric paths all speak the same
// language. Frames are ratios of the slide (0..1), and each operation clamps its frame back inside the
// slide: the server refuses a box that reaches past an edge, so the canvas never produces one.

import type { BoxFrame } from '@holydeck/contracts/layouts';
import type { CustomSlideBody, CustomSlideBox } from '@holydeck/contracts/services';

/** One reversible change to a custom slide's boxes; `label` is the message key naming a change. */
export type CanvasOp =
  | { readonly kind: 'add'; readonly box: CustomSlideBox; readonly index?: number }
  | { readonly kind: 'remove'; readonly box: CustomSlideBox; readonly index: number }
  | {
    readonly kind: 'change';
    readonly id: string;
    readonly before: Partial<CustomSlideBox>;
    readonly after: Partial<CustomSlideBox>;
    readonly label: string;
  };

/** A frame side never shrinks below this share of the slide: the server refuses a side of none. */
export const MIN_SIDE = 0.01;

/** The offset a duplicate is placed at, so it never hides exactly behind its original. */
export const DUPLICATE_OFFSET = 0.02;

/** Where a resize grabs a box: an edge or a corner, named by compass point. */
export type ResizeHandle = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** The canvas's size on screen, which turns a pointer or key move in pixels into a share of the slide. */
export type CanvasPx = { readonly width: number; readonly height: number };

const between = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** The frame moved and shrunk only as much as needed to lie wholly inside the slide. */
export function clampFrame(frame: BoxFrame): BoxFrame {
  const width = between(frame.width, MIN_SIDE, 1);
  const height = between(frame.height, MIN_SIDE, 1);
  return { x: between(frame.x, 0, 1 - width), y: between(frame.y, 0, 1 - height), width, height };
}

const clamped = (box: CustomSlideBox): CustomSlideBox => ({ ...box, frame: clampFrame(box.frame) });

/** The slide after one operation. A change to a box that is gone changes nothing. */
export function apply(body: CustomSlideBody, op: CanvasOp): CustomSlideBody {
  if (op.kind === 'add') {
    const boxes = [...body.boxes];
    boxes.splice(op.index ?? boxes.length, 0, clamped(op.box));
    return { ...body, boxes };
  }
  if (op.kind === 'remove') return { ...body, boxes: body.boxes.filter((box) => box.id !== op.box.id) };
  return {
    ...body,
    boxes: body.boxes.map((box) => (box.id === op.id ? clamped({ ...box, ...op.after } as CustomSlideBox) : box)),
  };
}

/** The operation that takes `apply(body, op)` back to `body`. */
export function invert(op: CanvasOp): CanvasOp {
  if (op.kind === 'add') return { kind: 'remove', box: op.box, index: op.index ?? -1 };
  if (op.kind === 'remove') return { kind: 'add', box: op.box, ...(op.index < 0 ? {} : { index: op.index }) };
  return { ...op, before: op.after, after: op.before };
}

/** The box's frame moved by a number of on-screen pixels, kept inside the slide. */
export function nudge(box: CustomSlideBox, dxPx: number, dyPx: number, canvasPx: CanvasPx): BoxFrame {
  const { frame } = box;
  return clampFrame({ ...frame, x: frame.x + dxPx / canvasPx.width, y: frame.y + dyPx / canvasPx.height });
}

/** The box's frame with the grabbed edges moved; the opposite edges stay put, and no edge crosses the
 *  slide's border or comes closer than `MIN_SIDE` to its partner. */
export function resize(box: CustomSlideBox, handle: ResizeHandle, dxPx: number, dyPx: number, canvasPx: CanvasPx): BoxFrame {
  const { frame } = box;
  let left = frame.x;
  let top = frame.y;
  let right = frame.x + frame.width;
  let bottom = frame.y + frame.height;
  const dx = dxPx / canvasPx.width;
  const dy = dyPx / canvasPx.height;
  if (handle.includes('w')) left = between(left + dx, 0, right - MIN_SIDE);
  if (handle.includes('e')) right = between(right + dx, left + MIN_SIDE, 1);
  if (handle.includes('n')) top = between(top + dy, 0, bottom - MIN_SIDE);
  if (handle.includes('s')) bottom = between(bottom + dy, top + MIN_SIDE, 1);
  return clampFrame({ x: left, y: top, width: right - left, height: bottom - top });
}

const topLayer = (body: CustomSlideBody): number => Math.max(-1, ...body.boxes.map((box) => box.layer));

/** The next layer above every box on the slide. */
export function nextLayer(body: CustomSlideBody): number {
  return topLayer(body) + 1;
}

/** Adds a copy of one box, offset a little and above every other box. */
export function duplicateBox(body: CustomSlideBody, id: string, newId: string): CanvasOp {
  const original = body.boxes.find((box) => box.id === id);
  if (original === undefined) throw new Error(`no box ${id} on this slide`);
  const { frame } = original;
  return {
    kind: 'add',
    box: {
      ...original, id: newId, layer: nextLayer(body),
      frame: clampFrame({ ...frame, x: frame.x + DUPLICATE_OFFSET, y: frame.y + DUPLICATE_OFFSET }),
    },
  };
}

/** The layer changes that move one box a step or all the way up or down the stack. Boxes are renumbered
 *  0..n-1 in their drawn order, so ties and gaps left by earlier edits never make a step a no-op. */
export function relayer(body: CustomSlideBody, id: string, direction: 'forward' | 'backward' | 'front' | 'back'): CanvasOp[] {
  const order = body.boxes.map((box, index) => ({ box, index })).sort((a, b) => a.box.layer - b.box.layer || a.index - b.index).map(({ box }) => box);
  const from = order.findIndex((box) => box.id === id);
  if (from < 0) return [];
  const last = order.length - 1;
  const to = direction === 'front' ? last : direction === 'back' ? 0 : between(from + (direction === 'forward' ? 1 : -1), 0, last);
  if (to === from) return [];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved as CustomSlideBox);
  return order.flatMap((box, layer): CanvasOp[] => (box.layer === layer ? [] : [{
    kind: 'change', id: box.id, before: { layer: box.layer }, after: { layer }, label: 'canvas.op.layer',
  }]));
}
