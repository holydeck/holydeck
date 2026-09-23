import { describe, expect, it } from 'vitest';

import type { CustomSlideBody, CustomSlideBox } from '@holydeck/contracts/services';

import { apply, clampFrame, duplicateBox, invert, MIN_SIDE, nextLayer, nudge, relayer, resize, type CanvasOp } from './canvas-ops.js';

const text = (id: string, layer: number, x = 0.1): CustomSlideBox => ({
  id, kind: 'text', layer, text: `Box ${id}`, frame: { x, y: 0.1, width: 0.5, height: 0.2 },
  style: { fontFamily: 'var(--font-latin)', fontWeight: 400, sizeRatio: 0.05, lineHeight: 1.2, align: 'center', verticalAlign: 'center' },
});
const body = (...boxes: CustomSlideBox[]): CustomSlideBody => ({ kind: 'custom-slide', boxes });
const FULL_HD = { width: 1920, height: 1080 };

describe('apply and invert', () => {
  const start = body(text('a', 0), text('b', 1));
  const ops: [string, CanvasOp][] = [
    ['add', { kind: 'add', box: text('c', 2) }],
    ['add at an index', { kind: 'add', box: text('c', 2), index: 1 }],
    ['remove', { kind: 'remove', box: start.boxes[0] as CustomSlideBox, index: 0 }],
    ['change', { kind: 'change', id: 'b', before: { text: 'Box b' }, after: { text: 'Hello' }, label: 'canvas.op.edit' }],
  ];
  it.each(ops)('round-trips %s', (_name, op) => {
    const changed = apply(start, op);
    expect(changed).not.toEqual(start);
    expect(apply(changed, invert(op))).toEqual(start);
  });

  it('re-inserts a removed box where it was', () => {
    const op: CanvasOp = { kind: 'remove', box: start.boxes[0] as CustomSlideBox, index: 0 };
    expect(apply(apply(start, op), invert(op)).boxes.map((box) => box.id)).toEqual(['a', 'b']);
    expect(invert({ kind: 'remove', box: text('z', 0), index: -1 })).toEqual({ kind: 'add', box: text('z', 0) });
  });

  it('clamps a changed frame inside the slide, and ignores a box that is gone', () => {
    const moved = apply(start, { kind: 'change', id: 'a', before: {}, after: { frame: { x: 0.9, y: -1, width: 0.5, height: 2 } }, label: 'canvas.op.move' });
    expect(moved.boxes[0]?.frame).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
    expect(apply(start, { kind: 'change', id: 'gone', before: {}, after: { layer: 9 }, label: 'canvas.op.layer' })).toEqual(start);
  });
});

describe('clampFrame', () => {
  it('keeps every edge inside and every side at least MIN_SIDE', () => {
    expect(clampFrame({ x: -0.2, y: -0.3, width: 0.2, height: 0.2 })).toEqual({ x: 0, y: 0, width: 0.2, height: 0.2 });
    expect(clampFrame({ x: 0.95, y: 0.95, width: 0.2, height: 0.2 })).toEqual({ x: 0.8, y: 0.8, width: 0.2, height: 0.2 });
    expect(clampFrame({ x: 0.5, y: 0.5, width: 0, height: -1 })).toEqual({ x: 0.5, y: 0.5, width: MIN_SIDE, height: MIN_SIDE });
  });
});

describe('nudge', () => {
  it('turns 4 px and 16 px at 1920×1080 into ratios of the slide', () => {
    const box = text('a', 0);
    expect(nudge(box, 4, 0, FULL_HD).x).toBeCloseTo(0.1 + 4 / 1920, 12);
    expect(nudge(box, 0, 16, FULL_HD).y).toBeCloseTo(0.1 + 16 / 1080, 12);
    expect(nudge(box, -4000, 4000, FULL_HD)).toEqual({ x: 0, y: 0.8, width: 0.5, height: 0.2 });
  });
});

describe('resize', () => {
  const box = text('a', 0);
  it('moves only the grabbed edges', () => {
    const se = resize(box, 'se', 192, 108, FULL_HD);
    expect(se.x).toBe(0.1);
    expect(se.width).toBeCloseTo(0.6, 12);
    expect(se.height).toBeCloseTo(0.3, 12);
    const nw = resize(box, 'nw', 192, 54, FULL_HD);
    expect(nw.x).toBeCloseTo(0.2, 12);
    expect(nw.x + nw.width).toBeCloseTo(0.6, 12);
    expect(nw.y + nw.height).toBeCloseTo(0.3, 12);
  });

  it('stops at the slide border and never collapses a side', () => {
    expect(resize(box, 'e', 5000, 0, FULL_HD).width).toBeCloseTo(0.9, 12);
    expect(resize(box, 'w', -5000, 0, FULL_HD).x).toBe(0);
    expect(resize(box, 'n', 0, -5000, FULL_HD).y).toBe(0);
    expect(resize(box, 's', 0, -5000, FULL_HD).height).toBeCloseTo(MIN_SIDE, 12);
    expect(resize(box, 'w', 5000, 0, FULL_HD).width).toBeCloseTo(MIN_SIDE, 12);
  });
});

describe('duplicateBox', () => {
  it('offsets the copy by 2% and puts it above every box', () => {
    const op = duplicateBox(body(text('a', 0), text('b', 4)), 'a', 'copy');
    expect(op).toMatchObject({ kind: 'add', box: { id: 'copy', layer: 5, text: 'Box a' } });
    if (op.kind !== 'add') throw new Error('expected an add');
    expect(op.box.frame.x).toBeCloseTo(0.12, 12);
    expect(op.box.frame.y).toBeCloseTo(0.12, 12);
    expect(() => duplicateBox(body(), 'a', 'copy')).toThrow();
  });

  it('starts an empty slide at layer 0', () => {
    expect(nextLayer(body())).toBe(0);
  });
});

describe('relayer', () => {
  const slide = body(text('a', 0), text('b', 1), text('c', 2));
  const layers = (ops: CanvasOp[]): string[] => ops.reduce(apply, slide).boxes.slice().sort((x, y) => x.layer - y.layer).map((box) => box.id);

  it('moves a box one step or to the front or back', () => {
    expect(layers(relayer(slide, 'a', 'forward'))).toEqual(['b', 'a', 'c']);
    expect(layers(relayer(slide, 'c', 'backward'))).toEqual(['a', 'c', 'b']);
    expect(layers(relayer(slide, 'a', 'front'))).toEqual(['b', 'c', 'a']);
    expect(layers(relayer(slide, 'c', 'back'))).toEqual(['c', 'a', 'b']);
  });

  it('does nothing at the end of the stack or for an unknown box', () => {
    expect(relayer(slide, 'c', 'forward')).toEqual([]);
    expect(relayer(slide, 'a', 'back')).toEqual([]);
    expect(relayer(slide, 'zz', 'front')).toEqual([]);
  });

  it('renumbers ties so a step is never lost', () => {
    const tied = body(text('a', 3), text('b', 3));
    const ops = relayer(tied, 'a', 'forward');
    const after = ops.reduce(apply, tied);
    expect(after.boxes.find((box) => box.id === 'a')?.layer).toBe(1);
    expect(after.boxes.find((box) => box.id === 'b')?.layer).toBe(0);
    expect(ops.every((op) => op.kind === 'change' && op.label === 'canvas.op.layer')).toBe(true);
  });
});
