// A stand-in for the headless-Chrome measurer, for the suites that are about layout rather than about
// glyphs. It wraps at a fixed advance width per character, which no real font does — that is the point:
// the auto-fit engine must not care where the numbers came from, only that one measurer answers every
// candidate size for one preparation. `measure.ts`'s own suite drives the real in-page measurement code.

import type { MeasureRequest, TextMeasurer, TextMetrics } from '../../src/measure.js';

export interface StubMeasurerOptions {
  /** Advance width of one character, as a multiple of the font size. */
  readonly advance?: number;
}

export interface StubMeasurer extends TextMeasurer {
  /** Every request this measurer was asked, in the order it was asked them. */
  readonly seen: MeasureRequest[];
  readonly batches: number[];
  readonly closed: () => boolean;
}

const wrap = (words: readonly string[], widthOf: (word: string) => number, maxWidthPx: number): number[] => {
  const lines: number[] = [];
  let current = 0;
  for (const word of words) {
    const candidate = current === 0 ? widthOf(word) : current + widthOf(` ${word}`);
    if (current > 0 && candidate > maxWidthPx) {
      lines.push(current);
      current = widthOf(word);
      continue;
    }
    current = candidate;
  }
  lines.push(current);
  return lines;
};

export const stubMeasurer = ({ advance = 0.5 }: StubMeasurerOptions = {}): StubMeasurer => {
  const seen: MeasureRequest[] = [];
  const batches: number[] = [];
  let shut = false;

  return {
    seen,
    batches,
    closed: () => shut,
    measure: (requests: readonly MeasureRequest[]): Promise<readonly TextMetrics[]> => {
      seen.push(...requests);
      batches.push(requests.length);
      return Promise.resolve(
        requests.map((request) => {
          const widthOf = (word: string): number => word.length * request.fontSizePx * advance;
          const lines = wrap(request.text.split(/\s+/u).filter(Boolean), widthOf, request.maxWidthPx);
          return {
            widthPx: Math.max(...lines, 0),
            heightPx: lines.length * request.fontSizePx * request.lineHeight,
            lineCount: lines.length,
          };
        }),
      );
    },
    close: (): Promise<void> => {
      shut = true;
      return Promise.resolve();
    },
  };
};
