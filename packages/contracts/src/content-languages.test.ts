import { describe, expect, it } from 'vitest';

import { CONTENT_LANGUAGES, isContentLanguageKey } from './content-languages.js';

describe('the content-language registry (LANG-01)', () => {
  it('carries Tamil and Romanized Tamil, the languages spec §11.5 names for a song', () => {
    expect(CONTENT_LANGUAGES).toEqual([
      { key: 'ta', displayName: 'Tamil', script: 'Tamil' },
      { key: 'ta-Latn', displayName: 'Romanized Tamil', script: 'Latin' },
    ]);
  });

  it('answers membership by key', () => {
    for (const language of CONTENT_LANGUAGES) {
      expect(isContentLanguageKey(language.key)).toBe(true);
    }
    expect(isContentLanguageKey('fr')).toBe(false);
    expect(isContentLanguageKey('')).toBe(false);
  });
});
