import { describe, expect, it } from 'vitest';

import { mongoFor } from './mongo.js';

describe('the database the harness stores into', () => {
  // The other half of this decision — starting one in memory — is what every integration run does, so it
  // is graded by the suite itself rather than here.
  it('uses a database it was handed, and has nothing of its own to stop', async () => {
    const mongo = await mongoFor('mongodb://127.0.0.1:27017/');
    expect(mongo.base).toBe('mongodb://127.0.0.1:27017/');
    await expect(mongo.stop()).resolves.toBeUndefined();
  });
});
