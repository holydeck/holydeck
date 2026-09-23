// Executes an `order-ops.ts` plan against the server, one step at a time. `OrderItem` and `MoveToDialog`
// both need this, so it lives here rather than in either of them — importing across the two would cycle,
// since `OrderItem` renders `MoveToDialog` for its own Move To… action.

import { API } from '../api-routes.js';
import { mutate, pending } from '../state/workspace-store.js';
import type { OrderStep } from './order-ops.js';

/**
 * Runs `steps` in order, keeping `itemId` marked pending for the whole sequence rather than flickering
 * between steps, and stopping at the first refusal — a cross-section move never drops the item partway.
 */
export async function runOrderSteps(serviceId: string, itemId: string, steps: readonly OrderStep[]): Promise<boolean> {
  pending.value = new Set(pending.value).add(itemId);
  try {
    for (const step of steps) {
      const result = step.kind === 'reorder'
        ? await mutate(API.sectionReorder(serviceId, step.sectionId), { method: 'POST', body: { itemIds: step.itemIds } })
        : step.kind === 'add'
          ? await mutate(API.sectionItems(serviceId, step.sectionId), { method: 'POST', body: step.item })
          : await mutate(API.item(serviceId, step.itemId), { method: 'DELETE' });
      if (!result.ok) return false;
    }
    return true;
  } finally {
    const next = new Set(pending.value);
    next.delete(itemId);
    pending.value = next;
  }
}
