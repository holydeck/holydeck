// The browser `TextMeasurer` REND-01 asks preparation for: word-wraps at `maxWidthPx` using the canvas
// 2D context's own `measureText`, the same primitive every surface eventually paints with, so a line that
// fits here is a line that fits when it is actually drawn.

// Types only from `@holydeck/renderer/measure`: its runtime half holds the lazy puppeteer import, which a
// browser bundle must never reach, so the one error this file throws is its own.
import type { MeasureRequest, TextMeasurer, TextMetrics } from '@holydeck/renderer/measure';

/** This browser cannot measure text at all (no 2D canvas context), so no preview can be prepared. */
export class CanvasUnavailableError extends Error {
  constructor(reason: string) {
    super(`text measurement is unavailable: ${reason}`);
    this.name = 'CanvasUnavailableError';
  }
}

interface Context2DLike {
  font: string;
  measureText(text: string): { readonly width: number };
}

interface CanvasLike {
  getContext(kind: '2d'): Context2DLike | null;
}

function widthOf(ctx: Context2DLike, line: string, letterSpacingPx: number): number {
  if (line.length === 0) return 0;
  return ctx.measureText(line).width + letterSpacingPx * (line.length - 1);
}

/** Reads one CSS custom property off the document root; `undefined` outside a document or when unset. */
export type VariableReader = (name: string) => string | undefined;

function rootVariable(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? undefined : value;
}

const VARIABLE = /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/gu;

/** A canvas `font` is parsed without the cascade, so `var(--font-latin)` there is not a family at all —
 *  the whole assignment is silently ignored and the context keeps measuring in its 10px default. Layout
 *  families are written as the LANG-02 variables, so each is swapped for the stack it names first. */
export function resolveFamily(family: string, read: VariableReader = rootVariable): string {
  return family.replace(VARIABLE, (_match, name: string, fallback: string | undefined) =>
    read(name) ?? (fallback?.trim() || 'sans-serif'));
}

function wrap(ctx: Context2DLike, request: MeasureRequest, read: VariableReader): TextMetrics {
  ctx.font = `${request.fontWeight} ${request.fontSizePx}px ${resolveFamily(request.fontFamily, read)}`;

  const words = request.text.split(/\s+/u).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';
  const fits = (line: string): boolean => widthOf(ctx, line, request.letterSpacingPx) <= request.maxWidthPx;
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current !== '') lines.push(current);
    current = '';
    // The server measurer lays text out with `overflow-wrap: break-word`: a word wider than the whole line
    // starts a new line and then breaks between characters, never overflowing. The last piece stays open
    // so the next word can still join it.
    for (const char of word) {
      if (current !== '' && !fits(current + char)) {
        lines.push(current);
        current = char;
      } else {
        current += char;
      }
    }
  }
  if (current !== '' || lines.length === 0) lines.push(current);

  const widthPx = lines.reduce((widest, line) => Math.max(widest, widthOf(ctx, line, request.letterSpacingPx)), 0);
  const lineCount = lines.length;
  return { widthPx, heightPx: lineCount * request.fontSizePx * request.lineHeight, lineCount };
}

function defaultCanvas(): CanvasLike | undefined {
  return typeof document === 'undefined' ? undefined : document.createElement('canvas');
}

/** The browser measurer: reads a real `<canvas>` 2d context, or the one a caller supplies (mainly tests). */
export function domMeasurer(canvas?: CanvasLike, read: VariableReader = rootVariable): TextMeasurer {
  const ctx = (canvas ?? defaultCanvas())?.getContext('2d') ?? undefined;
  return {
    measure: async (requests: readonly MeasureRequest[]): Promise<readonly TextMetrics[]> => {
      if (ctx === undefined) throw new CanvasUnavailableError('no 2d canvas context is available');
      return requests.map((request) => wrap(ctx, request, read));
    },
    close: async (): Promise<void> => {
      // Nothing to release: the canvas is either caller-owned or never attached to the document.
    },
  };
}
