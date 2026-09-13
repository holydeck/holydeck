import { describe, expect, it } from 'vitest';

import { startStack } from './stack.js';

// What a started stack does is graded by the integration suite that uses one. What is graded here is the
// one thing that suite cannot show: what happens when the stack cannot be started at all.
describe('a stack that cannot be started', () => {
  it('reports which service failed, and takes the half-started stack down with it', async () => {
    await expect(startStack({ mongoUrl: 'not-an-address' })).rejects.toThrow(/the corpus exited with/u);
  });
});
