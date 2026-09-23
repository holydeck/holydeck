import { describe, expect, it, vi } from 'vitest';

import { saveContent } from './save-content.js';

describe('saveContent', () => {
  it('delegates to conflictShelf.saveWithConflictPreservation with the given revisions store', async () => {
    const outcome = { appended: true, revision: 2 };
    const conflictShelf = { saveWithConflictPreservation: vi.fn().mockResolvedValue(outcome) };
    const revisions = {};
    const context = { actor: 'account:1', correlationId: 'test:1' };
    const input = { contentId: 'song:1', body: { title: 'A' }, origin: 'manual-checkpoint' as const };

    const save = saveContent(revisions as never, conflictShelf as never);
    const result = await save(context, input);

    expect(result).toBe(outcome);
    expect(conflictShelf.saveWithConflictPreservation).toHaveBeenCalledWith(context, revisions, input);
  });
});
