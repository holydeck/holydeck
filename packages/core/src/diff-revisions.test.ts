import { describe, expect, it } from 'vitest';
import { diffRevisions } from './diff-revisions.js';

describe('diffRevisions', () => {
  it('reports no diffs for identical bodies', () => {
    expect(diffRevisions({ title: 'A' }, { title: 'A' })).toEqual([]);
  });

  it('reports a changed top-level field', () => {
    expect(diffRevisions({ title: 'A' }, { title: 'B' })).toEqual([
      { path: 'title', kind: 'changed', before: 'A', after: 'B' },
    ]);
  });

  it('reports an added field', () => {
    expect(diffRevisions({}, { title: 'B' })).toEqual([{ path: 'title', kind: 'added', after: 'B' }]);
  });

  it('reports a removed field', () => {
    expect(diffRevisions({ title: 'A' }, {})).toEqual([{ path: 'title', kind: 'removed', before: 'A' }]);
  });

  it('recurses into nested objects with a dotted path', () => {
    expect(diffRevisions({ meta: { key: 'song' } }, { meta: { key: 'hymn' } })).toEqual([
      { path: 'meta.key', kind: 'changed', before: 'song', after: 'hymn' },
    ]);
  });

  it('compares slide arrays element by element with an indexed path', () => {
    const before = { slides: [{ text: 'one' }, { text: 'two' }] };
    const after = { slides: [{ text: 'one' }, { text: 'TWO' }] };
    expect(diffRevisions(before, after)).toEqual([
      { path: 'slides[1].text', kind: 'changed', before: 'two', after: 'TWO' },
    ]);
  });
});
