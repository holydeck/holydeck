// Executes an `order-ops.ts` plan against the server, one step at a time. `OrderItem` and `MoveToDialog`
// both need this, so it lives here rather than in either of them — importing across the two would cycle,
// since `OrderItem` renders `MoveToDialog` for its own Move To… action.

import { API } from '../api-routes.js';
import { mutate, pending } from '../state/workspace-store.js';
import { movedSections, type OrderStep } from './order-ops.js';

/**
 * Runs `steps` in order, keeping `itemId` marked pending for the whole sequence rather than flickering
 * between steps, and stopping at the first refusal. A `move` step sends the whole draft — the same
 * `PATCH /api/v1/services/:id` shape `OrderPanel.tsx`'s `patchSections` uses — because `parseServiceDraft`
 * requires `title`/`date`/`site` even when only `sections` changed. That draft is built by `bodyFor` only
 * once the write leaves the store's queue, so an item body saved just before it is carried, not reverted.
 */
export async function runOrderSteps(serviceId: string, itemId: string, steps: readonly OrderStep[]): Promise<boolean> {
  pending.value = new Set(pending.value).add(itemId);
  try {
    for (const step of steps) {
      if (step.kind === 'reorder') {
        const result = await mutate(API.sectionReorder(serviceId, step.sectionId), { method: 'POST', body: { itemIds: step.itemIds } });
        if (!result.ok) return false;
        continue;
      }
      const result = await mutate(API.service(serviceId), {
        method: 'PATCH',
        bodyFor: (current) => ({
          title: current.title, date: current.date, site: current.site,
          sections: movedSections(current, step.itemId, step) ?? current.sections,
        }),
      });
      if (!result.ok) return false;
    }
    return true;
  } finally {
    const next = new Set(pending.value);
    next.delete(itemId);
    pending.value = next;
  }
}
