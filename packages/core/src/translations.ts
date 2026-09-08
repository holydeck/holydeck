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

export function translationId(abbr: string): number {
  const upper = abbr.trim().toUpperCase();
  if (/^\d+$/.test(upper)) return Number(upper);
  const id = knownTranslations[upper];
  if (id === undefined) {
    throw new HolyDeckError('unknown_translation', {
      abbr,
      known: Object.keys(knownTranslations).sort().join(', '),
    });
  }
  return id;
}
