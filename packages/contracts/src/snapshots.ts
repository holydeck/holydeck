// The prepared snapshot manifest: the pins that make a prepared service reproducible, and the two
// resolved values every render of it depends on. Preparation writes one of these and never rewrites it,
// so what this module refuses is what a presentation would otherwise discover on a Sunday morning.

import { FIELD_CODES, type ParseFn, type Parsed, parseObject } from './problems.js';

/** Every revision the definition of a prepared snapshot pins. A manifest missing one is not prepared. */
export const SNAPSHOT_PINS = [
  'service',
  'content',
  'slideLayout',
  'serviceTemplate',
  'settings',
  'media',
  'corpus',
] as const;
export type SnapshotPin = (typeof SNAPSHOT_PINS)[number];

export const SAFE_AREA_EDGES = ['top', 'right', 'bottom', 'left'] as const;
export type SafeAreaEdge = (typeof SAFE_AREA_EDGES)[number];

// A margin is a share of the surface, not a count of pixels: the manifest pins the ratio, while the
// resolution belongs to whichever output profile renders it. Half of an edge would leave nothing between
// two opposite margins, so the ceiling sits just below it.
export const MAX_SAFE_AREA_PERCENT = 49;

export type SafeAreaMargins = Record<SafeAreaEdge, number> & { readonly unit: 'percent' };

/** The validation default. Still owed measured evidence on a representative display. */
export const DEFAULT_SAFE_AREA_MARGINS: SafeAreaMargins = {
  top: 5,
  right: 5,
  bottom: 5,
  left: 5,
  unit: 'percent',
};

export type AspectRatio = { readonly width: number; readonly height: number };

/**
 * ADR 0004: what a generated slide group in this manifest was deterministically projected from — the
 * pinned source revision and the pinned Slide Layout revision, both frozen at prepare time rather than
 * re-read from whatever they stand at now. `slideGroupRevision` is the projection itself, content-addressed
 * by `revisions.save()`, so two prepares with unchanged `sourceRevision`/`slideLayoutRevision` name the
 * same `slideGroupRevision` back.
 */
export type GeneratedSlideProvenance = {
  readonly slideGroupId: string;
  readonly slideGroupRevision: number;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly slideLayoutId: string;
  readonly slideLayoutRevision: number;
};

export type PreparedSnapshot = {
  readonly id: string;
  readonly pins: Record<SnapshotPin, string>;
  readonly resolved: { readonly aspectRatio: string; readonly safeAreaMargins: SafeAreaMargins };
  /**
   * Every generated slide group a run would show, with the source and Slide Layout revisions it was
   * projected from. Empty for a manifest with nothing generated. A manifest written before this field
   * existed has none of this recorded either — it parses back to an empty list rather than being refused,
   * because a prepared snapshot is never rewritten and an earlier one must still read (ADR 0006).
   */
  readonly generatedSlides: readonly GeneratedSlideProvenance[];
  readonly immutable: true;
};

const RATIO = /^(\d+):(\d+)$/u;

/** Reads a resolved ratio, or nothing when the label is not one. */
export function aspectRatioOf(label: string): AspectRatio | undefined {
  const match = RATIO.exec(label);
  if (match === null) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width >= 1 && height >= 1 ? { width, height } : undefined;
}

const greatestCommonDivisor = (left: number, right: number): number => {
  let [a, b] = [left, right];
  while (b !== 0) [a, b] = [b, a % b];
  return a;
};

/**
 * Labels a ratio by what it is rather than by the numbers it arrived as, so validated custom dimensions
 * and the standard ratio they equal resolve to one label — and therefore to one cache key.
 */
export function aspectRatioLabel({ width, height }: AspectRatio): string {
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

export const parseSafeAreaMargins: ParseFn<SafeAreaMargins> = (value, path) =>
  parseObject(value, path, (reader) => {
    const margins = {} as Record<SafeAreaEdge, number>;
    for (const edge of SAFE_AREA_EDGES) {
      const percent = reader.wholeNumber(edge);
      if (percent > MAX_SAFE_AREA_PERCENT) {
        reader.reject(edge, FIELD_CODES.notAllowed, `must be at most ${MAX_SAFE_AREA_PERCENT} percent`);
      }
      margins[edge] = percent;
    }
    return { ...margins, unit: reader.choice('unit', ['percent'] as const) };
  });

const parseResolved: ParseFn<PreparedSnapshot['resolved']> = (value, path) =>
  parseObject(value, path, (reader) => {
    const aspectRatio = reader.text('aspectRatio');
    if (aspectRatio !== '' && aspectRatioOf(aspectRatio) === undefined) {
      reader.reject('aspectRatio', FIELD_CODES.notAllowed, 'must be a ratio of two counts, such as 16:9');
    }
    return {
      aspectRatio,
      safeAreaMargins: reader.parsed('safeAreaMargins', parseSafeAreaMargins, DEFAULT_SAFE_AREA_MARGINS),
    };
  });

const parsePins: ParseFn<Record<SnapshotPin, string>> = (value, path) =>
  parseObject(value, path, (reader) => {
    const pins = {} as Record<SnapshotPin, string>;
    for (const pin of SNAPSHOT_PINS) pins[pin] = reader.text(pin);
    return pins;
  });

const parseGeneratedSlideProvenance: ParseFn<GeneratedSlideProvenance> = (value, path) =>
  parseObject(value, path, (reader) => ({
    slideGroupId: reader.text('slideGroupId'),
    slideGroupRevision: reader.wholeNumber('slideGroupRevision', 1),
    sourceId: reader.text('sourceId'),
    sourceRevision: reader.wholeNumber('sourceRevision', 1),
    slideLayoutId: reader.text('slideLayoutId'),
    slideLayoutRevision: reader.wholeNumber('slideLayoutRevision', 1),
  }));

export function parsePreparedSnapshot(value: unknown): Parsed<PreparedSnapshot> {
  return parseObject(value, 'snapshot', (reader) => {
    const id = reader.text('id');
    const pins = reader.parsed('pins', parsePins, {} as Record<SnapshotPin, string>);
    const resolved = reader.parsed('resolved', parseResolved, {
      aspectRatio: '',
      safeAreaMargins: DEFAULT_SAFE_AREA_MARGINS,
    });
    // Absent, not required: a manifest prepared before this field existed named nothing generated at all,
    // and staying readable is what ADR 0006's "never rewritten" promises it.
    const generatedSlides = reader.optionalParsedList('generatedSlides', parseGeneratedSlideProvenance) ?? [];
    // A manifest that records itself as mutable is a manifest nothing can be replayed from.
    if (!reader.flag('immutable')) {
      reader.reject('immutable', FIELD_CODES.notAllowed, 'must be true, because a prepared snapshot is never rewritten');
    }
    return { id, pins, resolved, generatedSlides, immutable: true };
  });
}
