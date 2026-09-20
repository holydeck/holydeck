// Independent per-surface themes over identical prepared content (LIVE-09): Audience, Stage, Singer, and
// Operator each present under their own look, and none of the four ever reaches into what the others show,
// or into the prepared content underneath any of them. This is the pure, framework-free model alone — the
// same split `live-mode.ts` keeps (T84) between a rule and whatever later wires a real surface to it.
// Turning a change into the versioned live event every joined session is pushed, and into the row
// `run-events.ts`'s immutable log appends, is `live-theme.ts`'s own job in the application workspace, not
// this file's: it has no wire, no hub, and no store to reach either of those with.
//
// Three of the four surfaces named here coincide with `live.ts`'s `OUTPUT_CHANNELS` (audience, stage,
// singer) — what a service is actually shown on. Operator is deliberately not a fourth output channel: it
// is Control's own UI, which no service audience ever watches, so `THEME_SURFACES` is its own closed
// vocabulary here rather than an extension of `OutputChannel`.
//
// This repository carries no contrast-checking dependency in any package.json today, so the WCAG 2.2 AA
// math below (Success Criteria 1.4.3 and 1.4.11) is computed directly from the relative-luminance and
// contrast-ratio formulas the specification itself defines, rather than pulling one in for four color pairs.

export const THEME_SURFACES = ['audience', 'stage', 'singer', 'operator'] as const;
export type ThemeSurface = (typeof THEME_SURFACES)[number];

/** A six-digit hex color, `#` included — the one shape every function below reads and writes, so a theme
 *  never carries a color format a browser's own CSS cannot take verbatim. */
export type HexColor = `#${string}`;

/**
 * One surface's whole look: `background` and `foreground` are the pair normal text is read against
 * (WCAG's "normal text" case, 4.5:1 — Success Criterion 1.4.3); `accent` is what a large heading, an icon,
 * or a UI control border is drawn in against `background` (the "large text and UI components" case, 3:1 —
 * Success Criterion 1.4.11). Nothing else is a color this model knows about: a real stylesheet may derive
 * more from these three, but every one of them has to trace back to a pair this module can check.
 */
export interface Theme {
  readonly id: string;
  readonly background: HexColor;
  readonly foreground: HexColor;
  readonly accent: HexColor;
}

/**
 * Every surface's theme, over one piece of prepared content shared by all four — `C` left generic exactly
 * as `live-mode.ts` leaves `P` generic, since what "prepared content" actually is stays whichever later
 * task wires a real renderer to this. `version` is what a caller hands a live event as its own version: it
 * moves by exactly one on every `setSurfaceTheme` call, never on a call that only reads this state.
 */
export interface SurfaceThemeState<C> {
  readonly content: C;
  readonly themes: Readonly<Record<ThemeSurface, Theme>>;
  readonly version: number;
}

/** Every surface starts under the same theme, at version zero, over whatever content was already prepared
 *  — this call never inspects or copies `content`, only holds the same reference. */
export function initialSurfaceThemeState<C>(content: C, theme: Theme): SurfaceThemeState<C> {
  const themes = Object.fromEntries(
    THEME_SURFACES.map((surface): [ThemeSurface, Theme] => [surface, theme]),
  ) as Record<ThemeSurface, Theme>;
  return { content, themes: Object.freeze(themes), version: 0 };
}

/**
 * Moves exactly one surface's theme, leaving every other surface's theme — and `content`, by reference —
 * untouched. This is the whole of "independently" (LIVE-09): nothing about how Audience is themed is
 * reachable from a call that only names Stage, and `content` is never the thing that moved.
 */
export function setSurfaceTheme<C>(
  state: SurfaceThemeState<C>,
  surface: ThemeSurface,
  theme: Theme,
): SurfaceThemeState<C> {
  return {
    content: state.content,
    themes: Object.freeze({ ...state.themes, [surface]: theme }),
    version: state.version + 1,
  };
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/u;

function srgbChannel(hex: HexColor, start: number): number {
  const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
  return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG's relative luminance, 0 (black) to 1 (white). Throws on anything not a six-digit hex color — the
 *  one shape `Theme` promises every color already is. */
export function relativeLuminance(hex: HexColor): number {
  if (!HEX_COLOR.test(hex)) throw new RangeError(`${hex} is not a six-digit hex color`);
  return 0.2126 * srgbChannel(hex, 1) + 0.7152 * srgbChannel(hex, 3) + 0.0722 * srgbChannel(hex, 5);
}

/** WCAG's contrast ratio: the lighter of the two relative luminances over the darker, both raised by 0.05
 *  — symmetric in its two arguments, and always between 1 (identical) and 21 (black on white). */
export function contrastRatio(a: HexColor, b: HexColor): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 2.2 AA's two thresholds: normal text (1.4.3), and the large-text-or-UI-component case `accent` is
 *  checked under (1.4.11). */
export const WCAG_AA_NORMAL_TEXT = 4.5;
export const WCAG_AA_LARGE_TEXT = 3;

/** Whether a theme's normal-text pair and its accent both clear WCAG 2.2 AA — the one gate every shipped
 *  theme in `DEFAULT_THEMES` below is proven against in this module's own test. */
export function meetsThemeContrast(theme: Theme): boolean {
  return (
    contrastRatio(theme.foreground, theme.background) >= WCAG_AA_NORMAL_TEXT &&
    contrastRatio(theme.accent, theme.background) >= WCAG_AA_LARGE_TEXT
  );
}

/**
 * The theme each surface ships under until an operator changes it. Backgrounds are deliberately dark
 * across all four surfaces — Operator included, since it too is read in a dim room rather than daylight —
 * every pair here is proven against `meetsThemeContrast` in this module's own test, not asserted on faith.
 */
export const DEFAULT_THEMES: Readonly<Record<ThemeSurface, Theme>> = Object.freeze({
  audience: { id: 'audience-default', background: '#0B0E14', foreground: '#F5F7FA', accent: '#7DD3FC' },
  stage: { id: 'stage-default', background: '#101010', foreground: '#FFFFFF', accent: '#FACC15' },
  singer: { id: 'singer-default', background: '#111827', foreground: '#F9FAFB', accent: '#34D399' },
  operator: { id: 'operator-default', background: '#0F172A', foreground: '#E2E8F0', accent: '#3B82F6' },
});
