// Which locales the product ships, and what a device asking for another one is served. English is the
// source catalog and the last resort, which is what keeps a message identifier from ever reaching a
// screen: the chain a request resolves to always ends somewhere every key exists.

export const LOCALES = ['en', 'de', 'ta'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

// A device sends a language tag, not a locale: `de-CH`, `de_AT` and a bare `de` are all German, and an
// Accept-Language entry can carry its quality value with it. The language subtag is the whole question
// here, because the product ships one catalog per language and no regional variants.
const languageOf = (tag: string): string => tag.toLowerCase().replace(/[-_;].*$/u, '').trim();

/**
 * The locale a client renders in: the first language it asked for that this product speaks, English if
 * it asked for none. The list is taken in the order it arrives — `navigator.languages` is already in
 * preference order, and a caller reading Accept-Language sorts by quality value before calling.
 */
export function localeFor(requested: readonly string[]): Locale {
  for (const tag of requested) {
    const language = languageOf(tag);
    if (isLocale(language)) return language;
  }
  return DEFAULT_LOCALE;
}

/**
 * Every shipped locale a request maps to, in the order the device asked for them, with English present
 * however it was asked for. Exported because it is the auditable form of the fallback rule: the chain
 * says why a client is rendering the locale it is, and its first entry is that locale.
 */
export function fallbackChain(requested: readonly string[]): readonly Locale[] {
  const chain: Locale[] = [];
  for (const tag of requested) {
    const language = languageOf(tag);
    if (isLocale(language) && !chain.includes(language)) chain.push(language);
  }
  return chain.includes(DEFAULT_LOCALE) ? chain : [...chain, DEFAULT_LOCALE];
}
