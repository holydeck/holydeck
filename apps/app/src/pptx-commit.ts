// T71: turning T69's raw per-slide text blocks and T70's reviewed labels into an actual `SongBody`
// (spec PPTX-03) and committing it through the existing `./songs.js` `SongStore` — either as a brand
// new song, or spliced onto an existing one. Neither T69's `PptxImportSlide` nor T70's
// `PptxReviewedBlock` carries enough on its own: the import has the text but no label, the review has
// the label but not the text it was graded against. This module is the first thing that needs both
// at once, so it takes them as two parallel inputs rather than inventing a third shape that repeats
// either one.
//
// No new persistence: no `EntityKind`, no collection, no migration, no permission. "Create" is
// `songsOn(...).create`; "append" is `songsOn(...).current` followed by `songsOn(...).edit` with new
// sections spliced onto the end — the same two verbs the visual editor already uses, composed rather
// than duplicated. `songContext` from `./songs.js` already unions every permission either verb needs,
// so this module mints no context of its own.
//
// `assemblePptxSections` below is the pure half: no store, no clock beyond the caller-supplied
// `importId`, just slides and reviewed decisions in, a language list and a section list out. `append`
// hands it the target song's own languages and sections as a starting point; `create` hands it nothing
// to start from. Either way what comes back is already the song's whole new `languages`/`sections`,
// ready to hand straight to `songsOn`.

import { detectRepeatMarker, splitScriptRuns } from '@holydeck/core/pptx-content';

import { SongError, songsOn } from './songs.js';

import type { LyricSection, SectionText, SongBody, SongTitles } from '@holydeck/contracts/songs';

import type { PptxReviewedBlock } from './pptx-review.js';
import type { RepositoryDb } from './repositories.js';
import type { SongRecord } from './songs.js';

/** Tamil script first, matching `TITLE_LANGUAGE_KEYS`'s own convention — the fixed order a language is
 *  ever added to `languages` in, never the order it is merely preserved in from an append target. */
const LANGUAGE_ORDER = ['ta', 'ta-Latn'] as const;

/** What an append starts assembling from: the target song's own languages and sections, exactly as
 *  they stand, so a marker block can fold onto the target's own last existing section (ruling 3) and
 *  a new language is only ever added after the target's own (ruling 4). A create starts from neither. */
export interface PptxCommitExisting {
  readonly languages: readonly string[];
  readonly sections: readonly LyricSection[];
}

const NOTHING_EXISTING: PptxCommitExisting = { languages: [], sections: [] };

export interface PptxCommitAssembly {
  readonly languages: readonly string[];
  readonly sections: readonly LyricSection[];
}

const byPosition = (a: PptxReviewedBlock, b: PptxReviewedBlock): number =>
  a.slideIndex - b.slideIndex || a.blockIndex - b.blockIndex;

/**
 * One reviewed block becomes one `LyricSection`, in `(slideIndex, blockIndex)` order — except a block
 * whose raw text `detectRepeatMarker` reads as a repeat marker, which produces no section of its own
 * and instead overwrites the `repeat` of the section immediately before it (last-one-wins, mirroring
 * T70's own duplicate-decision precedent). A marker with nothing before it — the first block of a
 * `create`, or an append whose target has no sections yet — falls back to an ordinary section, the same
 * fallback `detectRepeatMarker` itself uses for an under-threshold count.
 *
 * `languages` is the union of `existing.languages`, preserved verbatim and in order, with every language
 * this call's own text actually used — in `LANGUAGE_ORDER` — appended after, skipping any already there.
 */
export function assemblePptxSections(
  slides: readonly (readonly string[])[],
  reviewed: readonly PptxReviewedBlock[],
  importId: string,
  existing: PptxCommitExisting = NOTHING_EXISTING,
): PptxCommitAssembly {
  const sections: LyricSection[] = [...existing.sections];
  const produced = new Set<string>();

  for (const block of [...reviewed].sort(byPosition)) {
    const raw = slides[block.slideIndex]?.[block.blockIndex] ?? '';
    const marker = detectRepeatMarker(raw);
    if (marker !== undefined && sections.length > 0) {
      const preceding = sections[sections.length - 1]!;
      sections[sections.length - 1] = { ...preceding, repeat: { count: marker.count } };
      continue;
    }

    const runs = splitScriptRuns(raw);
    const text: SectionText[] = runs.map((run) => ({ languageKey: run.languageKey, text: run.text }));
    for (const run of runs) produced.add(run.languageKey);
    sections.push({ id: `${importId}-${block.slideIndex}-${block.blockIndex}`, label: block.label.name, text });
  }

  const added = LANGUAGE_ORDER.filter((key) => produced.has(key) && !existing.languages.includes(key));
  return { languages: [...existing.languages, ...added], sections };
}

/** Which song a commit writes onto: a brand new one titled by the caller, or an existing one by id —
 *  explicit and typed, never inferred from which optional field happens to be present. */
export type PptxCommitTarget =
  | {
      readonly mode: 'create';
      readonly title: SongTitles;
      /** What was imported — a file name, an identifier in another system. Opaque here, on purpose,
       *  the same way `SongProvenance.reference` already is; omitted entirely when the caller has none. */
      readonly reference?: string;
    }
  | { readonly mode: 'append'; readonly id: string };

export interface PptxCommitOptions {
  /** Injected, so the instant a create's `provenance.importedAt` comes from comes from one clock. */
  readonly now: () => string;
  /** Mints one fresh id per commit call, used only to keep this call's section ids collision-free
   *  against any existing song's own — a different id space from `SongOptions.newId`, never that one. */
  readonly newId: () => string;
}

export interface PptxCommit {
  /**
   * Assembles the reviewed blocks into sections and commits them: a new song when `target.mode` is
   * `'create'`, spliced onto the end of an existing one when it is `'append'`. An append that names a
   * song `songsOn(...).current` cannot find is refused with `SongError('state', …)` rather than quietly
   * creating one — the two modes never fall back onto each other.
   */
  commit(
    context: unknown,
    target: PptxCommitTarget,
    slides: readonly (readonly string[])[],
    reviewed: readonly PptxReviewedBlock[],
  ): Promise<SongRecord>;
}

export function pptxCommitOn(db: RepositoryDb, options: PptxCommitOptions): PptxCommit {
  const songs = songsOn(db, { now: options.now });

  return {
    commit: async (context, target, slides, reviewed) => {
      const importId = options.newId();

      if (target.mode === 'create') {
        const assembly = assemblePptxSections(slides, reviewed, importId);
        const body: SongBody = {
          titles: target.title,
          languages: assembly.languages,
          sections: assembly.sections,
          provenance: {
            source: 'import',
            importer: 'powerpoint',
            importedAt: options.now(),
            importId,
            ...(target.reference === undefined ? {} : { reference: target.reference }),
          },
        };
        // The romanized title is what a person searches and announces a song by (`SongTitles`'s own
        // doc comment), so it is what this song is listed under — the display title has no source of
        // its own here, deriving a real one from slide content being explicitly out of scope (ruling 7).
        return songs.create(context, target.title.romanized, body);
      }

      const current = await songs.current(context, target.id);
      if (current === undefined) {
        throw new SongError('state', `${target.id} is not a song this import can append to`);
      }
      const assembly = assemblePptxSections(slides, reviewed, importId, {
        languages: current.body.languages,
        sections: current.body.sections,
      });
      // Provenance is untouched: an append does not retroactively rewrite how the song as a whole
      // originated (ruling 6). Only `languages` and `sections` move.
      const updated: SongBody = { ...current.body, languages: assembly.languages, sections: assembly.sections };
      const saved = await songs.edit(context, target.id, updated);
      if (saved === undefined) {
        // The song stood a moment ago and is gone now — a race this caller lost, not a bad target.
        throw new SongError('state', `${target.id} is not a song this import can append to`);
      }
      return saved;
    },
  };
}
