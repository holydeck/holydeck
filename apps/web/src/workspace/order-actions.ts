// Executes an `order-ops.ts` plan against the server, one step at a time. `OrderItem` and `MoveToDialog`
// both need this, so it lives here rather than in either of them — importing across the two would cycle,
// since `OrderItem` renders `MoveToDialog` for its own Move To… action.

import { API } from '../api-routes.js';
import type { JSX } from 'preact';

import { isReadOnly, mutate, pending, service } from '../state/workspace-store.js';
import { movedSections, reorderPlan, type OrderStep } from './order-ops.js';

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

/** The drag data type a row's handle carries: the item id, and nothing a drop elsewhere could misread. */
export const DRAG_TYPE = 'text/plain';

type DragHandlers = {
  readonly onDragOver: (event: JSX.TargetedDragEvent<HTMLElement>) => void;
  readonly onDrop: (event: JSX.TargetedDragEvent<HTMLElement>) => void;
};

/**
 * Makes an element a drop target that moves the dragged item to `target` — a row (its own place) or a
 * section (its end). A drop runs exactly the `reorderPlan` a keyboard or Move To… move to that place
 * would, through `runOrderSteps`, so pointer and keyboard can never produce different requests.
 */
export function dropTarget(target: { sectionId: string; index: number }): DragHandlers {
  return {
    onDragOver: (event) => {
      if (isReadOnly.value) return;
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
    },
    onDrop: (event) => {
      event.preventDefault();
      event.stopPropagation();
      const itemId = event.dataTransfer?.getData(DRAG_TYPE) ?? '';
      const view = service.value;
      if (isReadOnly.value || itemId === '' || view === undefined) return;
      const steps = reorderPlan(view, itemId, target);
      if (steps.length > 0) void runOrderSteps(view.id, itemId, steps);
    },
  };
}
