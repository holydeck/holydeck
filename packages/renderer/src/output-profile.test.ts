import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_SAFE_AREA,
  PROVISIONAL_MINIMUM_READABLE_HEIGHT_RATIO,
  REFERENCE_CANVAS_WIDTH,
  RenderConfigurationError,
  administrativeDefaults,
  canvasFor,
  resolveOutputProfile,
  safeAreaOf,
  validateAspectRatio,
  validateMinimumReadableHeightRatio,
  validateSafeArea,
} from './output-profile.js';

describe('the administrative defaults', () => {
  it('starts at the numbers the spec states', () => {
    expect(administrativeDefaults.aspectRatio).toEqual({ width: 16, height: 9 });
    expect(administrativeDefaults.safeArea).toEqual({ top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 });
    expect(administrativeDefaults.minimumReadableHeightRatio).toBe(PROVISIONAL_MINIMUM_READABLE_HEIGHT_RATIO);
    expect(Object.isFrozen(administrativeDefaults)).toBe(true);
  });

  it('resolves one reference canvas per ratio', () => {
    expect(canvasFor(DEFAULT_ASPECT_RATIO)).toEqual({ width: REFERENCE_CANVAS_WIDTH, height: 1080 });
    expect(canvasFor({ width: 4, height: 3 })).toEqual({ width: 1920, height: 1440 });
    expect(canvasFor({ width: 9, height: 16 }, 1080)).toEqual({ width: 1080, height: 1920 });
  });

  it('spells one margin onto every edge', () => {
    expect(safeAreaOf(0.05)).toEqual(DEFAULT_SAFE_AREA);
  });
});

describe('resolving an output profile', () => {
  it('falls through administration, then the output type, then the service', () => {
    const defaults = {
      ...administrativeDefaults,
      byOutputType: { stage: { aspectRatio: { width: 4, height: 3 }, safeArea: safeAreaOf(0.08) } },
    };

    expect(resolveOutputProfile({ outputType: 'stage', defaults }).aspectRatio).toEqual({ width: 4, height: 3 });
    expect(resolveOutputProfile({ outputType: 'stage', defaults }).safeArea).toEqual(safeAreaOf(0.08));
    expect(resolveOutputProfile({ outputType: 'main', defaults }).aspectRatio).toEqual(DEFAULT_ASPECT_RATIO);
    expect(
      resolveOutputProfile({ outputType: 'stage', defaults, service: { aspectRatio: { width: 1, height: 1 } } })
        .aspectRatio,
    ).toEqual({ width: 1, height: 1 });
  });

  it('takes the administrative defaults when a caller names none', () => {
    expect(resolveOutputProfile({ outputType: 'main' }).aspectRatio).toEqual(DEFAULT_ASPECT_RATIO);
  });

  it('lets the readable floor rise per output type and never fall', () => {
    const defaults = { ...administrativeDefaults, byOutputType: { stream: { minimumReadableHeightRatio: 0.06 } } };

    expect(resolveOutputProfile({ outputType: 'stream', defaults }).minimumReadableHeightRatio).toBe(0.06);
    expect(
      resolveOutputProfile({ outputType: 'stream', defaults, service: { minimumReadableHeightRatio: 0.09 } })
        .minimumReadableHeightRatio,
    ).toBe(0.09);
    expect(
      resolveOutputProfile({ outputType: 'stream', defaults, service: { minimumReadableHeightRatio: 0.01 } })
        .minimumReadableHeightRatio,
    ).toBe(0.06);
  });

  it('freezes what it resolved', () => {
    const profile = resolveOutputProfile({ outputType: 'main' });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.aspectRatio)).toBe(true);
  });
});

describe('validating what an administrator or a service asked for', () => {
  it('refuses a ratio that is not two positive numbers', () => {
    expect(() => validateAspectRatio({ width: 0, height: 9 })).toThrow(RenderConfigurationError);
    expect(() => validateAspectRatio({ width: 16, height: Number.NaN })).toThrow(RenderConfigurationError);
  });

  it('refuses a ratio outside the validated range and accepts the shapes inside it', () => {
    expect(() => validateAspectRatio({ width: 40, height: 1 })).toThrow(/outside the validated range/u);
    expect(() => validateAspectRatio({ width: 1, height: 40 })).toThrow(/outside the validated range/u);
    expect(validateAspectRatio({ width: 32, height: 9 })).toEqual({ width: 32, height: 9 });
    expect(validateAspectRatio({ width: 9, height: 16 })).toEqual({ width: 9, height: 16 });
  });

  it('refuses a margin that is negative or eats half the canvas', () => {
    expect(() => validateSafeArea({ ...DEFAULT_SAFE_AREA, top: -0.01 })).toThrow(RenderConfigurationError);
    expect(() => validateSafeArea({ ...DEFAULT_SAFE_AREA, left: 0.5 })).toThrow(/below half the canvas/u);
    expect(validateSafeArea(safeAreaOf(0.1))).toEqual(safeAreaOf(0.1));
  });

  it('refuses a readable floor that is not a fraction of the canvas height', () => {
    expect(() => validateMinimumReadableHeightRatio(0)).toThrow(RenderConfigurationError);
    expect(() => validateMinimumReadableHeightRatio(0.75)).toThrow(RenderConfigurationError);
    expect(validateMinimumReadableHeightRatio(0.04)).toBe(0.04);
  });
});
