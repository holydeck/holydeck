import { describe, expect, it } from 'vitest';

import { CONTENT_LANGUAGES, TAMIL_FALLBACK_FONT_STACK, isContentLanguageKey } from './content-languages.js';

describe('the content-language registry (LANG-01)', () => {
  it('carries Tamil and Romanized Tamil, the languages spec §11.5 names for a song', () => {
    expect(CONTENT_LANGUAGES).toEqual([
      { key: 'ta', displayName: 'Tamil', script: 'Tamil', fallbackFont: TAMIL_FALLBACK_FONT_STACK },
      { key: 'ta-Latn', displayName: 'Romanized Tamil', script: 'Latin', fallbackFont: TAMIL_FALLBACK_FONT_STACK },
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

// T50: the T11 legal decision to ship no bundled/licensed webfont for Tamil script. `ta` and
// `ta-Latn` name a CSS font stack of faces already installed on supported platforms instead of a
// font file this repository would otherwise have to license and ship.
describe('the Tamil fallback font stack (T50)', () => {
  // This mirrors the shape of `crossOriginReferences` in apps/app/src/static.ts — that function is
  // this codebase's established "prove nothing crosses the origin" test, checked there against a
  // built HTML/CSS/JS bundle. It cannot be imported here: @holydeck/contracts has no dependency on
  // apps/app (apps/app depends on contracts, never the reverse), and this package ships browser-
  // safe payload contracts, not app-serving code. So this test reimplements the same kind of check
  // — no url(), no @font-face, no absolute or protocol-relative reference a browser would fetch —
  // directly against the font-stack string itself, which is the only place a network font request
  // could be smuggled in.
  const NETWORK_REFERENCE = /url\(|@font-face|@import|https?:|(?<!['"])\/\//iu;

  it('names only local font families, so loading it asks the network for nothing', () => {
    for (const language of CONTENT_LANGUAGES) {
      expect(language.fallbackFont).not.toMatch(NETWORK_REFERENCE);
    }
    expect(TAMIL_FALLBACK_FONT_STACK).not.toMatch(NETWORK_REFERENCE);
  });

  it('is a bare CSS font-family list of named faces, not a font URL', () => {
    // A well-formed font-family list is comma-separated names, each either a bare identifier or a
    // double-quoted string — never a url(...) token, which is the only way CSS ever fetches a font.
    const faces = TAMIL_FALLBACK_FONT_STACK.split(',').map((face) => face.trim());
    for (const face of faces) {
      expect(face).toMatch(/^(?:"[^"]+"|[\w-]+)$/u);
    }
  });

  it('is the single source of truth both Tamil-script entries reference', () => {
    const ta = CONTENT_LANGUAGES.find((language) => language.key === 'ta');
    const romanized = CONTENT_LANGUAGES.find((language) => language.key === 'ta-Latn');
    // Not just equal in value — the same constant, so a future edit to the stack cannot drift
    // between the two entries by editing one string literal and missing the other.
    expect(ta?.fallbackFont).toBe(TAMIL_FALLBACK_FONT_STACK);
    expect(romanized?.fallbackFont).toBe(TAMIL_FALLBACK_FONT_STACK);
  });

  it('is well-formed: a Tamil-capable primary face, a Latin-capable fallback, a generic terminal', () => {
    const faces = TAMIL_FALLBACK_FONT_STACK.split(',').map((face) => face.trim());
    // "Noto Sans Tamil", "Tamil Sangam MN" and Latha are documented, in the platforms that ship
    // them, as carrying Tamil-script glyphs (Google's Noto Sans Tamil; Apple's system Tamil face;
    // Microsoft's bundled Tamil face). This is a claim about published font coverage, not a
    // measurement this workspace's test runner can take — there is no browser or font-metrics
    // engine available here to render a glyph and check it against a Tamil code point.
    expect(faces).toEqual(['"Noto Sans Tamil"', '"Tamil Sangam MN"', 'Latha', 'sans-serif']);
    expect(faces.at(-1)).toBe('sans-serif');
  });

  // Per-platform rendering coverage (T50's second and third "tests first" items). This workspace's
  // rendering tests are pure-function/JSON-model tests (packages/renderer/src/renderer.ts and its
  // renderer.test.ts) with no real browser or font-metrics measurement available: no Playwright,
  // no headless Chrome wired into this suite, no way to ask a real OS which face it resolved a
  // font-family list to. So this table is documentation of publicly known platform font bundling,
  // not a measurement — it records an expectation per platform and never fails on a documented
  // fallback-to-generic-sans-serif case, exactly as the brief asks.
  const PLATFORM_FONT_RESOLUTION: ReadonlyArray<{
    readonly platform: string;
    readonly expectedFace: string;
    readonly resolvesToGenericFallback: boolean;
  }> = [
    { platform: 'macOS / iOS', expectedFace: '"Tamil Sangam MN"', resolvesToGenericFallback: false },
    { platform: 'Windows 10/11', expectedFace: 'Latha', resolvesToGenericFallback: false },
    { platform: 'Android', expectedFace: '"Noto Sans Tamil"', resolvesToGenericFallback: false },
    // A Linux desktop with no Tamil font package installed has none of the three named faces; the
    // stack's own terminal fallback is what still renders Latin fine but shows Tamil as tofu.
    { platform: 'Linux (no Tamil font package installed)', expectedFace: 'sans-serif', resolvesToGenericFallback: true },
  ];

  it('records, per platform, which face the stack is documented to resolve Tamil script through', () => {
    const faces = TAMIL_FALLBACK_FONT_STACK.split(',').map((face) => face.trim());
    for (const { platform, expectedFace, resolvesToGenericFallback } of PLATFORM_FONT_RESOLUTION) {
      expect(faces, platform).toContain(expectedFace);
      // Recorded, not asserted as pass/fail: a platform lacking every named Tamil face is exactly
      // the documented, acceptable outcome this stack is built to still degrade gracefully through.
      expect(typeof resolvesToGenericFallback, platform).toBe('boolean');
    }
  });

  // Romanized Tamil diacritics (T50's fourth "tests first" item). Same honest scope: this checks
  // that the diacritic characters ISO 15919-style Tamil transliteration actually uses fall inside
  // the standard extended-Latin Unicode blocks (Latin-1 Supplement, Latin Extended-A, Latin
  // Extended Additional) that a general-purpose Latin-capable face — including this stack's own
  // "Noto Sans Tamil" (Noto fonts carry basic and extended Latin) and its `sans-serif` terminal —
  // is documented to cover. It does not measure a real glyph on a real font on a real platform.
  const ROMANIZED_TAMIL_DIACRITICS = ['ā', 'ī', 'ū', 'ē', 'ō', 'ñ', 'ṅ', 'ṭ', 'ḍ', 'ṇ', 'ḷ', 'ḻ', 'ṟ'];
  const EXTENDED_LATIN_BLOCKS: ReadonlyArray<readonly [number, number]> = [
    [0x00_a0, 0x00_ff], // Latin-1 Supplement
    [0x01_00, 0x01_7f], // Latin Extended-A
    [0x1e_00, 0x1e_ff], // Latin Extended Additional
  ];

  it('covers the diacritics Romanized Tamil transliteration uses within the Latin fallback', () => {
    expect(ROMANIZED_TAMIL_DIACRITICS.length).toBeGreaterThan(0);
    for (const character of ROMANIZED_TAMIL_DIACRITICS) {
      const codePoint = character.codePointAt(0) ?? 0;
      const covered = EXTENDED_LATIN_BLOCKS.some(([start, end]) => codePoint >= start && codePoint <= end);
      expect(covered, `${character} (U+${codePoint.toString(16).toUpperCase()})`).toBe(true);
    }
  });

  it('gives the ta and ta-Latn registry entries a non-empty fallbackFont equal to the stack', () => {
    for (const key of ['ta', 'ta-Latn'] as const) {
      const language = CONTENT_LANGUAGES.find((entry) => entry.key === key);
      expect(language?.fallbackFont, key).toBeTruthy();
      expect(language?.fallbackFont, key).toBe(TAMIL_FALLBACK_FONT_STACK);
    }
  });
});
