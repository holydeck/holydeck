import { describe, expect, it } from 'vitest';

import { parseByteRange } from './byte-range.js';

describe('parseByteRange', () => {
  it.each([
    [undefined, 100, { kind: 'whole' }],
    ['bytes=0-9', 100, { kind: 'partial', start: 0, end: 9 }],
    ['bytes=90-', 100, { kind: 'partial', start: 90, end: 99 }],
    ['bytes=-10', 100, { kind: 'partial', start: 90, end: 99 }],
    ['bytes=50-500', 100, { kind: 'partial', start: 50, end: 99 }],
    ['bytes=100-', 100, { kind: 'unsatisfiable' }],
    ['bytes=0-1,5-6', 100, { kind: 'whole' }],
    ['items=0-1', 100, { kind: 'whole' }],
    ['bytes=9-3', 100, { kind: 'whole' }],
    ['bytes=-0', 100, { kind: 'unsatisfiable' }],
  ])('%s of %d', (header, size, expected) => {
    expect(parseByteRange(header, size)).toEqual(expected);
  });
});
