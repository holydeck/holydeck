// The content-language registry §11.5 describes: "stable key, localized display name, script,
// fallback font, and active/archive state." This file carries the first four fields and the two
// entries LANG-01 itself needs — Tamil and Romanized Tamil, spec §11.5's own stated default for a
// song — so a language block is keyed to something real rather than a string typed inline.
// `fallbackFont` is T50's: the T11 legal decision settled on shipping no bundled/licensed webfont,
// so it names a CSS font stack of faces already installed on supported platforms instead. Active/
// archive state, and populating the registry beyond these two entries, are still SEED-01/T59's
// job: `contentLanguage`'s `EntityPolicy` in `entities.ts` already reserves that requirement, and
// this file does not anticipate it.
//
// This is a compile-time, in-code list, not the persisted `contentLanguage` entity `entities.ts`
// stubs — it never goes through `library.js`/`revisions.js` and carries no `EntityStamp`. There
// is nothing here for a future SEED-01 store to migrate away from, only a shape it will match or
// replace outright once a real, administrable registry exists.

/** One entry of the content-language registry: a stable key, a name to show, the script it's
 *  written in, and the CSS font stack that script renders through. */
export interface ContentLanguage {
  readonly key: string;
  readonly displayName: string;
  readonly script: string;
  readonly fallbackFont: string;
}

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
