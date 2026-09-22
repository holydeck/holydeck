import { describe, expect, it } from 'vitest';

import { FIELD_CODES } from './problems.js';
import { parseSermonGenerationRequest } from './sermons.js';

describe('reading sermon generation requests', () => {
  it('accepts all fields', () => {
    const value = { sermonRevision: 2, slideLayoutId: 'layout', slideLayoutRevision: 3, slideGroupId: 'group' };
    expect(parseSermonGenerationRequest(value, 'sermon')).toEqual({ ok: true, value });
  });

  it('refuses each required field', () => {
    const value = { sermonRevision: 2, slideLayoutId: 'layout', slideLayoutRevision: 3 };
    expect(parseSermonGenerationRequest({ ...value, sermonRevision: undefined }, 'sermon')).toEqual({ ok: false, problems: [{ path: 'sermon.sermonRevision', code: FIELD_CODES.required, message: 'is required' }] });
    expect(parseSermonGenerationRequest({ ...value, slideLayoutId: undefined }, 'sermon')).toEqual({ ok: false, problems: [{ path: 'sermon.slideLayoutId', code: FIELD_CODES.required, message: 'is required' }] });
    expect(parseSermonGenerationRequest({ ...value, slideLayoutRevision: undefined }, 'sermon')).toEqual({ ok: false, problems: [{ path: 'sermon.slideLayoutRevision', code: FIELD_CODES.required, message: 'is required' }] });
  });
});
