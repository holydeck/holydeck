// What a slide group or a reusable slide holds (spec SLID-01), saved as a content revision body
// through the already-generic `revisionsOn()` store. Neither entity stamp — `reusableSlide` nor
// `slideGroup` — is minted here: `@holydeck/contracts/library` already names both kinds, and
// `apps/app/src/library.ts` already mints the `contentId` a body here is saved against. This file
// owns only the shape of that body.
//
// A `Slide`'s content field is deliberately minimal: `label`, free text, and nothing else. LANG-01
// (ordered multilingual language blocks per slide) still reshapes a Slide once it lands; this
// task's own lifecycle tests only need some field `edit` can change, and naming it durably ahead
// of that requirement would be a guess this file does not make.
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

import { FIELD_CODES, isRecord, type ParseFn, parseObject } from './problems.js';

/** A single slide: shown or not, the placeholder content field described above, and an optional,
 *  independent override of either of its group's inherited defaults (SLID-02). Absent means
 *  "inherit"; present means "override with this value" — there is no separate flag to disagree
 *  with the value. */
export interface Slide {
  readonly id: string;
  readonly enabled: boolean;
  readonly label: string;
  readonly slideLayoutId?: string;
  readonly background?: string;
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
  /**
   * Present only when `mode === 'generated'`. Opaque here — the shape a concrete generator (T51
   * songs, later sermon/general projections) pins is that generator's to define; this file only
   * carries it forward unread.
   */
  readonly generatedFrom?: Readonly<Record<string, unknown>>;
  readonly slides: readonly Slide[];
}

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
    return {
      id,
      enabled,
      label,
      ...(slideLayoutId === undefined ? {} : { slideLayoutId }),
      ...(background === undefined ? {} : { background }),
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
    const slides = reader.parsedList('slides', parseSlide);
    const generatedFrom = reader.optionalParsed('generatedFrom', parseOpaqueRecord);
    return {
      mode,
      enabled,
      slideLayoutId,
      ...(background === undefined ? {} : { background }),
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
