// Runs one bulk action across every selected item, one request at a time: never in parallel, so two
// items that touch the same section (a reorder, say) never race each other's answer. Each item's outcome
// is folded in as soon as it answers, and `onProgress` is told immediately — a caller renders "n of total
// done" live rather than only once the whole run has finished.

import { refusalText } from '../refusal-text.js';
import type { ApiResult } from '../api.js';

export type BulkOutcome = {
  readonly done: number;
  readonly total: number;
  readonly refused: readonly { readonly itemId: string; readonly title: string; readonly reason: string }[];
};

/** Runs `step` for each id sequentially (never in parallel), reporting progress after each. */
export async function runBulk(
  ids: readonly string[],
  step: (itemId: string) => Promise<ApiResult<unknown>>,
  titleOf: (itemId: string) => string,
  onProgress: (outcome: BulkOutcome) => void,
): Promise<BulkOutcome> {
  const total = ids.length;
  let done = 0;
  const refused: { itemId: string; title: string; reason: string }[] = [];

  for (const itemId of ids) {
    const result = await step(itemId);
    if (result.ok) {
      done += 1;
    } else {
      refused.push({ itemId, title: titleOf(itemId), reason: refusalText(result) });
    }
    onProgress({ done, total, refused: [...refused] });
  }

  return { done, total, refused };
}
