// The command palette's own shape (spec SRCH-01): one ranked result aggregating six stores this
// product already has — canon-validated references and Bible text (both against the corpus), songs,
// two distinct slide sources (reusable/library slides and admin-managed Slide Layouts), and services.
//
// Deliberately not a reuse of `CorpusSearchHit`/`CorpusSearch` (`./corpus.js`): those are
// Bible-verse-specific — one translation, one book/chapter/verse. A palette hit is tagged by which of
// the six stores it came from, carries whatever locator that store's own id space uses, and always
// explains why it matched — the palette is a search surface first, an aggregation of unrelated shapes
// second.

/** The fixed, deliberate order a tie between sources breaks in (ruling 4): named once here so ranking
 *  reads off one list rather than scattered comparisons, and reused as the source tag's own vocabulary. */
export const PALETTE_SOURCES = ['reference', 'scripture', 'song', 'slide', 'slideLayout', 'service'] as const;

export type PaletteSource = (typeof PALETTE_SOURCES)[number];

export interface PaletteHitBase {
  readonly source: PaletteSource;
  readonly id: string;
  /** What a result list shows. */
  readonly title: string;
  /** Why this hit matched — e.g. "matched the phrase in the romanized title". */
  readonly explanation: string;
  /** Whether the query's words were found together, in order, rather than scattered. */
  readonly phrase: boolean;
  readonly occurrences: number;
}

/** A canon-validated Scripture reference the query itself named (e.g. "John 3:16"), resolved against
 *  one deployment-chosen translation — not a text search, a direct reference lookup. */
export interface ReferencePaletteHit extends PaletteHitBase {
  readonly source: 'reference';
  readonly abbr: string;
  readonly book: string;
  readonly chapter: number;
  readonly verses: readonly number[];
  readonly text: string;
}

/** A word or phrase match against Bible text already cached locally, across every held translation. */
export interface ScripturePaletteHit extends PaletteHitBase {
  readonly source: 'scripture';
  readonly abbr: string;
  readonly book: string;
  readonly chapter: number;
  readonly verses: readonly number[];
  readonly text: string;
}

export interface SongPaletteHit extends PaletteHitBase {
  readonly source: 'song';
  readonly songId: string;
}

/** A reusable slide or a named slide group, discoverable through the content library — open to
 *  everyone, unlike `SlideLayoutPaletteHit` below. */
export interface SlidePaletteHit extends PaletteHitBase {
  readonly source: 'slide';
  readonly contentId: string;
  readonly kind: 'reusableSlide' | 'slideGroup';
}

/** An Admin-managed Slide Layout — the palette's one gated source (`layouts.manage`). */
export interface SlideLayoutPaletteHit extends PaletteHitBase {
  readonly source: 'slideLayout';
  readonly layoutId: string;
}

export interface ServicePaletteHit extends PaletteHitBase {
  readonly source: 'service';
  readonly serviceId: string;
  readonly date: string;
  readonly site: string;
}

export type PaletteHit =
  | ReferencePaletteHit
  | ScripturePaletteHit
  | SongPaletteHit
  | SlidePaletteHit
  | SlideLayoutPaletteHit
  | ServicePaletteHit;
