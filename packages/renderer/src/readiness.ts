// What the renderer found wrong with a slide, in the vocabulary readiness is graded in. REND-01 draws the
// line twice: nonessential decoration outside the safe area warns, important text or required content
// outside it blocks; and text that cannot be shown at the effective minimum readable size blocks rather
// than being rendered smaller. Both halves of that live here, so a surface asking "may this go live"
// reads one list rather than inferring it from geometry a second time.
//
// A finding is data, never an exception. Text that will not fit still renders — at the floor, whole, with
// nothing hidden — because an editor has to see the problem to fix it.

export type ReadinessSeverity = 'blocker' | 'warning';

export const READINESS_CODES = [
  /** The layout asks for text below the effective floor; the floor wins and readiness blocks. */
  'text.belowMinimumReadableSize',
  /** The text still overflows its box at the effective floor, and is not split or truncated to fit. */
  'text.overflowsAtMinimumReadableSize',
  /** Required content sits outside the resolved safe area. */
  'content.outsideSafeArea',
  /** Nonessential decoration sits outside the resolved safe area. */
  'decoration.outsideSafeArea',
  /** The authored layout's ratio is not the resolved output ratio, so the frame is letterboxed. */
  'layout.ratioMismatch',
  /** A media box asks to play louder than the resolved bound; the bound was used instead. */
  'media.volumeAboveBound',
] as const;

export type ReadinessCode = (typeof READINESS_CODES)[number];

/** A slide-level finding names no box; `boxId` is then absent rather than empty. */
export interface FindingSite {
  readonly slideId: string;
  readonly boxId?: string;
}

export interface ReadinessFinding extends FindingSite {
  readonly code: ReadinessCode;
  readonly severity: ReadinessSeverity;
  readonly detail: string;
}

export type Readiness = 'ready' | 'warned' | 'blocked';

export const finding = (
  code: ReadinessCode,
  severity: ReadinessSeverity,
  site: FindingSite,
  detail: string,
): ReadinessFinding =>
  Object.freeze(
    site.boxId === undefined
      ? { code, severity, slideId: site.slideId, detail }
      : { code, severity, slideId: site.slideId, boxId: site.boxId, detail },
  );

export const blocker = (code: ReadinessCode, site: FindingSite, detail: string): ReadinessFinding =>
  finding(code, 'blocker', site, detail);

export const warning = (code: ReadinessCode, site: FindingSite, detail: string): ReadinessFinding =>
  finding(code, 'warning', site, detail);

export function readinessOf(findings: readonly ReadinessFinding[]): Readiness {
  if (findings.some((entry) => entry.severity === 'blocker')) return 'blocked';
  return findings.length === 0 ? 'ready' : 'warned';
}
