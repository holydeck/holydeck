// The content-language registry §11.5 describes: "stable key, localized display name, script,
// fallback font, and active/archive state." This file carries the first four fields and the two
// entries LANG-01 itself needs — Tamil and Romanized Tamil, spec §11.5's own stated default for a
// song — so a language block is keyed to something real rather than a string typed inline.
// `fallbackFont` is T50's: the T11 legal decision settled on shipping no bundled/licensed webfont,
// so it names a CSS font stack of faces already installed on supported platforms instead.
//
// `CONTENT_LANGUAGES` below stays exactly what it was: a compile-time list nothing but a Layout's
// own `languageKey` presence check (`isContentLanguageKey`) reads. Active/archive state and a real,
// administrable registry are SEED-01/T59's: `apps/app/src/content-languages.ts` stamps each entry
// as the persisted `contentLanguage` entity `entities.ts` already reserves a policy for, seeded from
// the two entries here. `ContentLanguageDraft`/`parseContentLanguageDraft` below are that store's
// payload shape, kept in contracts because a shape a store validates against belongs beside the
// entity kind it is stamped as, the same way `slide-labels.ts` keeps `SlideLabelDraft`.

import { type FieldReader, type ParseFn, parseObject } from './problems.js';

import type { EntityKind } from './entities.js';

/** One entry of the content-language registry: a stable key, a name to show, the script it's
 *  written in, and the CSS font stack that script renders through. */
export interface ContentLanguage {
  readonly key: string;
  readonly displayName: string;
  readonly script: string;
  readonly fallbackFont: string;
}

/** The kind the persisted registry stamps each entry as, named once for the store that administers it. */
export const CONTENT_LANGUAGE_KIND = 'contentLanguage' satisfies EntityKind;

/** What an Admin hands in to define or re-save one registry entry. The key is the entity's own
 *  identifier, chosen once at creation and never part of a later edit. */
export interface ContentLanguageDraft {
  readonly displayName: string;
  readonly script: string;
  readonly fallbackFont: string;
}

export const parseContentLanguageDraft: ParseFn<ContentLanguageDraft> = (value, path) =>
  parseObject(value, path, (reader: FieldReader) => ({
    displayName: reader.text('displayName'),
    script: reader.text('script'),
    fallbackFont: reader.text('fallbackFont'),
  }));

/**
 * The T11 legal decision: HolyDeck ships no bundled or licensed webfont for Tamil script. Both
 * `ta` and `ta-Latn` render through this same stack — it names faces already present on supported
 * platforms, ending in a generic sans-serif so a platform with none of them still renders text.
 */
export const TAMIL_FALLBACK_FONT_STACK = '"Noto Sans Tamil", "Tamil Sangam MN", Latha, sans-serif';

/**
 * LANG-01's own minimal registry (see header). `ta` and `ta-Latn` match the keys already used as
 * illustrative fixtures elsewhere in this codebase (`layouts.test.ts`, `slide-layouts.test.ts`,
 * `slide-layout-propagation.test.ts`, `portable.test.ts`) — none of those read this registry, but
 * the coincidence is a signal this file is not inventing a new naming convention.
 */
export const CONTENT_LANGUAGES: readonly ContentLanguage[] = Object.freeze([
  Object.freeze({ key: 'ta', displayName: 'Tamil', script: 'Tamil', fallbackFont: TAMIL_FALLBACK_FONT_STACK }),
  Object.freeze({
    key: 'ta-Latn',
    displayName: 'Romanized Tamil',
    script: 'Latin',
    fallbackFont: TAMIL_FALLBACK_FONT_STACK,
  }),
]);

/** Whether a key names a language this registry actually carries. */
export function isContentLanguageKey(key: string): boolean {
  return CONTENT_LANGUAGES.some((language) => language.key === key);
}
