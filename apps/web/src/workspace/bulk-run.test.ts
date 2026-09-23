import { describe, expect, it, vi } from 'vitest';

import type { ApiResult } from '../api.js';
import { runBulk, type BulkOutcome } from './bulk-run.js';

const answered = (data: unknown = {}): ApiResult<unknown> => ({ ok: true, data, requestId: 'r', version: 1, dropped: undefined });
const refusedResult = (code: string): ApiResult<unknown> => ({ ok: false, code, message: 'Refused', requestId: 'r', fields: [] });

describe('runBulk', () => {
  it('runs sequentially and reports refused items by title', async () => {
    const order: string[] = [];
    const step = vi.fn(async (id: string) => {
      order.push(`start ${id}`);
      await Promise.resolve();
      order.push(`end ${id}`);
      return id === 'b' ? refusedResult('entity.state_conflict') : answered({});
    });
    const progress: BulkOutcome[] = [];
    const outcome = await runBulk(['a', 'b', 'c'], step, (id) => id.toUpperCase(), (o) => progress.push(o));

    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(outcome).toMatchObject({ done: 2, total: 3, refused: [{ itemId: 'b', title: 'B' }] });
    expect(progress.map((o) => o.done)).toEqual([1, 1, 2]);
  });

  it('names the refusal reason using the same wording a single-item refusal shows', async () => {
    const step = async (): Promise<ApiResult<unknown>> => refusedResult('entity.state_conflict');
    const outcome = await runBulk(['a'], step, () => 'A', () => undefined);

    expect(outcome.refused).toEqual([
      { itemId: 'a', title: 'A', reason: 'This service changed or is locked. Reload to see the latest version.' },
    ]);
  });

  it('reports every item done and nothing refused when every step succeeds', async () => {
    const outcome = await runBulk(['a', 'b'], async () => answered({}), (id) => id, () => undefined);
    expect(outcome).toEqual({ done: 2, total: 2, refused: [] });
  });

  it('reports an empty outcome for an empty selection without calling step', async () => {
    const step = vi.fn(async () => answered({}));
    const progress: BulkOutcome[] = [];
    const outcome = await runBulk([], step, (id) => id, (o) => progress.push(o));

    expect(step).not.toHaveBeenCalled();
    expect(progress).toEqual([]);
    expect(outcome).toEqual({ done: 0, total: 0, refused: [] });
  });
});
