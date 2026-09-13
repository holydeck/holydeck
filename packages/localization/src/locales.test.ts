import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCALE, LOCALES, fallbackChain, isLocale, localeFor } from './locales.js';

describe('the locales the product ships', () => {
  it('is the three the specification names, and English is the one everything falls back to', () => {
    expect(LOCALES).toEqual(['en', 'de', 'ta']);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(LOCALES).toContain(DEFAULT_LOCALE);
  });

  it('recognises a shipped locale and nothing else', () => {
    for (const locale of LOCALES) expect(isLocale(locale)).toBe(true);
    for (const other of ['fr', 'EN', 'en-GB', 'e', '', ' en', 7, undefined, null, {}]) {
      expect(isLocale(other)).toBe(false);
    }
  });
});

describe('loading the locale a device asks for', () => {
  it('serves the first shipped language in the list, whatever region or case it arrives in', () => {
    expect(localeFor(['en'])).toBe('en');
    expect(localeFor(['de'])).toBe('de');
    expect(localeFor(['ta'])).toBe('ta');
    expect(localeFor(['de-CH'])).toBe('de');
    expect(localeFor(['TA-IN'])).toBe('ta');
    expect(localeFor(['de_AT'])).toBe('de');
    expect(localeFor([' ta '])).toBe('ta');
    expect(localeFor(['de;q=0.8'])).toBe('de');
    expect(localeFor(['fr-CA', 'ta-LK', 'de'])).toBe('ta');
  });

  it('serves English when the device asks for nothing this product speaks', () => {
    expect(localeFor([])).toBe('en');
    expect(localeFor(['fr', 'it'])).toBe('en');
    expect(localeFor([''])).toBe('en');
  });
});

describe('the fallback chain', () => {
  it('lists every shipped locale the request maps to, in the order it asked for them', () => {
    expect(fallbackChain(['de-CH'])).toEqual(['de', 'en']);
    expect(fallbackChain(['ta-IN', 'de-DE'])).toEqual(['ta', 'de', 'en']);
    expect(fallbackChain(['en-US'])).toEqual(['en']);
    expect(fallbackChain(['fr'])).toEqual(['en']);
    expect(fallbackChain([])).toEqual(['en']);
  });

  it('names a locale once, however many regions of it the device asks for', () => {
    expect(fallbackChain(['de-CH', 'de-AT', 'de'])).toEqual(['de', 'en']);
  });

  it('keeps English in the chain without moving it, so the last candidate always has a catalog', () => {
    expect(fallbackChain(['en', 'de'])).toEqual(['en', 'de']);
    for (const requested of [[], ['fr'], ['ta'], ['de', 'ta'], ['en']]) {
      expect(fallbackChain(requested)).toContain(DEFAULT_LOCALE);
    }
  });

  it('starts with the locale the client will actually render in', () => {
    for (const requested of [[], ['fr'], ['ta-LK'], ['de-CH', 'ta'], ['en']]) {
      expect(fallbackChain(requested).at(0)).toBe(localeFor(requested));
    }
  });
});
