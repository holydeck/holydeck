import { describe, expect, it } from 'vitest';

import { READINESS_CODES, blocker, readinessOf, warning } from './readiness.js';

describe('readiness findings', () => {
  it('names a box when there is one and leaves the key off when there is not', () => {
    expect(blocker('content.outsideSafeArea', { slideId: 's1', boxId: 'b1' }, 'out')).toEqual({
      code: 'content.outsideSafeArea',
      severity: 'blocker',
      slideId: 's1',
      boxId: 'b1',
      detail: 'out',
    });
    expect(warning('layout.ratioMismatch', { slideId: 's1' }, 'letterboxed')).toEqual({
      code: 'layout.ratioMismatch',
      severity: 'warning',
      slideId: 's1',
      detail: 'letterboxed',
    });
  });

  it('freezes a finding, so a surface cannot downgrade one on its way past', () => {
    const found = blocker('content.outsideSafeArea', { slideId: 's1', boxId: 'b1' }, 'out');
    expect(() => {
      (found as { severity: string }).severity = 'warning';
    }).toThrow(TypeError);
  });

  it('grades a list the way readiness reads it', () => {
    const warn = warning('decoration.outsideSafeArea', { slideId: 's1', boxId: 'b1' }, 'decorative');
    const block = blocker('text.belowMinimumReadableSize', { slideId: 's1', boxId: 'b1' }, 'too small');

    expect(readinessOf([])).toBe('ready');
    expect(readinessOf([warn])).toBe('warned');
    expect(readinessOf([warn, block])).toBe('blocked');
  });

  it('declares every code the renderer can raise', () => {
    expect([...READINESS_CODES]).toEqual([
      'text.belowMinimumReadableSize',
      'text.overflowsAtMinimumReadableSize',
      'content.outsideSafeArea',
      'decoration.outsideSafeArea',
      'layout.ratioMismatch',
    ]);
  });
});
