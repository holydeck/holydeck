import { describe, expect, it } from 'vitest';

import { canonical, canonicalJson } from './canonical.js';

describe('the canonical form', () => {
  it('writes the same text for two objects that differ only in the order their keys were written', () => {
    expect(canonicalJson({ title: 'Andru', id: 'song-1' })).toBe(canonicalJson({ id: 'song-1', title: 'Andru' }));
    expect(canonicalJson({ title: 'Andru', id: 'song-1' })).toBe('{"id":"song-1","title":"Andru"}');
  });

  it('sorts every level, because a body nests', () => {
    expect(canonicalJson({ b: { d: 2, c: 1 }, a: 0 })).toBe('{"a":0,"b":{"c":1,"d":2}}');
  });

  it('leaves a list in the order it was given, because a list is ordered content', () => {
    expect(canonicalJson(['second', 'first'])).toBe('["second","first"]');
    expect(canonicalJson([{ b: 1, a: 0 }])).toBe('[{"a":0,"b":1}]');
  });

  it('writes a value that is not an object as itself', () => {
    expect(canonicalJson('Andru')).toBe('"Andru"');
    expect(canonicalJson(7)).toBe('7');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
  });

  it('writes a value JSON cannot carry as nothing at all, because a hash needs bytes', () => {
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson({ title: 'Andru', draft: undefined })).toBe('{"title":"Andru"}');
  });

  it('carries no whitespace, because this form is hashed rather than read', () => {
    expect(canonicalJson({ stanzas: ['one', 'two'], title: 'Andru' })).not.toMatch(/\s/u);
  });

  it('leaves the value it was given alone, so canonicalising is safe to do to stored state', () => {
    const stored = Object.freeze({ title: 'Andru', id: 'song-1' });
    expect(() => canonicalJson(stored)).not.toThrow();
    expect(Object.keys(stored)).toEqual(['title', 'id']);
    expect(canonical(stored)).not.toBe(stored);
  });
});
