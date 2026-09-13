// Locale-aware formatting, which is `Intl` with the two decisions it leaves open closed: the locale is
// always one this product ships, and the time zone is always named by the caller. Intl's default zone
// is the host's, and an application server rendering a service time in its own zone rather than the
// congregation's is a whole class of wrong times nobody notices until a Sunday morning.

import type { Locale } from './locales.js';

export function formatNumber(locale: Locale, value: number): string {
  return new Intl.NumberFormat(locale).format(value);
}

export interface DateTimeOptions {
  /** An IANA zone name. Required: see the note at the top of this file. */
  readonly timeZone: string;
  readonly dateStyle?: 'full' | 'long' | 'medium' | 'short';
  readonly timeStyle?: 'full' | 'long' | 'medium' | 'short';
}

export function formatDateTime(locale: Locale, instant: Date, options: DateTimeOptions): string {
  const { timeZone, dateStyle = 'medium', timeStyle = 'short' } = options;
  return new Intl.DateTimeFormat(locale, { timeZone, dateStyle, timeStyle }).format(instant);
}

/**
 * The two categories every shipped locale distinguishes. English, German and Tamil all separate one
 * from everything else and nothing more, so a counted message ships two variants; a locale with more
 * categories would add variants to the catalogs and cases here, which is why this narrows rather than
 * passing Intl's own category through.
 */
export type PluralCategory = 'one' | 'other';

export function pluralCategory(locale: Locale, count: number): PluralCategory {
  return new Intl.PluralRules(locale).select(count) === 'one' ? 'one' : 'other';
}
