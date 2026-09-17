import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_MAXIMUM_AUDIO_VOLUME,
  DEFAULT_SAFE_AREA,
  PROVISIONAL_MINIMUM_READABLE_HEIGHT_RATIO,
  REFERENCE_CANVAS_WIDTH,
  RenderConfigurationError,
  administrativeDefaults,
  canvasFor,
  resolveOutputProfile,
  safeAreaOf,
  validateAspectRatio,
  validateMaximumAudioVolume,
  validateMinimumReadableHeightRatio,
  validateSafeArea,
} from './output-profile.js';

describe('the administrative defaults', () => {
  it('starts at the numbers the spec states', () => {
    expect(administrativeDefaults.aspectRatio).toEqual({ width: 16, height: 9 });
    expect(administrativeDefaults.safeArea).toEqual({ top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 });
    expect(administrativeDefaults.minimumReadableHeightRatio).toBe(PROVISIONAL_MINIMUM_READABLE_HEIGHT_RATIO);
    expect(administrativeDefaults.maximumAudioVolume).toBe(DEFAULT_MAXIMUM_AUDIO_VOLUME);
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

  it('lets a service raise the readable floor and never lower it', () => {
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

  // REND-01: "administration defines an absolute minimum readable size per output type". A type that was
  // given its own number has been given its floor; the global default is what a type without one falls
  // back to, not a second floor underneath it. A stage display an administrator deliberately set lower
  // than the wall is a configuration, not a mistake to be silently corrected upwards.
  it('honours a per-output-type floor below the global default rather than raising it', () => {
    const defaults = { ...administrativeDefaults, byOutputType: { stage: { minimumReadableHeightRatio: 0.02 } } };

    expect(defaults.minimumReadableHeightRatio).toBeGreaterThan(0.02);
    expect(resolveOutputProfile({ outputType: 'stage', defaults }).minimumReadableHeightRatio).toBe(0.02);
    expect(
      resolveOutputProfile({ outputType: 'stage', defaults, service: { minimumReadableHeightRatio: 0.01 } })
        .minimumReadableHeightRatio,
    ).toBe(0.02);
  });

  // The service number is the one value in this file that arrives from outside administration, and it used
  // to be the one value that reached the auto-fit ladder without ever having been validated.
  it('refuses a service floor that is out of range instead of handing it to auto-fit', () => {
    expect(() => resolveOutputProfile({ outputType: 'main', service: { minimumReadableHeightRatio: 0.75 } })).toThrow(
      RenderConfigurationError,
    );
    expect(() =>
      resolveOutputProfile({ outputType: 'main', service: { minimumReadableHeightRatio: Number.NaN } }),
    ).toThrow(/minimum readable height ratio/u);
  });

  // The volume bound is the readable floor with the comparison mirrored: administration, then the output
  // type, then the service — and because it is a ceiling rather than a floor, the service layer may only
  // ever bring it down. A house that wants quieter slides than administration allows gets them; one that
  // wants louder ones does not.
  it('lets a service lower the volume bound and never raise it', () => {
    const defaults = { ...administrativeDefaults, byOutputType: { stream: { maximumAudioVolume: 0.8 } } };

    expect(resolveOutputProfile({ outputType: 'stream', defaults }).maximumAudioVolume).toBe(0.8);
    expect(resolveOutputProfile({ outputType: 'main', defaults }).maximumAudioVolume).toBe(
      DEFAULT_MAXIMUM_AUDIO_VOLUME,
    );
    expect(
      resolveOutputProfile({ outputType: 'stream', defaults, service: { maximumAudioVolume: 0.3 } })
        .maximumAudioVolume,
    ).toBe(0.3);
    expect(
      resolveOutputProfile({ outputType: 'stream', defaults, service: { maximumAudioVolume: 1 } })
        .maximumAudioVolume,
    ).toBe(0.8);
  });

  it('refuses a volume bound that is not a fraction of the output volume', () => {
    const defaults = { ...administrativeDefaults, byOutputType: { stream: { maximumAudioVolume: 4 } } };

    expect(() => resolveOutputProfile({ outputType: 'stream', defaults })).toThrow(RenderConfigurationError);
    expect(() => resolveOutputProfile({ outputType: 'main', service: { maximumAudioVolume: -1 } })).toThrow(
      /maximum audio volume/u,
    );
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

  // Silence is a number an administrator may mean, unlike an unreadable font size, so zero passes here
  // where it is refused above.
  it('refuses a volume bound outside the output’s own volume and accepts silence', () => {
    expect(() => validateMaximumAudioVolume(1.5)).toThrow(RenderConfigurationError);
    expect(() => validateMaximumAudioVolume(Number.NaN)).toThrow(/maximum audio volume/u);
    expect(validateMaximumAudioVolume(0)).toBe(0);
    expect(validateMaximumAudioVolume(1)).toBe(1);
  });
});
