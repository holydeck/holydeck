import { describe, expect, it } from 'vitest';

import { parsePptxCommitTarget, parsePptxReviewDecisions } from './pptx.js';

describe('parsePptxReviewDecisions', () => {
  it('accepts a list of decisions', () => {
    expect(
      parsePptxReviewDecisions([
        { slideIndex: 0, blockIndex: 1, label: 'Verse' },
        { slideIndex: 2, blockIndex: 0, label: 'Chorus' },
      ]),
    ).toEqual({
      ok: true,
      value: [
        { slideIndex: 0, blockIndex: 1, label: 'Verse' },
        { slideIndex: 2, blockIndex: 0, label: 'Chorus' },
      ],
    });
  });

  it('rejects a negative slide index', () => {
    const parsed = parsePptxReviewDecisions([{ slideIndex: -1, blockIndex: 0, label: 'Verse' }]);
    expect(parsed.ok).toBe(false);
  });

  it('rejects a non-array payload', () => {
    const parsed = parsePptxReviewDecisions({ slideIndex: 0, blockIndex: 0, label: 'Verse' });
    expect(parsed.ok).toBe(false);
  });
});

describe('parsePptxCommitTarget', () => {
  it('accepts a create target with Tamil and romanized titles', () => {
    expect(
      parsePptxCommitTarget({ mode: 'create', title: { tamil: 'பாடல்', romanized: 'Paadal' }, reference: 'set.pptx' }),
    ).toEqual({
      ok: true,
      value: { mode: 'create', title: { tamil: 'பாடல்', romanized: 'Paadal' }, reference: 'set.pptx' },
    });
  });

  it('accepts an append target', () => {
    expect(parsePptxCommitTarget({ mode: 'append', id: 'song-1' })).toEqual({
      ok: true,
      value: { mode: 'append', id: 'song-1' },
    });
  });

  it('rejects an unknown mode', () => {
    const parsed = parsePptxCommitTarget({ mode: 'replace', id: 'song-1' });
    expect(parsed.ok).toBe(false);
  });
});
