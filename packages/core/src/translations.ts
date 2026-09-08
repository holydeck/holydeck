import { HolyDeckError } from './messages.js';

export const knownTranslations: Record<string, number> = {
  AMP: 1588,
  ICL00D: 1196,
  KJV: 1,
  NIV: 111,
  NLT: 116,
  NR06: 122,
  SCH2000: 157,
  TAOVBSI: 339,
  VULG: 823,
};

/** The bible.com id of a translation, or undefined for a name this build does not know. */
export function findTranslationId(abbr: string): number | undefined {
  const upper = abbr.trim().toUpperCase();
  if (/^\d+$/.test(upper)) return Number(upper);
  return knownTranslations[upper];
}

export function translationId(abbr: string): number {
  const id = findTranslationId(abbr);
  if (id === undefined) {
    throw new HolyDeckError('unknown_translation', {
      abbr,
      known: Object.keys(knownTranslations).sort().join(', '),
    });
  }
  return id;
}
