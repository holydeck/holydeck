// T70: the explicit-review gate PPTX-02 asks for, sitting between T69's raw extraction and T71's
// song commit. Nothing upstream of this module ever assigns a structural label to an extracted text
// block, so every `PptxImportSlide.textBlocks` entry is ambiguous and needs one reviewed decision
// before the import as a whole is ready to commit — there is no basis yet to exempt any block.
//
// The gate itself persists nothing: it is not a new durable entity, only a pure function graded
// against the live T52 catalogue (`slide-labels.ts`), plus a thin wrapper that fetches that catalogue.
// A caller that wants partial progress kept across round trips, or that turns a reviewed import into a
// song, is a later task's job — this module only answers "is this import ready," and if it is not,
// exactly which blocks are why.

import { readAssignedLabel } from '@holydeck/contracts/slide-labels';

import { slideLabelsOn } from './slide-labels.js';

import type { SlideLabelEntry } from '@holydeck/contracts/slide-labels';
import type { RequestContext } from './context.js';
import type { RepositoryDb } from './repositories.js';

/** One `PptxImportSlide.textBlocks` entry, named by where it sits rather than by its text. */
export interface PptxReviewBlock {
  readonly slideIndex: number;
  readonly blockIndex: number;
}

/** What a reviewer decided for one block: the label they chose, not yet graded against the catalogue. */
export interface PptxReviewDecision extends PptxReviewBlock {
  readonly label: unknown;
}

export type PptxReviewProblemKind = 'unreviewed' | 'unknown-label';

/** One block the import cannot yet commit for, named exactly rather than folded into a bare count. */
export interface PptxReviewProblem extends PptxReviewBlock {
  readonly kind: PptxReviewProblemKind;
  readonly message: string;
}

/** A decision that cleared the gate: the catalogue entry it named, and when and by whom that was graded. */
export interface PptxReviewedBlock extends PptxReviewBlock {
  readonly label: SlideLabelEntry;
  readonly at: string;
  readonly by: string;
}

export type PptxReviewGrade =
  | { readonly ok: true; readonly reviewed: readonly PptxReviewedBlock[] }
  | { readonly ok: false; readonly problems: readonly PptxReviewProblem[] };

/** The moment a decision becomes graded, and who it is graded on behalf of — never persisted here. */
export interface PptxReviewStamp {
  readonly at: string;
  readonly by: string;
}

const key = (block: PptxReviewBlock): string => `${block.slideIndex}:${block.blockIndex}`;

/**
 * The pure gate: every block of every slide needs a decision naming a label the live catalogue still
 * offers, or the import as a whole is not reviewed. Every block is graded, not just the first bad one,
 * so a caller sees the whole outstanding list at once — the same "report every problem, not the first"
 * rule `problems.ts` states for a single payload, applied here across a whole import. A decision naming
 * a block no slide has is not an error of its own; it simply never matches a block being graded.
 */
export function gradePptxReview(
  slides: readonly (readonly string[])[],
  decisions: readonly PptxReviewDecision[],
  live: readonly SlideLabelEntry[],
  stamp: PptxReviewStamp,
): PptxReviewGrade {
  const decided = new Map<string, PptxReviewDecision>();
  for (const decision of decisions) decided.set(key(decision), decision);

  const problems: PptxReviewProblem[] = [];
  const reviewed: PptxReviewedBlock[] = [];

  slides.forEach((textBlocks, slideIndex) => {
    textBlocks.forEach((_, blockIndex) => {
      const block = { slideIndex, blockIndex };
      const decision = decided.get(key(block));
      if (decision === undefined) {
        problems.push({ ...block, kind: 'unreviewed', message: 'this block has no reviewed decision' });
        return;
      }
      const parsed = readAssignedLabel(live, decision.label);
      if (!parsed.ok) {
        problems.push({
          ...block,
          kind: 'unknown-label',
          message: 'this decision does not name a label of the global slide-label catalogue',
        });
        return;
      }
      reviewed.push({ ...block, label: parsed.value, at: stamp.at, by: stamp.by });
    });
  });

  return problems.length === 0 ? { ok: true, reviewed } : { ok: false, problems };
}

export type PptxReviewRefusal = PptxReviewProblemKind;

/**
 * Refused because the import cannot commit yet, said the way this domain's other stores say it: a
 * closed `kind`, and the exact blocks the refusal is about carried on the error rather than folded into
 * its message. `kind` is `'unreviewed'` whenever at least one block is missing a decision at all — the
 * blocking condition PPTX-02 names first — and `'unknown-label'` only when every block has a decision
 * but at least one of them names something outside the catalogue; `problems` always carries every block
 * of both kinds the grade found, not only the one the top-level `kind` is named after.
 */
export class PptxReviewError extends Error {
  readonly kind: PptxReviewRefusal;

  readonly problems: readonly PptxReviewProblem[];

  constructor(kind: PptxReviewRefusal, message: string, problems: readonly PptxReviewProblem[]) {
    super(message);
    this.name = 'PptxReviewError';
    this.kind = kind;
    this.problems = problems;
  }
}

export interface PptxReviewOptions {
  /** Injected, so the instant every decision is graded at comes from one clock and a test does not wait. */
  readonly now: () => string;
}

export interface PptxReview {
  /**
   * Grades a caller-supplied decision per block against the live T52 catalogue, and either returns
   * every block reviewed and stamped, or refuses naming exactly which blocks are still unreviewed
   * and/or which decisions named a label the catalogue does not currently offer.
   */
  review(
    context: unknown,
    slides: readonly (readonly string[])[],
    decisions: readonly PptxReviewDecision[],
  ): Promise<readonly PptxReviewedBlock[]>;
}

const describe = (problems: readonly PptxReviewProblem[]): string =>
  problems.map((problem) => `slide ${problem.slideIndex} block ${problem.blockIndex} ${problem.message}`).join('; ');

/**
 * The thin, db-facing half of the gate: it fetches the live catalogue through the established T52
 * store and hands it to the pure grade above, touching nothing else. `slideLabelsOn` is reused rather
 * than re-derived, so this module never grows its own copy of catalogue-membership-checking logic.
 */
export function pptxReviewOn(db: RepositoryDb, options: PptxReviewOptions): PptxReview {
  const labels = slideLabelsOn(db, { now: options.now });

  return {
    review: async (context, slides, decisions) => {
      const live = await labels.catalogue(context);
      const { actor } = context as RequestContext;
      const grade = gradePptxReview(slides, decisions, live, { at: options.now(), by: actor });
      if (!grade.ok) {
        const kind: PptxReviewRefusal = grade.problems.some((problem) => problem.kind === 'unreviewed')
          ? 'unreviewed'
          : 'unknown-label';
        throw new PptxReviewError(kind, `this import cannot commit yet: ${describe(grade.problems)}`, grade.problems);
      }
      return grade.reviewed;
    },
  };
}
