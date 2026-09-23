import { describe, expect, it } from 'vitest';


import { CanvasUnavailableError, domMeasurer, resolveFamily } from './dom-measurer.js';

class FakeContext {
  font = '';
  measureText(text: string): { width: number } {
    return { width: text.length * 10 };
  }
}

const fakeCanvas = (ctx: FakeContext | null = new FakeContext()): { getContext(kind: '2d'): FakeContext | null } => ({
  getContext: (kind) => (kind === '2d' ? ctx : null),
});

describe('domMeasurer', () => {
  it('word-wraps at maxWidthPx and reports the widest line and the line count', async () => {
    const measurer = domMeasurer(fakeCanvas());
    const [metrics] = await measurer.measure([
      { text: 'aa bb cc', fontFamily: 'serif', fontWeight: 400, fontSizePx: 10, lineHeight: 1, letterSpacingPx: 0, maxWidthPx: 25 },
    ]);
    expect(metrics).toEqual({ widthPx: 20, heightPx: 30, lineCount: 3 });
  });

  it('adds letterSpacingPx * (chars - 1) to a line width', async () => {
    const measurer = domMeasurer(fakeCanvas());
    const [metrics] = await measurer.measure([
      { text: 'abc', fontFamily: 'serif', fontWeight: 400, fontSizePx: 10, lineHeight: 1, letterSpacingPx: 2, maxWidthPx: 1000 },
    ]);
    expect(metrics?.widthPx).toBe(34);
  });

  it('sets ctx.font from fontWeight, fontSizePx and the resolved font family', async () => {
    const ctx = new FakeContext();
    const measurer = domMeasurer(fakeCanvas(ctx), (name) => (name === '--font-latin' ? 'system-ui, sans-serif' : undefined));
    await measurer.measure([
      { text: 'x', fontFamily: 'var(--font-latin)', fontWeight: 700, fontSizePx: 42, lineHeight: 1, letterSpacingPx: 0, maxWidthPx: 1000 },
    ]);
    expect(ctx.font).toBe('700 42px system-ui, sans-serif');
  });

  it('resolves a CSS variable family, its own fallback, then sans-serif, and leaves plain names alone', () => {
    const read = (name: string): string | undefined => (name === '--font-tamil' ? '"Noto Sans Tamil", sans-serif' : undefined);
    expect(resolveFamily('var(--font-tamil)', read)).toBe('"Noto Sans Tamil", sans-serif');
    expect(resolveFamily('var(--missing, serif)', read)).toBe('serif');
    expect(resolveFamily('var(--missing)', read)).toBe('sans-serif');
    expect(resolveFamily('Georgia, serif', read)).toBe('Georgia, serif');
    expect(resolveFamily('var(--missing)')).toBe('sans-serif');
  });

  it('answers a batch of requests matched by position', async () => {
    const measurer = domMeasurer(fakeCanvas());
    const results = await measurer.measure([
      { text: 'a', fontFamily: 'serif', fontWeight: 400, fontSizePx: 10, lineHeight: 1, letterSpacingPx: 0, maxWidthPx: 1000 },
      { text: 'aaaa', fontFamily: 'serif', fontWeight: 400, fontSizePx: 10, lineHeight: 1, letterSpacingPx: 0, maxWidthPx: 1000 },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]?.widthPx).toBe(10);
    expect(results[1]?.widthPx).toBe(40);
  });

  it('rejects with CanvasUnavailableError when there is no 2d context', async () => {
    const measurer = domMeasurer(fakeCanvas(null));
    await expect(measurer.measure([
      { text: 'x', fontFamily: 'serif', fontWeight: 400, fontSizePx: 10, lineHeight: 1, letterSpacingPx: 0, maxWidthPx: 100 },
    ])).rejects.toBeInstanceOf(CanvasUnavailableError);
  });
});
