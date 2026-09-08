import { describe, expect, it } from 'vitest';
import { HolyDeckError } from './messages.js';
import { knownTranslations, translationId } from './translations.js';

describe('translationId', () => {
  it('maps the nine known abbreviations', () => {
    expect(knownTranslations).toEqual({
      AMP: 1588,
      ICL00D: 1196,
      KJV: 1,
      NIV: 111,
      NLT: 116,
      NR06: 122,
      SCH2000: 157,
      TAOVBSI: 339,
      VULG: 823,
    });
    expect(translationId('SCH2000')).toBe(157);
  });

  it('is case-insensitive', () => {
    expect(translationId('kjv')).toBe(1);
  });

  it('passes numeric ids through for translations not in the registry', () => {
    expect(translationId('2377')).toBe(2377);
  });

  it('throws unknown_translation with the known list in the message', () => {
    try {
      translationId('XYZ');
      expect.unreachable();
    } catch (error) {
      expect((error as HolyDeckError).code).toBe('unknown_translation');
      expect((error as HolyDeckError).message).toContain('KJV');
    }
  });
});
