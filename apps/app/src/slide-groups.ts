// Slides and named slide groups (spec SLID-01): the first place `./library.js` and `./revisions.js`
// are composed by a third store rather than by each other. `library.js` mints the `contentId` a
// `slideGroup` or `reusableSlide` item is discoverable under and says nothing about what it holds;
// `revisions.js` says what it holds, over time, and knows nothing about discoverability. This store
// owns neither: it calls `library.create`/`library.get` for the stamp half and `revisions.save`/
// `revisions.current`/`revisions.history` for the body half, and adds no record, collection, or
// migration of its own.
//
// The two halves are written stamp-first here, the reverse of `slide-layouts.ts`'s own boxes-first
// order — and for a structural reason, not a style choice. `slide-layouts.ts` mints its own id before
// either write, so it can choose which write goes first. `library.create` mints the `contentId`
// *inside* its own closure and hands it back only in the stamp it returns, so there is no id to save a
// body under until after `library.create` has already run. A crash between the two calls therefore
// leaves a discoverable stamp with no body yet — a gap `library.ts`'s own header comment already
// anticipates, not one this file can close by reordering. Any read that composes both halves treats a
// stamp whose body is missing as corrupt data, never as "not found": a stamp is only ever written after
// `library.create` succeeds, so one with no matching revision is a state nothing in this product writes
// on purpose.
//
// Generated-vs-custom is carried on the body as `SlideGroupBody.mode`, not on `RevisionOrigin` — the
// two answer different questions, the same split ADR 0001 already draws between how a save was
// captured and why the content exists. Every save this store makes passes `origin: 'manual-checkpoint'`,
// matching `slide-layouts.ts`'s own two call sites. `regenerate` refuses a `'custom'` group so
// authored content is never silently replaced by a projection; `edit` refuses a `'generated'` group,
// symmetric with that, so a hand edit is never silently discarded by the next regeneration. Determinism
// is `revisions.save()`'s own behaviour, free: identical bodies address identically, so a regenerate
// with unchanged inputs appends nothing.
//
// No audit action is added or called here, matching `library.ts` and `slide-layouts.ts`: `'content.
// change'` is the single action every content surface joins, and it is recorded at the routes layer
// (`slide-layout-routes.ts`), not the store layer. No routes exist for slide groups yet, so nothing
// here calls it.

import { randomBytes } from 'node:crypto';

import { parseSlideGroupBody } from '@holydeck/contracts/slide-groups';

import { conflictShelfOn, SHELF_PERMISSIONS } from './conflicts.js';
import { requestContext } from './context.js';
import { LibraryError, LIBRARY_PERMISSIONS, libraryOn } from './library.js';
import { RevisionError, REVISION_PERMISSIONS, revisionsOn } from './revisions.js';
import { saveContent } from './save-content.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { LibraryKind } from '@holydeck/contracts/library';
import type { RevisionBody, RevisionRecord } from '@holydeck/contracts/revisions';
import type { LanguageBlock, Slide, SlideGroupBody } from '@holydeck/contracts/slide-groups';

import type { RequestContext } from './context.js';
import type { RepositoryDb } from './repositories.js';
import type { RevisionRefusal } from './revisions.js';

export type SlideGroupRefusal = 'schema' | 'state' | 'conflict' | 'corrupt';

/** Carries why the call was refused, so a caller can tell a bad payload from a race it lost fairly. */
export class SlideGroupError extends Error {
  readonly kind: SlideGroupRefusal;

  constructor(kind: SlideGroupRefusal, message: string) {
    super(message);
    this.name = 'SlideGroupError';
    this.kind = kind;
  }
}

/** The one context a slide group or a reusable slide is administered under: the two stores it spans. */
export function slideGroupContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [...Object.values(LIBRARY_PERMISSIONS), ...Object.values(REVISION_PERMISSIONS), ...Object.values(SHELF_PERMISSIONS)],
    correlationId,
  });
}

export const subjectFor = (id: string): string => `slideGroup:${id}`;

export interface SlideGroupRecord {
  readonly stamp: EntityStamp;
  readonly title: string;
  /** For a `reusableSlide` item, `.slides` holds exactly one `Slide`. */
  readonly body: SlideGroupBody;
}

/** What `regenerate` hands back: the usual record, plus which of the *previous* slides carried a
 *  live override at the moment the wholesale replace dropped it. Visibility only — it does not
 *  change which overrides get cleared, or when; `regenerate` still replaces `slides` unconditionally. */
export interface RegeneratedSlideGroupRecord extends SlideGroupRecord {
  readonly clearedOverrideSlideIds: readonly string[];
}

export interface SlideGroupStore {
  create(
    context: unknown,
    kind: 'slideGroup' | 'reusableSlide',
    title: string,
    body: SlideGroupBody,
  ): Promise<SlideGroupRecord>;
  current(context: unknown, id: string): Promise<SlideGroupRecord | undefined>;
  /** Replaces the body forward. Refuses on a generated group — edited only by regenerating it. */
  edit(context: unknown, id: string, body: SlideGroupBody): Promise<SlideGroupRecord | undefined>;
  /** Fresh id via library.create, current body copied, mode forced to 'custom'. */
  duplicate(context: unknown, id: string): Promise<SlideGroupRecord | undefined>;
  enable(context: unknown, id: string): Promise<SlideGroupRecord | undefined>;
  disable(context: unknown, id: string): Promise<SlideGroupRecord | undefined>;
  enableSlide(context: unknown, id: string, slideId: string): Promise<SlideGroupRecord | undefined>;
  disableSlide(context: unknown, id: string, slideId: string): Promise<SlideGroupRecord | undefined>;
  duplicateSlide(context: unknown, id: string, slideId: string): Promise<SlideGroupRecord | undefined>;
  /** Sets this slide's own Slide Layout, overriding its group's default (SLID-02). */
  overrideSlideLayout(
    context: unknown,
    id: string,
    slideId: string,
    slideLayoutId: string,
  ): Promise<SlideGroupRecord | undefined>;
  /** Removes this slide's Slide Layout override, restoring inheritance from its group. */
  clearSlideLayoutOverride(context: unknown, id: string, slideId: string): Promise<SlideGroupRecord | undefined>;
  /** Sets this slide's own background, overriding its group's default (SLID-02). */
  overrideSlideBackground(
    context: unknown,
    id: string,
    slideId: string,
    background: string,
  ): Promise<SlideGroupRecord | undefined>;
  /** Removes this slide's background override, restoring inheritance from its group. */
  clearSlideBackgroundOverride(context: unknown, id: string, slideId: string): Promise<SlideGroupRecord | undefined>;
  /** slideIds must name exactly the group's current slides, once each — mirrors services.ts's reorderItems. */
  reorderSlides(context: unknown, id: string, slideIds: readonly string[]): Promise<SlideGroupRecord | undefined>;
  /** Adds a copy of this language block, inserted right after it, on the same slide (LANG-01). */
  duplicateLanguageBlock(
    context: unknown,
    id: string,
    slideId: string,
    blockId: string,
  ): Promise<SlideGroupRecord | undefined>;
  /** blockIds must name exactly this slide's current language blocks, once each — mirrors reorderSlides. */
  reorderLanguageBlocks(
    context: unknown,
    id: string,
    slideId: string,
    blockIds: readonly string[],
  ): Promise<SlideGroupRecord | undefined>;
  /** Refuses on a custom group. */
  regenerate(context: unknown, id: string, body: SlideGroupBody): Promise<RegeneratedSlideGroupRecord | undefined>;
  history(context: unknown, id: string): Promise<readonly SlideGroupRecord[]>;
}

export interface SlideGroupOptions {
  /** Injected, so every instant one store writes comes from one clock and a test does not wait. */
  readonly now: () => string;
  readonly newId?: () => string;
}

const SLIDE_ID_BYTES = 16;

const readable = (problem: { readonly path: string; readonly message: string }): string =>
  `${problem.path} ${problem.message}`;

const problems = (list: readonly { readonly path: string; readonly message: string }[]): string =>
  list.map(readable).join('; ');

// A revision refusal said again in this store's vocabulary. `missing` is the only one that changes
// name: this store never calls `revisions.restore`, so it never arises in practice, but the mapping is
// kept exhaustive for the same reason `slide-layouts.ts` keeps its own.
const REVISION_REFUSALS: Readonly<Record<RevisionRefusal, SlideGroupRefusal>> = {
  schema: 'schema',
  missing: 'state',
  conflict: 'conflict',
  corrupt: 'corrupt',
};

/**
 * Every refusal the two composed stores raise, said in this store's own words — so a caller never has
 * to know which of them answered. A context or permission refusal from the records layer underneath
 * either one is passed through untouched: it is already the clearest statement of what went wrong.
 */
function refusalFor(error: unknown): unknown {
  if (error instanceof LibraryError) return new SlideGroupError(error.kind, error.message);
  if (error instanceof RevisionError) return new SlideGroupError(REVISION_REFUSALS[error.kind], error.message);
  return error;
}

const own = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw refusalFor(error);
  }
};

/** The body a caller handed in, graded before it is stored. */
function readBody(value: SlideGroupBody): SlideGroupBody {
  const parsed = parseSlideGroupBody(value, 'group');
  if (!parsed.ok) {
    throw new SlideGroupError('schema', `this is not a slide group body: ${problems(parsed.problems)}`);
  }
  return parsed.value;
}

/** The body a stored revision holds, graded on the way out for the reason the revision store grades. */
function bodyOf(record: RevisionRecord): SlideGroupBody {
  const parsed = parseSlideGroupBody(record.body, 'group');
  if (!parsed.ok) {
    throw new SlideGroupError(
      'corrupt',
      `revision ${record.revision} of ${record.contentId} holds a slide group body this code cannot read: ${problems(parsed.problems)}`,
    );
  }
  return parsed.value;
}

const locateSlide = (slides: readonly Slide[], slideId: string): number => {
  const index = slides.findIndex((slide) => slide.id === slideId);
  if (index === -1) throw new SlideGroupError('schema', `${slideId} does not name a slide in this group`);
  return index;
};

const withChangedSlide = (
  slides: readonly Slide[],
  slideId: string,
  change: (slide: Slide) => Slide,
): readonly Slide[] => {
  const index = locateSlide(slides, slideId);
  return slides.map((slide, i) => (i === index ? change(slide) : slide));
};

const withoutSlideLayoutOverride = (slides: readonly Slide[], slideId: string): readonly Slide[] =>
  withChangedSlide(slides, slideId, (slide) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose, via rest
    const { slideLayoutId, ...rest } = slide;
    return rest;
  });

const withoutBackgroundOverride = (slides: readonly Slide[], slideId: string): readonly Slide[] =>
  withChangedSlide(slides, slideId, (slide) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped on purpose, via rest
    const { background, ...rest } = slide;
    return rest;
  });

const withDuplicatedSlide = (slides: readonly Slide[], slideId: string, freshId: string): readonly Slide[] => {
  const index = locateSlide(slides, slideId);
  const next = [...slides];
  next.splice(index + 1, 0, { ...next[index]!, id: freshId });
  return next;
};

const withReorderedSlides = (slides: readonly Slide[], slideIds: readonly string[]): readonly Slide[] => {
  const byId = new Map(slides.map((slide) => [slide.id, slide] as const));
  const matches =
    slideIds.length === slides.length &&
    new Set(slideIds).size === slideIds.length &&
    slideIds.every((id) => byId.has(id));
  if (!matches) throw new SlideGroupError('schema', "reorder must name exactly this group's current slides, once each");
  return slideIds.map((id) => byId.get(id)!);
};

const locateLanguageBlock = (blocks: readonly LanguageBlock[], blockId: string): number => {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index === -1) throw new SlideGroupError('schema', `${blockId} does not name a language block on this slide`);
  return index;
};

const withDuplicatedLanguageBlock = (
  blocks: readonly LanguageBlock[],
  blockId: string,
  freshId: string,
): readonly LanguageBlock[] => {
  const index = locateLanguageBlock(blocks, blockId);
  const next = [...blocks];
  next.splice(index + 1, 0, { ...next[index]!, id: freshId });
  return next;
};

const withReorderedLanguageBlocks = (
  blocks: readonly LanguageBlock[],
  blockIds: readonly string[],
): readonly LanguageBlock[] => {
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const matches =
    blockIds.length === blocks.length &&
    new Set(blockIds).size === blockIds.length &&
    blockIds.every((id) => byId.has(id));
  if (!matches) {
    throw new SlideGroupError('schema', "reorder must name exactly this slide's current language blocks, once each");
  }
  return blockIds.map((id) => byId.get(id)!);
};

export function slideGroupsOn(db: RepositoryDb, options: SlideGroupOptions): SlideGroupStore {
  const newId = options.newId ?? ((): string => randomBytes(SLIDE_ID_BYTES).toString('base64url'));
  const library = libraryOn(db, { now: options.now, newId });
  const revisions = revisionsOn(db, { now: options.now });
  const conflictShelf = conflictShelfOn(db, { now: options.now });

  /** The standing stamp and body of one item — a body-carrying `library.create`/`revisions.save` pair
   *  read back together. A stamp with no body is corrupt, never "not found": ruling 4's whole point. */
  const standing = async (context: unknown, id: string): Promise<SlideGroupRecord | undefined> => {
    const libRecord = await library.get(context, id);
    if (libRecord === undefined) return undefined;
    const revision = await revisions.current(context, id);
    if (revision === undefined) {
      throw new SlideGroupError('corrupt', `${id} is stamped as a slide group and holds no body at all`);
    }
    return { stamp: libRecord.stamp, title: libRecord.title, body: bodyOf(revision) };
  };

  const save = async (
    context: unknown,
    row: Pick<SlideGroupRecord, 'stamp' | 'title'>,
    id: string,
    body: SlideGroupBody,
  ): Promise<SlideGroupRecord> => {
    // SlideGroupBody is an interface, not a type alias (unlike `SlideLayoutBody`), so TypeScript does
    // not consider it structurally assignable to RevisionBody's index signature on its own; the value
    // itself is untouched by the cast.
    await saveContent(revisions, conflictShelf)(context, { contentId: id, body: body as unknown as RevisionBody, origin: 'manual-checkpoint' });
    return { stamp: row.stamp, title: row.title, body };
  };

  return {
    create: (context, kind, title, body) =>
      own(async () => {
        const readValue = readBody(body);
        // Stamp first: `library.create` mints the id internally and hands it back only in the stamp,
        // so there is no id to save a body under until after this call succeeds.
        const record = await library.create(context, { kind, title });
        return save(context, record, record.stamp.id, readValue);
      }),

    current: (context, id) => own(() => standing(context, id)),

    edit: (context, id, body) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        if (row.body.mode === 'generated') {
          throw new SlideGroupError('state', `${id} is a generated group and is only changed by regenerating it`);
        }
        return save(context, row, id, readBody(body));
      }),

    duplicate: (context, id) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        // Breaks the link to whatever pinned inputs a generated source was projected from: nothing
        // downstream could reproduce it, so a duplicate is always a starting point for customizing.
        // The group's own inheritance defaults (slideLayoutId, background, audioTrackId) are not
        // provenance — they carry forward exactly like `enabled` and `slides` do.
        const body: SlideGroupBody = {
          mode: 'custom',
          enabled: row.body.enabled,
          slideLayoutId: row.body.slideLayoutId,
          slides: row.body.slides,
          ...(row.body.background === undefined ? {} : { background: row.body.background }),
          ...(row.body.audioTrackId === undefined ? {} : { audioTrackId: row.body.audioTrackId }),
        };
        const record = await library.create(context, { kind: row.stamp.kind as LibraryKind, title: row.title });
        return save(context, record, record.stamp.id, body);
      }),

    enable: (context, id) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        return save(context, row, id, { ...row.body, enabled: true });
      }),

    disable: (context, id) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        return save(context, row, id, { ...row.body, enabled: false });
      }),

    enableSlide: (context, id, slideId) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const slides = withChangedSlide(row.body.slides, slideId, (slide) => ({ ...slide, enabled: true }));
        return save(context, row, id, { ...row.body, slides });
      }),

    disableSlide: (context, id, slideId) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const slides = withChangedSlide(row.body.slides, slideId, (slide) => ({ ...slide, enabled: false }));
        return save(context, row, id, { ...row.body, slides });
      }),

    duplicateSlide: (context, id, slideId) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const slides = withDuplicatedSlide(row.body.slides, slideId, newId());
        return save(context, row, id, { ...row.body, slides });
      }),

    overrideSlideLayout: (context, id, slideId, slideLayoutId) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const slides = withChangedSlide(row.body.slides, slideId, (slide) => ({ ...slide, slideLayoutId }));
        return save(context, row, id, readBody({ ...row.body, slides }));
      }),

    clearSlideLayoutOverride: (context, id, slideId) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const slides = withoutSlideLayoutOverride(row.body.slides, slideId);
        return save(context, row, id, { ...row.body, slides });
      }),

    overrideSlideBackground: (context, id, slideId, background) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const slides = withChangedSlide(row.body.slides, slideId, (slide) => ({ ...slide, background }));
        return save(context, row, id, readBody({ ...row.body, slides }));
      }),

    clearSlideBackgroundOverride: (context, id, slideId) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const slides = withoutBackgroundOverride(row.body.slides, slideId);
        return save(context, row, id, { ...row.body, slides });
      }),

    reorderSlides: (context, id, slideIds) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const slides = withReorderedSlides(row.body.slides, slideIds);
        return save(context, row, id, { ...row.body, slides });
      }),

    duplicateLanguageBlock: (context, id, slideId, blockId) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const slides = withChangedSlide(row.body.slides, slideId, (slide) => ({
          ...slide,
          languageBlocks: withDuplicatedLanguageBlock(slide.languageBlocks, blockId, newId()),
        }));
        return save(context, row, id, { ...row.body, slides });
      }),

    reorderLanguageBlocks: (context, id, slideId, blockIds) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        const slides = withChangedSlide(row.body.slides, slideId, (slide) => ({
          ...slide,
          languageBlocks: withReorderedLanguageBlocks(slide.languageBlocks, blockIds),
        }));
        return save(context, row, id, { ...row.body, slides });
      }),

    regenerate: (context, id, body) =>
      own(async () => {
        const row = await standing(context, id);
        if (row === undefined) return undefined;
        if (row.body.mode === 'custom') {
          throw new SlideGroupError('state', `${id} is a custom group and is never overwritten by regeneration`);
        }
        // The wholesale replace below is unchanged; this only names, from the slides about to be
        // discarded, which ones held a live override — so the caller learns what was dropped.
        const clearedOverrideSlideIds = row.body.slides
          .filter((slide) => slide.slideLayoutId !== undefined || slide.background !== undefined)
          .map((slide) => slide.id);
        const record = await save(context, row, id, readBody(body));
        return { ...record, clearedOverrideSlideIds };
      }),

    history: (context, id) =>
      own(async () => {
        const libRecord = await library.get(context, id);
        if (libRecord === undefined) return [];
        const found = await revisions.history(context, id);
        return found.map((revision) => ({ stamp: libRecord.stamp, title: libRecord.title, body: bodyOf(revision) }));
      }),
  };
}
