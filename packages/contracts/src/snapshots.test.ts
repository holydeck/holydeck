import { describe, expect, it } from 'vitest';

import { FIELD_CODES } from './problems.js';
import {
  DEFAULT_SAFE_AREA_MARGINS,
  MAX_SAFE_AREA_PERCENT,
  SNAPSHOT_PINS,
  aspectRatioLabel,
  aspectRatioOf,
  parsePreparationInputs,
  parsePreparedSnapshot,
} from './snapshots.js';

// The manifest recorded in adrs/fixtures/prepared-snapshot.v1.json, written out here because the product
// repository holds no phase artifacts.
const snapshot = () => ({
  id: 'prepared-2026-09-13-0930',
  pins: {
    service: 'service-rev-11',
    content: 'content-rev-5',
    slideLayout: 'layout-rev-3',
    serviceTemplate: 'template-rev-2',
    settings: 'settings-rev-7',
    media: 'media-rev-4',
    corpus: 'corpus-rev-1',
  },
  resolved: {
    aspectRatio: '16:9',
    safeAreaMargins: { top: 5, right: 5, bottom: 8, left: 5, unit: 'percent' },
  },
  generatedSlides: [
    {
      slideGroupId: 'group-1',
      slideGroupRevision: 2,
      sourceId: 'song-1',
      sourceRevision: 3,
      slideLayoutId: 'layout-1',
      slideLayoutRevision: 3,
    },
  ],
  immutable: true,
});

const codes = (value: unknown) => {
  const parsed = parsePreparedSnapshot(value);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}=${problem.code}`);
};

const defective = (change: (value: ReturnType<typeof snapshot>) => void) => {
  const value = snapshot();
  change(value);
  return codes(value);
};

describe('what a prepared snapshot has to pin', () => {
  it('names every revision the definition of a prepared snapshot pins', () => {
    expect(SNAPSHOT_PINS).toEqual([
      'service',
      'content',
      'slideLayout',
      'serviceTemplate',
      'settings',
      'media',
      'corpus',
    ]);
    const parsed = parsePreparedSnapshot(snapshot());
    expect(parsed.ok).toBe(true);
    for (const pin of SNAPSHOT_PINS) expect(Object.keys(parsed.ok ? parsed.value.pins : {})).toContain(pin);
  });

  it('offers the validation default of 5% on every edge, and a ceiling that leaves room to render in', () => {
    expect(DEFAULT_SAFE_AREA_MARGINS).toEqual({ top: 5, right: 5, bottom: 5, left: 5, unit: 'percent' });
    expect(MAX_SAFE_AREA_PERCENT).toBe(49);
  });
});

describe('reading one prepared manifest', () => {
  it('parses the manifest a preparation writes', () => {
    expect(parsePreparedSnapshot(snapshot())).toEqual({ ok: true, value: snapshot() });
  });

  it('refuses a manifest that is not an object', () => {
    expect(parsePreparedSnapshot(42)).toEqual({
      ok: false,
      problems: [{ path: 'snapshot', code: FIELD_CODES.notAnObject, message: 'must be an object' }],
    });
  });

  it('refuses pins that are not a set of pins', () => {
    expect(defective((value) => ((value as { pins: unknown }).pins = 'all of them'))).toEqual([
      `snapshot.pins=${FIELD_CODES.notAnObject}`,
    ]);
  });

  it('refuses a manifest that pins no corpus revision, because offline lookup would drift', () => {
    expect(
      defective((value) => {
        delete (value.pins as { corpus?: string }).corpus;
      }),
    ).toEqual([`snapshot.pins.corpus=${FIELD_CODES.required}`]);
  });

  it('refuses a pin recorded as nothing at all', () => {
    expect(defective((value) => (value.pins.media = ''))).toEqual([`snapshot.pins.media=${FIELD_CODES.empty}`]);
  });

  it('refuses an aspect ratio that is not a ratio, and one with no picture in it', () => {
    expect(defective((value) => (value.resolved.aspectRatio = 'widescreen'))).toEqual([
      `snapshot.resolved.aspectRatio=${FIELD_CODES.notAllowed}`,
    ]);
    expect(defective((value) => (value.resolved.aspectRatio = '0:9'))).toEqual([
      `snapshot.resolved.aspectRatio=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses margins that would leave nothing to render inside, and a margin below nothing', () => {
    expect(defective((value) => (value.resolved.safeAreaMargins.top = 50))).toEqual([
      `snapshot.resolved.safeAreaMargins.top=${FIELD_CODES.notAllowed}`,
    ]);
    expect(defective((value) => (value.resolved.safeAreaMargins.left = -1))).toEqual([
      `snapshot.resolved.safeAreaMargins.left=${FIELD_CODES.tooSmall}`,
    ]);
  });

  it('refuses margins measured in anything but percent, because a resolution is not pinned here', () => {
    expect(defective((value) => (value.resolved.safeAreaMargins.unit = 'px'))).toEqual([
      `snapshot.resolved.safeAreaMargins.unit=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses a snapshot recorded as mutable, which is not a prepared snapshot', () => {
    expect(defective((value) => (value.immutable = false))).toEqual([`snapshot.immutable=${FIELD_CODES.notAllowed}`]);
  });

  it('reports every defect in one manifest at once rather than the first', () => {
    expect(
      defective((value) => {
        value.id = '';
        value.pins.settings = '';
        value.resolved.aspectRatio = 'widescreen';
        value.resolved.safeAreaMargins.bottom = 60;
      }),
    ).toEqual([
      `snapshot.id=${FIELD_CODES.empty}`,
      `snapshot.pins.settings=${FIELD_CODES.empty}`,
      `snapshot.resolved.aspectRatio=${FIELD_CODES.notAllowed}`,
      `snapshot.resolved.safeAreaMargins.bottom=${FIELD_CODES.notAllowed}`,
    ]);
  });
});

describe('the generated slides a manifest records (ADR 0004)', () => {
  it('reads the source and Slide Layout revisions recorded for a generated slide group', () => {
    const parsed = parsePreparedSnapshot(snapshot());
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.generatedSlides : []).toEqual([
      {
        slideGroupId: 'group-1',
        slideGroupRevision: 2,
        sourceId: 'song-1',
        sourceRevision: 3,
        slideLayoutId: 'layout-1',
        slideLayoutRevision: 3,
      },
    ]);
  });

  it('defaults to nothing generated for a manifest written before this field existed', () => {
    const value = snapshot() as { generatedSlides?: unknown };
    delete value.generatedSlides;
    const parsed = parsePreparedSnapshot(value);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.generatedSlides : undefined).toEqual([]);
  });

  it('refuses a generated slide entry missing a pinned revision', () => {
    expect(
      defective((value) => {
        (value as { generatedSlides: Array<Record<string, unknown>> }).generatedSlides[0]!['sourceRevision'] = 0;
      }),
    ).toEqual([`snapshot.generatedSlides.0.sourceRevision=${FIELD_CODES.tooSmall}`]);
  });

  it('refuses a generated slide entry with no source at all', () => {
    expect(
      defective((value) => {
        delete (value as { generatedSlides: Array<Record<string, unknown>> }).generatedSlides[0]!['sourceId'];
      }),
    ).toEqual([`snapshot.generatedSlides.0.sourceId=${FIELD_CODES.required}`]);
  });
});

describe('the ratio a snapshot resolved to', () => {
  it('reads a ratio into the two numbers a renderer needs', () => {
    expect(aspectRatioOf('16:9')).toEqual({ width: 16, height: 9 });
    expect(aspectRatioOf('4:3')).toEqual({ width: 4, height: 3 });
  });

  it('reads nothing out of something that is not a ratio', () => {
    expect(aspectRatioOf('widescreen')).toBeUndefined();
    expect(aspectRatioOf('0:9')).toBeUndefined();
  });

  it('labels validated custom dimensions by the ratio they are, so one ratio has one cache key', () => {
    expect(aspectRatioLabel({ width: 1920, height: 1080 })).toBe('16:9');
    expect(aspectRatioLabel({ width: 16, height: 9 })).toBe('16:9');
    expect(aspectRatioLabel({ width: 1024, height: 768 })).toBe('4:3');
  });
});

describe('parsePreparationInputs', () => {
  const preparation = () => ({
    slideLayout: { id: 'layout-1', revision: 3 },
    serviceTemplate: 'template-rev-2',
    settings: 'settings-rev-7',
    media: 'media-rev-4',
    corpus: 'corpus-rev-1',
    aspectRatio: '16:9',
    safeAreaMargins: { top: 5, right: 5, bottom: 8, left: 5, unit: 'percent' },
    generatedSlides: snapshot().generatedSlides,
  });

  it('parses all preparation inputs and optional fields', () => {
    expect(parsePreparationInputs(preparation())).toEqual({ ok: true, value: preparation() });
  });

  it('leaves absent optional fields undefined', () => {
    const value = preparation();
    delete (value as { safeAreaMargins?: unknown }).safeAreaMargins;
    delete (value as { generatedSlides?: unknown }).generatedSlides;
    const parsed = parsePreparationInputs(value);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.safeAreaMargins : 'refused').toBeUndefined();
    expect(parsed.ok ? parsed.value.generatedSlides : 'refused').toBeUndefined();
  });

  it.each([
    ['slideLayout', (value: ReturnType<typeof preparation>) => delete (value as { slideLayout?: unknown }).slideLayout],
    ['slideLayout.id', (value: ReturnType<typeof preparation>) => delete (value.slideLayout as { id?: string }).id],
    ['serviceTemplate', (value: ReturnType<typeof preparation>) => delete (value as { serviceTemplate?: unknown }).serviceTemplate],
    ['settings', (value: ReturnType<typeof preparation>) => delete (value as { settings?: unknown }).settings],
    ['media', (value: ReturnType<typeof preparation>) => delete (value as { media?: unknown }).media],
    ['corpus', (value: ReturnType<typeof preparation>) => delete (value as { corpus?: unknown }).corpus],
    ['aspectRatio', (value: ReturnType<typeof preparation>) => delete (value as { aspectRatio?: unknown }).aspectRatio],
  ])('refuses missing %s', (_field, change) => {
    const value = preparation();
    change(value);
    expect(parsePreparationInputs(value).ok).toBe(false);
  });

  it('refuses wrong required field types', () => {
    const layout = preparation();
    (layout.slideLayout as { revision: unknown }).revision = '3';
    expect(parsePreparationInputs(layout).ok).toBe(false);
    const template = preparation();
    (template as { serviceTemplate: unknown }).serviceTemplate = 3;
    expect(parsePreparationInputs(template).ok).toBe(false);
  });

  it('refuses malformed optional safe area margins', () => {
    const value = preparation();
    value.safeAreaMargins.top = 50;
    expect(parsePreparationInputs(value).ok).toBe(false);
    const missingEdge = preparation();
    delete (missingEdge.safeAreaMargins as { left?: number }).left;
    expect(parsePreparationInputs(missingEdge).ok).toBe(false);
  });
});
