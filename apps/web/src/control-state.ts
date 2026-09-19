// The operator control surface's own state, kept free of the DOM so every rule below is provable
// without a browser. `control.ts` reads this module for what to render and never recomputes either
// question itself.
//
// LIVE-07 names two of this file's rules directly: "current and next previews" (resolved by
// `previewPositions`, including the item-boundary cases a live operator actually hits — the first item
// has no previous next, the last item has no next at all) and the T52 shortcut catalogue, reused rather
// than re-derived (`slide-labels.ts:43`'s `SHORTCUT_KEYS`/`shortcutsOf` are the one place a shortcut key
// is bound to a label; this file only resolves a bound label to a position in the surface's own order).

import { SHORTCUT_KEYS, type ShortcutKey, type SlideLabelEntry, shortcutsOf } from '@holydeck/contracts/slide-labels';

/** One entry the Order panel shows and the Editor/Preview and Properties panels read from, by
 *  position. `label` is the same free-text field `slide-groups.ts`'s `Slide.label` carries — matched
 *  against the shortcut catalogue exactly as `readAssignedLabel` matches it there. */
export interface OrderItem {
  readonly id: string;
  readonly label: string;
}

/** The two positions the Editor/Preview region shows. Either can be absent: an empty order has neither,
 *  and the last item has no next — there is no wraparound, because a live operator at the last item is
 *  a real state to show honestly, not one to paper over with the first item again. */
export interface PreviewPositions {
  readonly current: number | undefined;
  readonly next: number | undefined;
}

/**
 * Resolves what "current" and "next" mean at any position, including both boundaries: an out-of-range
 * index (negative, or past the end) is clamped to the nearest real item rather than producing a preview
 * of nothing when one exists.
 */
export function previewPositions(length: number, index: number): PreviewPositions {
  if (length <= 0) return { current: undefined, next: undefined };
  const current = Math.min(Math.max(index, 0), length - 1);
  return { current, next: current + 1 < length ? current + 1 : undefined };
}

/** True for exactly the ten keys `SHORTCUT_KEYS` names — nothing here re-declares that set. */
export function isShortcutKey(key: string): key is ShortcutKey {
  return (SHORTCUT_KEYS as readonly string[]).includes(key);
}

/**
 * Which position in `items` a shortcut key jumps to, or `undefined` when the key is not bound in the
 * live catalogue, or is bound to a label no item in this order currently carries. Reuses
 * `shortcutsOf` — the same lookup the accessible shortcut reference is built from — so the surface
 * never disagrees with the catalogue about what a key means.
 */
export function indexForShortcut(
  items: readonly OrderItem[],
  catalogue: readonly SlideLabelEntry[],
  key: ShortcutKey,
): number | undefined {
  const bound = shortcutsOf(catalogue).get(key);
  if (bound === undefined) return undefined;
  const index = items.findIndex((item) => item.label === bound.name);
  return index === -1 ? undefined : index;
}
