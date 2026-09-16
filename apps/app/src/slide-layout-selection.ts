// Applying one text-style edit across several boxes at once (TMPL-05), and reading whether they already
// agree on it. T39 gave every box its own typed style; this file is the first thing that touches more than
// one of them in a single edit, and it stays a computation rather than a second editing path: it takes a
// `SlideLayoutBody` and a selection and hands back another `SlideLayoutBody`, for a caller to save forward
// through the same `PUT .../boxes` route (`slide-layout-routes.ts`) a caller already uses to save one box.
//
// A selection is never a thing this product remembers. It is the caller's plain list of box ids for the
// length of one call — nothing about it reaches `SlideLayoutBody` or `LayoutBox` — and T38's revision rules
// see only the body this file computed, content-hashed against the standing revision exactly as any other
// save is. One call here is at most one save there, whether it touches one box or a dozen.
//
// Only the six `TextBoxStyle` fields are shared-editable this way. A box's frame and its binding stay a
// one-box-at-a-time decision: sharing either across a selection would mean duplicating a content key onto
// every box or clearing it, and both are worse than refusing outright, so a patch that reaches for either is
// refused by name rather than quietly reinterpreted. A Media box carries no `TextBoxStyle` at all, so a
// selection that includes one leaves it untouched and out of the count of what the edit reached.
//
// What a selection disagrees about is read, never guessed: an omitted patch field leaves every box's own
// value exactly where it was, and `textStyleAgreement` is the other half of that — it says, per field,
// whether the selection already agrees and on what, for a control that does not exist yet to show as mixed
// rather than silently pick one box's answer for all of them.
//
// Named gaps, predicted rather than discovered:
//   - Undo: no undo stack exists anywhere in this codebase yet, so only the at-most-one-revision half of
//     "one application produces one undo step" is provable here.
//   - Keyboard operability (spec 11.2): no `apps/web` editor exists yet to make keyboard-operable. What is
//     provable instead, and what every function below is built to keep true, is that selecting, reading
//     agreement, and applying a patch are plain synchronous functions over plain data, with no coordinate or
//     pointer anywhere in their signatures — nothing here blocks a future keyboard-only control from calling
//     them.
//   - A per-box minimum-readable-size override: `TextBoxStyle` has no such field yet, only the renderer's
//     internal render model does, and no test bullet here asks for one. Only the administrative floor
//     (`administrativeDefaults.minimumReadableHeightRatio`) is checked.

import { administrativeDefaults } from '@holydeck/renderer/output-profile';

import type { LayoutBox, SlideLayoutBody, TextBoxStyle, TextLayoutBox } from '@holydeck/contracts/layouts';

/** Which boxes an edit reaches, for the length of one call. Never part of a `SlideLayoutBody`. */
export type BoxSelection = readonly string[];

/** The only fields a shared edit may touch. Geometry and bindings stay a one-box-at-a-time decision. */
export const EDITABLE_TEXT_STYLE_FIELDS: readonly string[] = [
  'fontFamily',
  'fontWeight',
  'sizeRatio',
  'lineHeight',
  'align',
  'verticalAlign',
];

export type SelectionRefusalKind = 'not-editable' | 'below-minimum-size';

/** Carries why a shared edit was refused, matching `SlideLayoutError`'s `kind` pattern in `slide-layouts.ts`. */
export class SelectionError extends Error {
  readonly kind: SelectionRefusalKind;
  /** The boxes the refusal names. Empty when the refusal is about the patch rather than any one box. */
  readonly boxIds: readonly string[];

  constructor(kind: SelectionRefusalKind, message: string, boxIds: readonly string[] = []) {
    super(message);
    this.name = 'SelectionError';
    this.kind = kind;
    this.boxIds = boxIds;
  }
}

/** Deduplicated and frozen, so nothing downstream mistakes it for something a box could be pushed onto. */
export function selectBoxes(ids: readonly string[]): BoxSelection {
  return Object.freeze([...new Set(ids)]);
}

const isSelectedText =
  (chosen: ReadonlySet<string>) =>
  (box: LayoutBox): box is TextLayoutBox =>
    box.kind === 'text' && chosen.has(box.id);

/** Every field left exactly where a patch did not reach it: never a spread of a `Partial`, so nothing here can widen a required field to allow `undefined`. */
const mergeStyle = (style: TextBoxStyle, patch: Partial<TextBoxStyle>): TextBoxStyle => ({
  fontFamily: patch.fontFamily ?? style.fontFamily,
  fontWeight: patch.fontWeight ?? style.fontWeight,
  sizeRatio: patch.sizeRatio ?? style.sizeRatio,
  lineHeight: patch.lineHeight ?? style.lineHeight,
  align: patch.align ?? style.align,
  verticalAlign: patch.verticalAlign ?? style.verticalAlign,
});

export interface SharedStyleApplication {
  readonly body: SlideLayoutBody;
  /** The Text boxes the patch actually reached. A Media box in the selection is never named here. */
  readonly affected: readonly string[];
}

/**
 * One `SlideLayoutBody` with the patch merged onto every selected Text box's style, or a refusal naming why
 * none of them were touched. A selection of one box merges onto that one box and nothing else, which is the
 * whole of "behaves exactly as a single box does today" — there is no second code path for it.
 */
export function applySharedTextStyle(
  body: SlideLayoutBody,
  selection: BoxSelection,
  patch: Partial<TextBoxStyle>,
): SharedStyleApplication {
  const stray = Object.keys(patch).find((field) => !EDITABLE_TEXT_STYLE_FIELDS.includes(field));
  if (stray !== undefined) {
    throw new SelectionError(
      'not-editable',
      `${stray} is not shared-editable across a selection; geometry and bindings are set one box at a time`,
    );
  }

  const chosen = new Set(selection);
  const isSelected = isSelectedText(chosen);
  const merged = body.boxes.map((box) => (isSelected(box) ? { ...box, style: mergeStyle(box.style, patch) } : box));

  const floor = administrativeDefaults.minimumReadableHeightRatio;
  const offending = merged.filter(isSelected).filter((box) => box.style.sizeRatio < floor);
  if (offending.length > 0) {
    const boxIds = offending.map((box) => box.id);
    throw new SelectionError(
      'below-minimum-size',
      `${boxIds.join(', ')} would read smaller than the administrative minimum of ${floor}`,
      boxIds,
    );
  }

  return { body: { boxes: merged }, affected: merged.filter(isSelected).map((box) => box.id) };
}

export type FieldAgreement<T> = { readonly agrees: true; readonly value: T } | { readonly agrees: false };

/** Whether the selected Text boxes already agree on each style field, for a control this task does not build. */
export type TextStyleAgreement = { readonly [K in keyof TextBoxStyle]: FieldAgreement<TextBoxStyle[K]> };

/** Reads what a selection disagrees about without changing anything. `undefined` when it holds no Text box. */
export function textStyleAgreement(body: SlideLayoutBody, selection: BoxSelection): TextStyleAgreement | undefined {
  const chosen = new Set(selection);
  const boxes = body.boxes.filter(isSelectedText(chosen));
  if (boxes.length === 0) return undefined;

  const agreementOf = <K extends keyof TextBoxStyle>(field: K): FieldAgreement<TextBoxStyle[K]> => {
    const [first, ...rest] = boxes.map((box) => box.style[field]);
    if (first === undefined) return { agrees: false };
    return rest.every((value) => value === first) ? { agrees: true, value: first } : { agrees: false };
  };

  return {
    fontFamily: agreementOf('fontFamily'),
    fontWeight: agreementOf('fontWeight'),
    sizeRatio: agreementOf('sizeRatio'),
    lineHeight: agreementOf('lineHeight'),
    align: agreementOf('align'),
    verticalAlign: agreementOf('verticalAlign'),
  };
}
