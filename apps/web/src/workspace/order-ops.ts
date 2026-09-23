// Pure order planning: turns a drag, a Move Up/Down/To action, or a section edit into the exact
// requests the server accepts. The reorder route is within one section only — `withReorderedItems`
// (`apps/app/src/services.ts`) refuses unless `itemIds` names exactly that section's current items,
// once each — so a move that stays in its own section is one `reorder` step.
//
// A move across sections cannot be a separate add-then-remove: the server's `addItem` never checks
// whether the id already exists elsewhere (`withAddedItem`, `apps/app/src/services.ts`), so the
// moment between those two requests would have the item named in two sections at once — a service
// no client can even read back, since `readServiceView` enforces one id per service, the same
// constraint `parseServiceDraft` enforces server-side. Instead a cross-section move is a single
// `move` step: the whole `sections` tree, already showing the item gone from its old section and
// present in its new one, sent to the server's `edit` operation (`PATCH /api/v1/services/:id`, the
// same one `OrderPanel.tsx`'s `patchSections` uses for rename/add/remove-section) in one request. No
// state in between is ever computed, sent or parsed, so no response is ever invalid.

import { itemsOf, type ServiceView } from './service-data.js';

/** Moves `itemId` to index `to` within `ids`, clamped to the list's bounds. Absent ids are untouched. */
export function moveWithin(ids: readonly string[], itemId: string, to: number): string[] {
  const from = ids.indexOf(itemId);
  if (from === -1) return [...ids];
  const rest = ids.filter((id) => id !== itemId);
  const at = Math.max(0, Math.min(to, rest.length));
  return [...rest.slice(0, at), itemId, ...rest.slice(at)];
}

export type Neighbours = { readonly sectionId: string; readonly index: number; readonly up?: number; readonly down?: number };

/** Where `itemId` sits, and the indexes Move Up/Move Down would target within its own section. */
export function neighbours(view: ServiceView, itemId: string): Neighbours {
  const located = itemsOf(view).find(({ item }) => item.id === itemId);
  if (located === undefined) throw new Error(`${itemId} does not name an item in this service`);
  const section = view.sections.find((candidate) => candidate.id === located.sectionId);
  const total = section?.items.length ?? 0;
  return {
    sectionId: located.sectionId,
    index: located.index,
    ...(located.index > 0 ? { up: located.index - 1 } : {}),
    ...(located.index < total - 1 ? { down: located.index + 1 } : {}),
  };
}

export type OrderStep =
  | { readonly kind: 'reorder'; readonly sectionId: string; readonly itemIds: readonly string[] }
  | { readonly kind: 'move'; readonly itemId: string; readonly sectionId: string; readonly index: number };

/**
 * The complete post-move `sections` for moving `itemId` into another section at `target.index`, or
 * `undefined` when either no longer exists. Computed from whichever view the caller passes — the one the
 * write is actually sent against — so the item bodies it carries are never older than the service's own.
 */
export function movedSections(
  view: ServiceView, itemId: string, target: { sectionId: string; index: number },
): ServiceView['sections'] | undefined {
  const located = itemsOf(view).find(({ item }) => item.id === itemId);
  const targetSection = view.sections.find((candidate) => candidate.id === target.sectionId);
  if (located === undefined || targetSection === undefined) return undefined;
  const withoutIt = view.sections.map((section) =>
    section.id === located.sectionId ? { ...section, items: section.items.filter((item) => item.id !== itemId) } : section,
  );
  const remaining = withoutIt.find((section) => section.id === target.sectionId)?.items ?? [];
  const at = Math.max(0, Math.min(target.index, remaining.length));
  return withoutIt.map((section) =>
    section.id === target.sectionId
      ? { ...section, items: [...section.items.slice(0, at), located.item, ...section.items.slice(at)] }
      : section,
  );
}

/**
 * The one step that moves `itemId` to `target`: a same-section `reorder`, or — when it crosses into
 * another section — a `move`, whose complete post-move `sections` (`movedSections`) is computed only when
 * it is sent, so no intermediate, cross-section-duplicate state is ever sent or read back. Returns `[]`
 * for an unknown item or target section rather than throwing — the caller decides whether that is reachable.
 */
export function reorderPlan(view: ServiceView, itemId: string, target: { sectionId: string; index: number }): OrderStep[] {
  const located = itemsOf(view).find(({ item }) => item.id === itemId);
  const targetSection = view.sections.find((candidate) => candidate.id === target.sectionId);
  if (located === undefined || targetSection === undefined) return [];

  if (located.sectionId === target.sectionId) {
    const ids = moveWithin(targetSection.items.map((item) => item.id), itemId, target.index);
    return [{ kind: 'reorder', sectionId: target.sectionId, itemIds: ids }];
  }
  return [{ kind: 'move', itemId, sectionId: target.sectionId, index: target.index }];
}

/** A copy of the service's sections with one section's name changed. */
export function renameSection(view: ServiceView, sectionId: string, title: string): ServiceView['sections'] {
  return view.sections.map((section) => (section.id === sectionId ? { ...section, name: title } : section));
}

/** A copy of the service's sections with a fresh, empty section appended. */
export function addSection(view: ServiceView, title: string, id: string): ServiceView['sections'] {
  return [...view.sections, { id, name: title, items: [] }];
}

/** A copy of the service's sections with an empty section removed, or `'not-empty'` when it still holds items. */
export function removeSection(view: ServiceView, sectionId: string): ServiceView['sections'] | 'not-empty' {
  const section = view.sections.find((candidate) => candidate.id === sectionId);
  if (section === undefined) return view.sections;
  if (section.items.length > 0) return 'not-empty';
  return view.sections.filter((candidate) => candidate.id !== sectionId);
}
