import { describe, expect, it } from 'vitest';
import { diffWords, renderDiff } from './word-diff.js';

describe('diffWords', () => {
  it('returns a single same-part for identical text', () => {
    expect(diffWords('praise the LORD', 'praise the LORD')).toEqual([
      { type: 'same', text: 'praise the LORD' },
    ]);
  });

  it('detects a replaced word', () => {
    expect(diffWords('great is thy kindness', 'great is thy faithfulness')).toEqual([
      { type: 'same', text: 'great is thy' },
      { type: 'removed', text: 'kindness' },
      { type: 'added', text: 'faithfulness' },
    ]);
  });

  it('detects insertions and deletions at the edges', () => {
    expect(diffWords('the truth endureth', 'behold the truth')).toEqual([
      { type: 'added', text: 'behold' },
      { type: 'same', text: 'the truth' },
      { type: 'removed', text: 'endureth' },
    ]);
  });

  it('handles fully disjoint text', () => {
    expect(diffWords('alpha beta', 'gamma delta')).toEqual([
      { type: 'removed', text: 'alpha beta' },
      { type: 'added', text: 'gamma delta' },
    ]);
  });

  it('handles empty sides', () => {
    expect(diffWords('', 'new text')).toEqual([{ type: 'added', text: 'new text' }]);
    expect(diffWords('old text', '')).toEqual([{ type: 'removed', text: 'old text' }]);
    expect(diffWords('', '')).toEqual([]);
  });

  it('collapses whitespace when tokenizing', () => {
    expect(diffWords('a  b\n c', 'a b c')).toEqual([{ type: 'same', text: 'a b c' }]);
  });
});

describe('renderDiff', () => {
  it('renders wdiff-style markers', () => {
    expect(
      renderDiff([
        { type: 'same', text: 'great is thy' },
        { type: 'removed', text: 'kindness' },
        { type: 'added', text: 'faithfulness' },
      ]),
    ).toBe('great is thy [-kindness-] {+faithfulness+}');
  });

  it('renders an empty diff as an empty string', () => {
    expect(renderDiff([])).toBe('');
  });
});
