import { describe, expect, it } from 'vitest';

import { parseIntegrationPatch } from './integrations.js';

describe('parseIntegrationPatch', () => {
  it('accepts a boolean enabled', () => {
    expect(parseIntegrationPatch({ enabled: true })).toEqual({ ok: true, value: { enabled: true } });
  });

  it('rejects a missing enabled', () => {
    expect(parseIntegrationPatch({}).ok).toBe(false);
  });

  it('rejects a non-boolean enabled', () => {
    expect(parseIntegrationPatch({ enabled: 'yes' }).ok).toBe(false);
  });
});
