// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { recallAnswer, rememberAnswer } from './offline-cache.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the offline answer cache', () => {
  it('round-trips a value with the moment it was written', () => {
    rememberAnswer('next-service', { id: 's-1' }, new Date('2026-09-23T10:00:00Z'));

    expect(recallAnswer('next-service')).toEqual({ value: { id: 's-1' }, at: '2026-09-23T10:00:00.000Z' });
  });

  it('reads a value straight from session storage when memory has not seen it yet', () => {
    sessionStorage.setItem(
      'holydeck.cache.recent',
      JSON.stringify({ value: [{ id: 's-2' }], at: '2026-09-20T08:00:00.000Z' }),
    );

    expect(recallAnswer('recent')).toEqual({ value: [{ id: 's-2' }], at: '2026-09-20T08:00:00.000Z' });
  });

  it('treats malformed session storage as no cached answer', () => {
    sessionStorage.setItem('holydeck.cache.broken', '{not json');

    expect(recallAnswer('broken')).toBeUndefined();
  });

  it('treats a stored value with the wrong shape as no cached answer', () => {
    sessionStorage.setItem('holydeck.cache.shape', JSON.stringify({ nope: true }));

    expect(recallAnswer('shape')).toBeUndefined();
  });

  it('does not throw when browser storage refuses reads or writes, and still answers from memory', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('storage denied'); },
      setItem: () => { throw new Error('storage denied'); },
    });

    expect(() => rememberAnswer('resilient', { id: 's-3' })).not.toThrow();
    expect(recallAnswer('resilient')?.value).toEqual({ id: 's-3' });
  });

  it('says there is no cached answer for a key nothing has written', () => {
    expect(recallAnswer('nothing-here')).toBeUndefined();
  });
});
