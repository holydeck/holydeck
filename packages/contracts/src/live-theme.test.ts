import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THEMES,
  THEME_SURFACES,
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_NORMAL_TEXT,
  contrastRatio,
  initialSurfaceThemeState,
  meetsThemeContrast,
  relativeLuminance,
  setSurfaceTheme,
} from './live-theme.js';

import type { HexColor, SurfaceThemeState, Theme, ThemeSurface } from './live-theme.js';

const THEME_A: Theme = { id: 'a', background: '#000000', foreground: '#ffffff', accent: '#ffffff' };
const THEME_B: Theme = { id: 'b', background: '#ffffff', foreground: '#000000', accent: '#000000' };

const PINNED_CONTENT = Object.freeze({
  service: 'service-rev-1',
  slideLayout: 'layout-rev-1',
  media: 'media-rev-1',
});

const start = (): SurfaceThemeState<typeof PINNED_CONTENT> => initialSurfaceThemeState(PINNED_CONTENT, THEME_A);

describe('THEME_SURFACES names exactly LIVE-09\'s four surfaces', () => {
  it('is audience, stage, singer, operator and nothing else', () => {
    expect(THEME_SURFACES).toEqual(['audience', 'stage', 'singer', 'operator']);
  });
});

describe('every surface starts under the same theme, over the same content (LIVE-09)', () => {
  it('holds one theme per surface, all equal to the theme handed in, at version zero', () => {
    const state = start();
    expect(state.version).toBe(0);
    expect(state.content).toBe(PINNED_CONTENT);
    for (const surface of THEME_SURFACES) expect(state.themes[surface]).toEqual(THEME_A);
  });
});

describe('a surface theme change never moves the prepared content underneath it (LIVE-09)', () => {
  it('leaves content byte-unchanged across any number of setSurfaceTheme calls', () => {
    const before = JSON.stringify(start().content);
    let state = start();
    state = setSurfaceTheme(state, 'audience', THEME_B);
    state = setSurfaceTheme(state, 'stage', THEME_B);
    state = setSurfaceTheme(state, 'singer', THEME_A);
    state = setSurfaceTheme(state, 'operator', THEME_B);
    expect(state.content).toBe(PINNED_CONTENT);
    expect(JSON.stringify(state.content)).toBe(before);
  });

  it('moves exactly the one surface named, leaving the other three exactly as they were', () => {
    let state = start();
    state = setSurfaceTheme(state, 'stage', THEME_B);
    expect(state.themes.stage).toEqual(THEME_B);
    expect(state.themes.audience).toEqual(THEME_A);
    expect(state.themes.singer).toEqual(THEME_A);
    expect(state.themes.operator).toEqual(THEME_A);
  });

  it('bumps version by exactly one per call, never on a read', () => {
    let state = start();
    state = setSurfaceTheme(state, 'audience', THEME_B);
    expect(state.version).toBe(1);
    state = setSurfaceTheme(state, 'stage', THEME_B);
    expect(state.version).toBe(2);
  });
});

describe('Audience, Stage, Singer, and Operator can differ independently (LIVE-09)', () => {
  it('lets all four surfaces land on different themes with no cross-surface effect', () => {
    let state = start();
    const themed: Record<ThemeSurface, Theme> = {
      audience: { id: 'audience-x', background: '#010101', foreground: '#fefefe', accent: '#fefefe' },
      stage: { id: 'stage-x', background: '#020202', foreground: '#fdfdfd', accent: '#fdfdfd' },
      singer: { id: 'singer-x', background: '#030303', foreground: '#fcfcfc', accent: '#fcfcfc' },
      operator: { id: 'operator-x', background: '#040404', foreground: '#fbfbfb', accent: '#fbfbfb' },
    };
    for (const surface of THEME_SURFACES) state = setSurfaceTheme(state, surface, themed[surface]);
    for (const surface of THEME_SURFACES) expect(state.themes[surface]).toEqual(themed[surface]);
    expect(state.content).toBe(PINNED_CONTENT);
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBe(1);
  });

  it('throws on anything not a six-digit hex color', () => {
    expect(() => relativeLuminance('#fff' as HexColor)).toThrow(RangeError);
    expect(() => relativeLuminance('not-a-color' as HexColor)).toThrow(RangeError);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black against white, in either argument order', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
  });

  it('is 1 for a color against itself', () => {
    expect(contrastRatio('#7DD3FC', '#7DD3FC')).toBeCloseTo(1, 5);
  });
});

describe('meetsThemeContrast checks WCAG 2.2 AA\'s two thresholds (1.4.3 and 1.4.11)', () => {
  it('passes a theme with high-contrast foreground and accent', () => {
    expect(meetsThemeContrast(THEME_A)).toBe(true);
    expect(meetsThemeContrast(THEME_B)).toBe(true);
  });

  it('fails a theme whose foreground is too close to its background', () => {
    const lowContrast: Theme = { id: 'low', background: '#888888', foreground: '#8a8a8a', accent: '#ffffff' };
    expect(contrastRatio(lowContrast.foreground, lowContrast.background)).toBeLessThan(WCAG_AA_NORMAL_TEXT);
    expect(meetsThemeContrast(lowContrast)).toBe(false);
  });

  it('fails a theme whose accent is too close to its background even with a passing foreground', () => {
    const lowAccent: Theme = { id: 'low-accent', background: '#888888', foreground: '#ffffff', accent: '#7a7a7a' };
    expect(contrastRatio(lowAccent.accent, lowAccent.background)).toBeLessThan(WCAG_AA_LARGE_TEXT);
    expect(meetsThemeContrast(lowAccent)).toBe(false);
  });
});

describe('every shipped theme in DEFAULT_THEMES clears WCAG 2.2 AA (LIVE-09 test 3)', () => {
  it('proves each of the four default themes, not just samples one', () => {
    for (const surface of THEME_SURFACES) {
      expect(meetsThemeContrast(DEFAULT_THEMES[surface])).toBe(true);
    }
  });
});
