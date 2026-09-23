// Pure order planning: turns a drag, a Move Up/Down/To action, or a section edit into the exact
// requests the server accepts. The reorder route is within one section only — `withReorderedItems`
// (`apps/app/src/services.ts`) refuses unless `itemIds` names exactly that section's current items,
// once each — so a cross-section move must add to the target, reorder it in, then remove from the
// source, in that order, so a refusal part-way through never loses the item.

import type { ServiceItem } from '@holydeck/contracts/services';

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
  | { readonly kind: 'add'; readonly sectionId: string; readonly item: ServiceItem }
  | { readonly kind: 'remove'; readonly itemId: string };

/**
 * The ordered steps that move `itemId` to `target`: one `reorder` when it stays in its own section,
 * or an add/reorder/remove sequence when it crosses into another. Returns `[]` for an unknown item
 * or target section rather than throwing — the caller decides whether that is reachable.
 */
export function reorderPlan(view: ServiceView, itemId: string, target: { sectionId: string; index: number }): OrderStep[] {
  const located = itemsOf(view).find(({ item }) => item.id === itemId);
  const targetSection = view.sections.find((candidate) => candidate.id === target.sectionId);
  if (located === undefined || targetSection === undefined) return [];

  if (located.sectionId === target.sectionId) {
    const ids = moveWithin(targetSection.items.map((item) => item.id), itemId, target.index);
    return [{ kind: 'reorder', sectionId: target.sectionId, itemIds: ids }];
  }

  const ids = targetSection.items.map((item) => item.id);
  const at = Math.max(0, Math.min(target.index, ids.length));
  return [
    { kind: 'add', sectionId: target.sectionId, item: located.item },
    { kind: 'reorder', sectionId: target.sectionId, itemIds: [...ids.slice(0, at), itemId, ...ids.slice(at)] },
    { kind: 'remove', itemId },
  ];
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
