import { describe, expect, it } from 'vitest';

import { ENTITY_KINDS, isEntityKind } from './entities.js';
import { LIBRARY_KINDS, parseLibraryDraft, parseLibraryFilter } from './library.js';
import { FIELD_CODES } from './problems.js';

describe('what the content library holds', () => {
  it('names exactly the five kinds CONT-01 calls reusable content, in ENTITY_KINDS order', () => {
    expect([...LIBRARY_KINDS]).toEqual(['reading', 'reusableSlide', 'sermon', 'slideGroup', 'song']);
  });

  it('names only real entity kinds', () => {
    for (const kind of LIBRARY_KINDS) expect(isEntityKind(kind)).toBe(true);
  });
});

describe('reading library filters', () => {
  it('accepts kind and passes q through', () => {
    expect(parseLibraryFilter({ kind: 'song', q: 'grace' })).toEqual({ ok: true, value: { kind: 'song', q: 'grace', archived: false } });
  });

  it('refuses an invalid kind with the library vocabulary', () => {
    expect(parseLibraryFilter({ kind: 'slideLayout' }, 'filter')).toEqual({ ok: false, problems: [{ path: 'filter.kind', code: FIELD_CODES.notAllowed, message: `must be one of ${LIBRARY_KINDS.join(', ')}` }] });
  });

  it('ignores an empty q', () => {
    expect(parseLibraryFilter({ q: '' })).toEqual({ ok: true, value: { archived: false } });
  });

  it('reads archived only from the true query string', () => {
    expect(parseLibraryFilter({ archived: 'true' })).toEqual({ ok: true, value: { archived: true } });
    expect(parseLibraryFilter({})).toEqual({ ok: true, value: { archived: false } });
    expect(parseLibraryFilter({ archived: '1' })).toEqual({ ok: true, value: { archived: false } });
  });
});

describe('reading a library draft', () => {
  it('accepts a draft and round-trips its kind and title', () => {
    const parsed = parseLibraryDraft({ kind: 'song', title: 'Amazing Grace' }, 'library');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toEqual({ kind: 'song', title: 'Amazing Grace' });
  });

  it('refuses a kind outside LIBRARY_KINDS even when it is a real entity kind', () => {
    expect(ENTITY_KINDS).toContain('slideLayout');
    const parsed = parseLibraryDraft({ kind: 'slideLayout', title: 'Not library content' }, 'library');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems).toEqual([
      { path: 'library.kind', code: FIELD_CODES.notAllowed, message: `must be one of ${LIBRARY_KINDS.join(', ')}` },
    ]);
  });

  it('refuses a missing title', () => {
    const parsed = parseLibraryDraft({ kind: 'song' }, 'library');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems).toEqual([
      { path: 'library.title', code: FIELD_CODES.required, message: 'is required' },
    ]);
  });

  it('refuses an empty title', () => {
    const parsed = parseLibraryDraft({ kind: 'song', title: '' }, 'library');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems).toEqual([
      { path: 'library.title', code: FIELD_CODES.empty, message: 'must not be empty' },
    ]);
  });

  it('refuses something that is not an object at all', () => {
    const parsed = parseLibraryDraft('song', 'library');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems).toEqual([
      { path: 'library', code: FIELD_CODES.notAnObject, message: 'must be an object' },
    ]);
  });
});
