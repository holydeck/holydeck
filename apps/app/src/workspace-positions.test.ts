import { describe, expect, it } from 'vitest';

import { workspacePositionsOn } from './workspace-positions.js';

import type { Document, Filter } from './repositories.js';
import type { WorkspacePositionCollection, WorkspacePositionDb } from './workspace-positions.js';

const memoryPositionDb = (): WorkspacePositionDb => {
  const rows = new Map<string, Document>();
  const collection: WorkspacePositionCollection = {
    async findOne(filter: Filter) {
      return rows.get(String(filter['_id'])) ?? null;
    },
    async replaceOne(filter, replacement) {
      rows.set(String(filter['_id']), replacement);
    },
  };
  return { collection: () => collection };
};

describe('workspace positions', () => {
  it('keeps one position per account and stamps updatedAt', async () => {
    const positions = workspacePositionsOn(memoryPositionDb(), { now: () => '2026-09-22T10:00:00.000Z' });
    await positions.write('account:A', { serviceId: 's1', itemId: 'i1' });
    await positions.write('account:B', { serviceId: 's2' });
    expect(await positions.read('account:A')).toEqual({ serviceId: 's1', itemId: 'i1', updatedAt: '2026-09-22T10:00:00.000Z' });
    expect(await positions.read('account:C')).toBeUndefined();
  });

  it('replaces rather than merges', async () => {
    const positions = workspacePositionsOn(memoryPositionDb(), { now: () => 'now' });
    await positions.write('account:A', { serviceId: 's1', itemId: 'i1' });
    await positions.write('account:A', { serviceId: 's1' });
    expect(await positions.read('account:A')).toEqual({ serviceId: 's1', updatedAt: 'now' });
  });
});
