// The server answers a stamped `ServiceRecord`, not the plain `Service` the contracts package validates;
// this seam reshapes one into the other so the rest of the workspace only ever holds a service it trusts.

import { parseService, type Service, type ServiceItem, type ServiceOutput } from '@holydeck/contracts/services';

export type ServiceView = Service & { revision: string; output?: ServiceOutput };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function readServiceView(data: unknown): ServiceView | undefined {
  if (!isRecord(data)) return undefined;
  const { stamp, ...rest } = data;
  if (!isRecord(stamp) || typeof stamp.id !== 'string' || typeof stamp.updatedAt !== 'string') return undefined;
  const parsed = parseService({ ...rest, id: stamp.id });
  return parsed.ok ? { ...parsed.value, revision: stamp.updatedAt } : undefined;
}

export function readServiceList(data: unknown): ServiceView[] | undefined {
  return Array.isArray(data) ? data.map(readServiceView).filter((view): view is ServiceView => view !== undefined) : undefined;
}

export function itemsOf(view: ServiceView): { sectionId: string; item: ServiceItem; index: number }[] {
  return view.sections.flatMap((section) => section.items.map((item, index) => ({ sectionId: section.id, item, index })));
}

export function findItem(view: ServiceView, itemId: string): ServiceItem | undefined {
  return itemsOf(view).find(({ item }) => item.id === itemId)?.item;
}
