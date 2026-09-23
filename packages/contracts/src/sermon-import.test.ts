import { describe, expect, it } from 'vitest';

import { parseSermonImportRequest } from './sermon-import.js';

describe('parseSermonImportRequest', () => {
  it('accepts text and translations', () => {
    expect(parseSermonImportRequest({ text: 'A sermon', translations: ['KJV', 'NIV'] })).toEqual({
      ok: true,
      value: { text: 'A sermon', translations: ['KJV', 'NIV'] },
    });
  });

  it('rejects text over 20000 characters', () => {
    const parsed = parseSermonImportRequest({ text: 'x'.repeat(20_001), translations: ['KJV'] });
    expect(parsed.ok).toBe(false);
  });

  it('rejects an empty translations list', () => {
    const parsed = parseSermonImportRequest({ text: 'A sermon', translations: [] });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a non-object payload', () => {
    const parsed = parseSermonImportRequest('A sermon');
    expect(parsed.ok).toBe(false);
  });
});
