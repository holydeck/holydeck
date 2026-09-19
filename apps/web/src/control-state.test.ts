import { describe, expect, it } from 'vitest';

import type { SlideLabelEntry } from '@holydeck/contracts/slide-labels';

import { indexForShortcut, isShortcutKey, previewPositions } from './control-state.js';

import type { OrderItem } from './control-state.js';

describe('previewPositions', () => {
  it('has neither position when the order is empty', () => {
    expect(previewPositions(0, 0)).toEqual({ current: undefined, next: undefined });
  });

  it('the first item has itself as current and the second as next', () => {
    expect(previewPositions(3, 0)).toEqual({ current: 0, next: 1 });
  });

  it('a middle item has the one after it as next', () => {
    expect(previewPositions(3, 1)).toEqual({ current: 1, next: 2 });
  });

  it('the last item has no next — no wraparound to the first', () => {
    expect(previewPositions(3, 2)).toEqual({ current: 2, next: undefined });
  });

  it('a single-item order is its own current with no next', () => {
    expect(previewPositions(1, 0)).toEqual({ current: 0, next: undefined });
  });

  it('clamps an index before the start up to the first item', () => {
    expect(previewPositions(3, -5)).toEqual({ current: 0, next: 1 });
  });

  it('clamps an index past the end down to the last item', () => {
    expect(previewPositions(3, 99)).toEqual({ current: 2, next: undefined });
  });
});

describe('isShortcutKey', () => {
  it('accepts every key the T52 catalogue names', () => {
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) expect(isShortcutKey(key)).toBe(true);
  });

  it('refuses a key the catalogue does not name', () => {
    for (const key of ['a', 'Enter', '11', '']) expect(isShortcutKey(key)).toBe(false);
  });
});

const items: readonly OrderItem[] = [
  { id: 'a', label: 'Welcome' },
  { id: 'b', label: 'Call to Worship' },
  { id: 'c', label: 'Offering' },
];

const entry = (name: string, shortcut: '1' | '2' | '3'): SlideLabelEntry => ({ id: `label-${name}`, name, shortcut });

describe('indexForShortcut', () => {
  it('jumps to the position of the item bound to the key, conflict-free across two different keys', () => {
    const catalogue = [entry('Call to Worship', '2'), entry('Offering', '3')];
    expect(indexForShortcut(items, catalogue, '2')).toBe(1);
    expect(indexForShortcut(items, catalogue, '3')).toBe(2);
  });

  it('is undefined for a key the catalogue never bound', () => {
    expect(indexForShortcut(items, [entry('Offering', '3')], '1')).toBeUndefined();
  });

  it('is undefined when the bound label matches no item in this order', () => {
    expect(indexForShortcut(items, [entry('Benediction', '1')], '1')).toBeUndefined();
  });

  it('is undefined against an empty catalogue', () => {
    expect(indexForShortcut(items, [], '1')).toBeUndefined();
  });
});
