import { describe, expect, it } from 'vitest';

import { addSection, beforeAnchor, bulkMoveAnchor, inServiceOrder, movedSections, moveWithin, neighbours, removeSection, renameSection, reorderPlan } from './order-ops.js';
import type { ServiceView } from './service-data.js';

const item = (id: string) => ({ id, kind: 'custom-slide' as const, title: id, enabled: true, content: undefined });

const view = (sections: { id: string; name: string; items: string[] }[]): ServiceView => ({
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', revision: 'r1',
  sections: sections.map((section) => ({ id: section.id, name: section.name, items: section.items.map(item) })),
});

describe('moveWithin', () => {
  it('moves an item earlier in the list', () => {
    expect(moveWithin(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
  });

  it('moves an item later in the list', () => {
    expect(moveWithin(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
  });

  it('clamps a target past the end to the last position', () => {
    expect(moveWithin(['a', 'b', 'c'], 'a', 99)).toEqual(['b', 'c', 'a']);
  });

  it('clamps a negative target to the first position', () => {
    expect(moveWithin(['a', 'b', 'c'], 'c', -5)).toEqual(['c', 'a', 'b']);
  });

  it('leaves the list untouched when the item is not in it', () => {
    expect(moveWithin(['a', 'b'], 'z', 0)).toEqual(['a', 'b']);
  });
});

describe('neighbours', () => {
  const single = view([{ id: 'sec', name: 'Welcome', items: ['a', 'b', 'c'] }]);

  it('offers only down at the first item', () => {
    expect(neighbours(single, 'a')).toEqual({ sectionId: 'sec', index: 0, down: 1 });
  });

  it('offers both up and down for a middle item', () => {
    expect(neighbours(single, 'b')).toEqual({ sectionId: 'sec', index: 1, up: 0, down: 2 });
  });

  it('offers only up at the last item', () => {
    expect(neighbours(single, 'c')).toEqual({ sectionId: 'sec', index: 2, up: 1 });
  });

  it('offers neither for the only item in its section', () => {
    const one = view([{ id: 'sec', name: 'Welcome', items: ['a'] }]);
    expect(neighbours(one, 'a')).toEqual({ sectionId: 'sec', index: 0 });
  });

  it('throws for an item the service does not have', () => {
    expect(() => neighbours(single, 'missing')).toThrow(/missing/u);
  });
});

describe('reorderPlan', () => {
  it('plans one reorder step when the item stays in its own section', () => {
    const same = view([{ id: 'sec', name: 'Welcome', items: ['a', 'b', 'c'] }]);
    expect(reorderPlan(same, 'c', { sectionId: 'sec', index: 0 })).toEqual([
      { kind: 'reorder', sectionId: 'sec', itemIds: ['c', 'a', 'b'] },
    ]);
  });

  it('plans one move step, carrying the whole post-move sections tree, across sections', () => {
    const crossed = view([
      { id: 'sec-1', name: 'Welcome', items: ['a', 'b'] },
      { id: 'sec-2', name: 'Response', items: ['x', 'y'] },
    ]);
    const plan = reorderPlan(crossed, 'a', { sectionId: 'sec-2', index: 1 });
    expect(plan).toEqual([{ kind: 'move', itemId: 'a', sectionId: 'sec-2', index: 1 }]);
    expect(movedSections(crossed, 'a', { sectionId: 'sec-2', index: 1 })).toEqual([
      { id: 'sec-1', name: 'Welcome', items: [item('b')] },
      { id: 'sec-2', name: 'Response', items: [item('x'), item('a'), item('y')] },
    ]);
  });

  it('computes no post-move sections for an item or section that is gone', () => {
    const crossed = view([{ id: 'sec-1', name: 'Welcome', items: ['a'] }]);
    expect(movedSections(crossed, 'z', { sectionId: 'sec-1', index: 0 })).toBeUndefined();
    expect(movedSections(crossed, 'a', { sectionId: 'gone', index: 0 })).toBeUndefined();
  });

  it('returns nothing for an item the service does not have', () => {
    const some = view([{ id: 'sec', name: 'Welcome', items: ['a'] }]);
    expect(reorderPlan(some, 'missing', { sectionId: 'sec', index: 0 })).toEqual([]);
  });

  it('returns nothing for a target section the service does not have', () => {
    const some = view([{ id: 'sec', name: 'Welcome', items: ['a'] }]);
    expect(reorderPlan(some, 'a', { sectionId: 'missing', index: 0 })).toEqual([]);
  });
});

describe('renameSection', () => {
  it('renames the named section and leaves the others alone', () => {
    const two = view([{ id: 'sec-1', name: 'Welcome', items: [] }, { id: 'sec-2', name: 'Response', items: [] }]);
    expect(renameSection(two, 'sec-2', 'Communion')).toEqual([
      { id: 'sec-1', name: 'Welcome', items: [] },
      { id: 'sec-2', name: 'Communion', items: [] },
    ]);
  });
});

describe('addSection', () => {
  it('appends a fresh, empty section', () => {
    const one = view([{ id: 'sec-1', name: 'Welcome', items: [] }]);
    expect(addSection(one, 'Response', 'sec-2')).toEqual([
      { id: 'sec-1', name: 'Welcome', items: [] },
      { id: 'sec-2', name: 'Response', items: [] },
    ]);
  });
});

describe('removeSection', () => {
  it('removes an empty section', () => {
    const two = view([{ id: 'sec-1', name: 'Welcome', items: [] }, { id: 'sec-2', name: 'Response', items: [] }]);
    expect(removeSection(two, 'sec-2')).toEqual([{ id: 'sec-1', name: 'Welcome', items: [] }]);
  });

  it('refuses to remove a section that still holds items', () => {
    const held = view([{ id: 'sec', name: 'Welcome', items: ['a'] }]);
    expect(removeSection(held, 'sec')).toBe('not-empty');
  });

  it('leaves the sections untouched for an unknown section id', () => {
    const one = view([{ id: 'sec', name: 'Welcome', items: [] }]);
    expect(removeSection(one, 'missing')).toEqual(one.sections);
  });
});

describe('bulk move helpers', () => {
  const two = view([
    { id: 'one', name: 'Welcome', items: ['a', 'b', 'c'] },
    { id: 'two', name: 'Response', items: ['x', 'y'] },
  ]);

  it('orders ids the way the service shows them, dropping unknown ones', () => {
    expect(inServiceOrder(two, ['y', 'zz', 'b', 'a'])).toEqual(['a', 'b', 'y']);
  });

  it('anchors on the staying item at the picked position, or the end past it', () => {
    expect(bulkMoveAnchor(two, new Set(['a', 'b']), { sectionId: 'one', index: 0 })).toBe('c');
    expect(bulkMoveAnchor(two, new Set(['a']), { sectionId: 'two', index: 2 })).toBeUndefined();
    expect(bulkMoveAnchor(two, new Set(['a']), { sectionId: 'gone', index: 0 })).toBeUndefined();
  });

  it('targets the index just before the anchor, counted without the item itself', () => {
    expect(beforeAnchor(two, 'a', 'one', 'c')).toEqual({ sectionId: 'one', index: 1 });
    expect(beforeAnchor(two, 'a', 'two', undefined)).toEqual({ sectionId: 'two', index: 2 });
    expect(beforeAnchor(two, 'a', 'two', 'missing')).toEqual({ sectionId: 'two', index: 2 });
  });
});
