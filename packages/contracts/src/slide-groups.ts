// What a slide group or a reusable slide holds (spec SLID-01), saved as a content revision body
// through the already-generic `revisionsOn()` store. Neither entity stamp — `reusableSlide` nor
// `slideGroup` — is minted here: `@holydeck/contracts/library` already names both kinds, and
// `apps/app/src/library.ts` already mints the `contentId` a body here is saved against. This file
// owns only the shape of that body.
//
// A `Slide`'s `label` stays exactly what it was before this file's SLID-02 and LANG-01 additions:
// a single, deliberately minimal free-text field, admin-facing only. A song's or a sermon's
// labelled lyric section (spec §12.4's "ordered labelled lyric sections") is a different, richer
// concept `label` is not reused for — that shape belongs to SONG-01/T51, which builds the real
// Song schema this file's generic `Slide` only has to be generic enough to sit underneath.
//
// SLID-02 (this file, as of T48): a slide inherits its group's own `background` and `slideLayoutId`
// by default, and may override either independently. Inheritance is resolved on every read by
// `resolveSlide`, never copied onto a `Slide` at creation or edit time — a group's own default can
// move and every non-overriding slide's effective value moves with it, and clearing an override
// costs nothing, because the group's own value was never touched to set one. `slideLayoutId` names
// a Slide Layout the way `slide-layout-propagation.ts`'s `'unpreparedRendering'` consumer already
// does elsewhere in this codebase: floating to whatever is current, never pinned to a revision —
// pinning belongs to prepared-snapshot machinery (ADR 0006), not to this editing-time layer. This
// file does not verify a `slideLayoutId` names a real, existing Slide Layout, the same posture
// `services.ts`'s `RevisionRef.id` already takes toward reusable content it references.
//
// LANG-01 (this file, as of T49): a `Slide` carries its own ordered `languageBlocks`, each one
// keyed to `./content-languages.js`'s registry and validated against nothing richer — no label
// (verse/chorus/bridge), no repeat count, no import provenance. Those are §12.3/§12.4's
// PowerPoint-import and canonical-song dimensions, both SONG-01/T51's to add once a real Song
// schema exists; this file's `Slide` stays the same generic shape SLID-02 already left it as, one
// field deeper. A block's order is the array's own order, nothing else — no separate index field
// is minted, matching how `SlideGroupBody` never numbered its own `slides` either — because
// `canonical.ts` never sorts a list (ADR 0001) and every current or future reader of this body
// sees the blocks in the order this array holds them. No render surface reads a `Slide` yet
// (`packages/renderer` has no bridge from this body to a `RenderModelInput`, for any of its
// fields, SLID-02's included) — the renderer's own already-shipped contract is that paint order
// is declaration order, so a future task that builds that bridge inherits this array's order as
// its only source, the same way it will inherit `resolveSlide`'s resolved background and Slide
// Layout.
//
// LIVE-20 (this file, as of T114): a group carries at most one backing audio track, named the same
// way `background` already names a library item — a bare id, never a copy of its bytes, so the
// reference is meant to protect the asset from cleanup once a scanner walks group fields the way
// it already should for `background` — that scanner does not exist yet for either field. Unlike
// `background`, there is no per-slide override: the track belongs to the group as a whole
// (`@holydeck/contracts/live-media`'s `slideGroupAudioAction` is what decides whether moving
// between slides changes anything about it), so it is declared once here and not on `Slide`.

import { isContentLanguageKey } from './content-languages.js';
import { FIELD_CODES, type FieldReader, isRecord, type ParseFn, parseObject } from './problems.js';

/** One block of ordered, language-specific content on a slide (LANG-01): its own text, in one
 *  language of the content-language registry. */
export interface LanguageBlock {
  readonly id: string;
  readonly languageKey: string;
  readonly text: string;
}

/** A single slide: shown or not, the placeholder content field described above, an optional,
 *  independent override of either of its group's inherited defaults (SLID-02), and its own
 *  ordered language blocks (LANG-01). Absent override fields mean "inherit"; present means
 *  "override with this value" — there is no separate flag to disagree with the value. */
export interface Slide {
  readonly id: string;
  readonly enabled: boolean;
  readonly label: string;
  readonly slideLayoutId?: string;
  readonly background?: string;
  readonly languageBlocks: readonly LanguageBlock[];
}

/** Whether a group's slides were authored by hand or projected from pinned inputs. */
export const SLIDE_GROUP_MODES = ['custom', 'generated'] as const;

export type SlideGroupMode = (typeof SLIDE_GROUP_MODES)[number];

/**
 * What a slide group — or a reusable slide's one-`Slide` group — holds. `enabled` is the group's own
 * show/hide flag, alongside each slide's own. `slideLayoutId` and `background` are the defaults every
 * slide inherits unless it overrides one (SLID-02, resolved by `resolveSlide`, not copied here).
 */
export interface SlideGroupBody {
  readonly mode: SlideGroupMode;
  readonly enabled: boolean;
  readonly slideLayoutId: string;
  readonly background?: string;
  /** The group's own backing audio track (LIVE-20): a media library item's id, never its bytes,
   *  following exactly the convention `background` above already set. Absent is the ordinary case
   *  — a group with nothing to play, which behaves exactly as one always has. */
  readonly audioTrackId?: string;
  /**
   * Present only when `mode === 'generated'`. Opaque here — the shape a concrete generator (T51
   * songs, later sermon/general projections) pins is that generator's to define; this file only
   * carries it forward unread.
   */
  readonly generatedFrom?: Readonly<Record<string, unknown>>;
  readonly slides: readonly Slide[];
}

/**
 * A language block's own key, graded against the registry the same way `layouts.ts`'s
 * `boundKey` is graded against `CONTENT_KEYS`. Unlike `KeyedBinding.languageKey` (still opaque
 * there — see that file's own header for why), this file has a real, if minimal, registry to
 * check against as of T49, so it does.
 */
const boundLanguageKey = (reader: FieldReader): string => {
  const before = reader.problems.length;
  const key = reader.text('languageKey');
  if (reader.problems.length > before) return key;
  if (!isContentLanguageKey(key)) {
    reader.reject('languageKey', FIELD_CODES.notAllowed, 'must name a language in the content-language registry');
  }
  return key;
};

export const parseLanguageBlock: ParseFn<LanguageBlock> = (value, path) =>
  parseObject(value, path, (reader) => ({
    id: reader.text('id'),
    languageKey: boundLanguageKey(reader),
    text: reader.text('text'),
  }));

export const parseSlide: ParseFn<Slide> = (value, path) =>
  parseObject(value, path, (reader) => {
    const id = reader.text('id');
    const enabled = reader.flag('enabled');
    const label = reader.text('label');
    const slideLayoutId = reader.optionalText('slideLayoutId');
    // An override that is present must actually override something — the same emptiness rule
    // `SlideGroupBody.slideLayoutId` (the required, group-level field) already enforces via
    // `reader.text`. `optionalText` has no such check on its own, because "absent" already
    // means "inherit" here; this only closes the gap for a present-but-empty value.
    if (slideLayoutId === '') reader.reject('slideLayoutId', FIELD_CODES.empty, 'must not be empty');
    const background = reader.optionalText('background');
    if (background === '') reader.reject('background', FIELD_CODES.empty, 'must not be empty');
    const languageBlocks = reader.parsedList('languageBlocks', parseLanguageBlock);
    return {
      id,
      enabled,
      label,
      ...(slideLayoutId === undefined ? {} : { slideLayoutId }),
      ...(background === undefined ? {} : { background }),
      languageBlocks,
    };
  });

/** Opaque and unvalidated beyond "is an object": this file only carries it forward, never reads it. */
const parseOpaqueRecord: ParseFn<Readonly<Record<string, unknown>>> = (value, path) =>
  isRecord(value)
    ? { ok: true, value }
    : { ok: false, problems: [{ path, code: FIELD_CODES.notAnObject, message: 'must be an object' }] };

export const parseSlideGroupBody: ParseFn<SlideGroupBody> = (value, path) =>
  parseObject(value, path, (reader) => {
    const mode = reader.choice('mode', SLIDE_GROUP_MODES);
    const enabled = reader.flag('enabled');
    const slideLayoutId = reader.text('slideLayoutId');
    const background = reader.optionalText('background');
    const audioTrackId = reader.optionalText('audioTrackId');
    const slides = reader.parsedList('slides', parseSlide);
    const generatedFrom = reader.optionalParsed('generatedFrom', parseOpaqueRecord);
    return {
      mode,
      enabled,
      slideLayoutId,
      ...(background === undefined ? {} : { background }),
      ...(audioTrackId === undefined ? {} : { audioTrackId }),
      slides,
      ...(generatedFrom === undefined ? {} : { generatedFrom }),
    };
  });

/** Whether an effective value came from the group's own default or a slide's explicit override. */
export type InheritanceSource = 'inherited' | 'override';

/** One resolved field, and which of the two it came from. */
export interface Resolved<T> {
  readonly value: T;
  readonly source: InheritanceSource;
}

/** A slide's effective background and Slide Layout (SLID-02). */
export interface ResolvedSlide {
  readonly slideLayoutId: Resolved<string>;
  readonly background: Resolved<string | undefined>;
}

/**
 * Resolves what a slide actually shows for its Slide Layout and background: its own override if
 * it has one, otherwise its group's current default. Computed fresh from the two bodies handed
 * in — never read off a value stored on the slide itself, so a group's default moving moves every
 * non-overriding slide's effective value with it (test bullet 1), and an override is always
 * visibly tagged, never a bare value indistinguishable from an inherited one (test bullet 2).
 */
export function resolveSlide(group: SlideGroupBody, slide: Slide): ResolvedSlide {
  return {
    slideLayoutId:
      slide.slideLayoutId === undefined
        ? { value: group.slideLayoutId, source: 'inherited' }
        : { value: slide.slideLayoutId, source: 'override' },
    background:
      slide.background === undefined
        ? { value: group.background, source: 'inherited' }
        : { value: slide.background, source: 'override' },
  };
}
