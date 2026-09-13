import { describe, expect, it } from 'vitest';

import { formatDateTime, formatNumber, pluralCategory } from './format.js';

// A Friday evening in September, written as an instant so every assertion below says which zone it
// was rendered in rather than inheriting the machine's.
const INSTANT = new Date(Date.UTC(2026, 8, 13, 18, 5, 0));
const TAMIL_SCRIPT = /[஀-௿]/u;

describe('formatting a number', () => {
  it('groups and points it the way each locale does', () => {
    expect(formatNumber('en', 1234.5)).toBe('1,234.5');
    expect(formatNumber('de', 1234.5)).toBe('1.234,5');
    expect(formatNumber('ta', 1234.5)).toBe('1,234.5');
  });

  // Tamil groups by two above the thousand, which English and German both do not: if a locale were
  // quietly falling back to English, this is the assertion that would notice.
  it('groups a six-figure number the way the locale does, not the way English does', () => {
    expect(formatNumber('en', 123456)).toBe('123,456');
    expect(formatNumber('de', 123456)).toBe('123.456');
    expect(formatNumber('ta', 123456)).toBe('1,23,456');
  });

  it('formats zero and a negative number without losing the locale', () => {
    expect(formatNumber('de', 0)).toBe('0');
    expect(formatNumber('de', -1234)).toBe('-1.234');
  });
});

describe('formatting an instant', () => {
  it('renders the date and time each locale writes', () => {
    expect(formatDateTime('en', INSTANT, { timeZone: 'UTC' })).toContain('Sep 13, 2026');
    expect(formatDateTime('en', INSTANT, { timeZone: 'UTC' })).toMatch(/6:05\s?PM/u);
    expect(formatDateTime('de', INSTANT, { timeZone: 'UTC' })).toContain('13.09.2026');
    expect(formatDateTime('de', INSTANT, { timeZone: 'UTC' })).toContain('18:05');
    expect(formatDateTime('de', INSTANT, { timeZone: 'UTC' })).not.toMatch(/[AP]M/u);
    expect(formatDateTime('ta', INSTANT, { timeZone: 'UTC' })).toMatch(TAMIL_SCRIPT);
    expect(formatDateTime('ta', INSTANT, { timeZone: 'UTC' })).toContain('2026');
  });

  it('renders the zone it was given and never the one the host happens to sit in', () => {
    expect(formatDateTime('de', INSTANT, { timeZone: 'Europe/Zurich' })).toContain('20:05');
    expect(formatDateTime('de', INSTANT, { timeZone: 'Pacific/Auckland' })).toContain('14.09.2026');
  });

  it('refuses a zone that does not exist rather than guessing one', () => {
    expect(() => formatDateTime('en', INSTANT, { timeZone: 'Nowhere/Invented' })).toThrow(RangeError);
  });
});

describe('choosing between one and many', () => {
  it('agrees with the locale about which counts are singular', () => {
    expect(pluralCategory('en', 1)).toBe('one');
    expect(pluralCategory('de', 1)).toBe('one');
    expect(pluralCategory('ta', 1)).toBe('one');
    for (const count of [0, 2, 11, 1234]) {
      expect(pluralCategory('en', count)).toBe('other');
      expect(pluralCategory('de', count)).toBe('other');
      expect(pluralCategory('ta', count)).toBe('other');
    }
  });
});
