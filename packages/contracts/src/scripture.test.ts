import { describe, expect, it } from 'vitest';

import { FIELD_CODES } from './problems.js';
import { SCRIPTURE_QUERY_MAX, parseScriptureSearchQuery } from './scripture.js';

describe('reading scripture search queries', () => {
  it('accepts an absent or empty query as a search for nothing', () => {
    expect(parseScriptureSearchQuery({})).toEqual({ ok: true, value: { q: '' } });
    expect(parseScriptureSearchQuery({ q: '' })).toEqual({ ok: true, value: { q: '' } });
  });

  it('passes a normal query through unchanged', () => {
    expect(parseScriptureSearchQuery({ q: 'in the beginning' })).toEqual({ ok: true, value: { q: 'in the beginning' } });
  });

  it('refuses a query beyond the limit', () => {
    expect(parseScriptureSearchQuery({ q: 'a'.repeat(SCRIPTURE_QUERY_MAX + 1) })).toEqual({
      ok: false,
      problems: [{ path: 'scriptureSearch.q', code: FIELD_CODES.tooLarge, message: 'must be at most 200 characters' }],
    });
  });

  it('accepts a query at the limit', () => {
    expect(parseScriptureSearchQuery({ q: 'a'.repeat(SCRIPTURE_QUERY_MAX) })).toEqual({
      ok: true,
      value: { q: 'a'.repeat(SCRIPTURE_QUERY_MAX) },
    });
  });
});
