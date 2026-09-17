import { describe, expect, it } from 'vitest';

import {
  SHELF_ENTRY_KINDS,
  SHELF_KEY_SEPARATOR,
  isResolved,
  isShelved,
  outstandingIn,
  parseShelfEntry,
  shelfKey,
} from './collaboration.js';
import { FIELD_CODES } from './problems.js';

import type { ShelfEntry } from './collaboration.js';

const shelved = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'shelved',
  contentId: 'song-1',
  sequence: 1,
  attempted: 3,
  origin: 'autosave',
  body: { title: 'Andru' },
  at: '2026-09-17T09:30:00.000Z',
  actor: 'account:7f3a',
  correlationId: 'req-0f9c2a41',
  ...overrides,
});

const resolved = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'resolved',
  contentId: 'song-1',
  sequence: 2,
  resolves: 1,
  revision: 4,
  at: '2026-09-17T09:31:00.000Z',
  actor: 'account:b2c9',
  correlationId: 'req-0f9c2a42',
  ...overrides,
});

const read = (value: unknown): ShelfEntry => {
  const parsed = parseShelfEntry(value, 'shelfEntry');
  if (!parsed.ok) throw new Error(parsed.problems.map((problem) => problem.path).join(', '));
  return parsed.value;
};

const codes = (value: unknown): string[] => {
  const parsed = parseShelfEntry(value, 'shelfEntry');
  expect(parsed.ok).toBe(false);
  return parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}=${problem.code}`);
};

describe('what a row on the shelf is', () => {
  it('is a losing attempt or the note that settles one, and nothing else', () => {
    expect([...SHELF_ENTRY_KINDS]).toEqual(['shelved', 'resolved']);
  });

  it('keeps the losing attempt whole: the ordinal it wanted and the body it carried', () => {
    expect(read(shelved())).toEqual({
      kind: 'shelved',
      contentId: 'song-1',
      sequence: 1,
      attempted: 3,
      origin: 'autosave',
      body: { title: 'Andru' },
      at: '2026-09-17T09:30:00.000Z',
      actor: 'account:7f3a',
      correlationId: 'req-0f9c2a41',
    });
  });

  it('reads the note as what it settles and where the settled body went', () => {
    expect(read(resolved())).toEqual({
      kind: 'resolved',
      contentId: 'song-1',
      sequence: 2,
      resolves: 1,
      revision: 4,
      at: '2026-09-17T09:31:00.000Z',
      actor: 'account:b2c9',
      correlationId: 'req-0f9c2a42',
    });
  });

  it('names a row by its content and its place, so a second row at one place is a duplicate key', () => {
    expect(shelfKey('song-1', 2)).toBe(`song-1${SHELF_KEY_SEPARATOR}2`);
    expect(shelfKey('song-1', 2)).not.toBe(shelfKey('song-1', 3));
  });

  it('tells the two kinds apart without asking the caller to read the tag', () => {
    expect(isShelved(read(shelved()))).toBe(true);
    expect(isResolved(read(shelved()))).toBe(false);
    expect(isShelved(read(resolved()))).toBe(false);
    expect(isResolved(read(resolved()))).toBe(true);
  });

  it('refuses a content identifier carrying the separator, which would name another row', () => {
    expect(codes(shelved({ contentId: `song-1${SHELF_KEY_SEPARATOR}9` }))).toEqual([
      `shelfEntry.contentId=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses a note carrying a body, because both bodies are already permanent elsewhere', () => {
    expect(codes(resolved({ body: { title: 'Andru' } }))).toEqual([`shelfEntry.body=${FIELD_CODES.notAllowed}`]);
  });

  it('refuses a body that is not an object, and an attempt at an ordinal that is not one', () => {
    expect(codes(shelved({ body: 'Andru' }))).toEqual([`shelfEntry.body=${FIELD_CODES.notAnObject}`]);
    expect(codes(shelved({ attempted: 0 }))).toEqual([`shelfEntry.attempted=${FIELD_CODES.tooSmall}`]);
  });

  it('refuses an origin the revision store does not ship', () => {
    expect(codes(shelved({ origin: 'resolution' }))).toEqual([`shelfEntry.origin=${FIELD_CODES.notAllowed}`]);
  });

  it('refuses a kind it has never heard of, and a row that is not an object at all', () => {
    expect(codes(shelved({ kind: 'settled' }))).toContain(`shelfEntry.kind=${FIELD_CODES.notAllowed}`);
    expect(codes('song-1')).toEqual([`shelfEntry=${FIELD_CODES.notAnObject}`]);
  });

  it('refuses a note missing what it settles, naming every missing field rather than the first', () => {
    expect(codes({ kind: 'resolved', contentId: 'song-1', sequence: 2, at: '2026-09-17T09:31:00.000Z' }).sort()).toEqual(
      ['shelfEntry.actor', 'shelfEntry.correlationId', 'shelfEntry.resolves', 'shelfEntry.revision']
        .map((path) => `${path}=${FIELD_CODES.required}`)
        .sort(),
    );
  });
});

describe('which conflicts are still outstanding', () => {
  it('is every shelved attempt no later note settles', () => {
    const entries = [read(shelved()), read(shelved({ sequence: 2, attempted: 4 })), read(resolved({ sequence: 3 }))];
    expect(outstandingIn(entries).map((entry) => entry.sequence)).toEqual([2]);
  });

  it('is nothing at all once every attempt has been settled', () => {
    const entries = [read(shelved()), read(resolved({ sequence: 2, resolves: 1 }))];
    expect(outstandingIn(entries)).toEqual([]);
  });

  it('is decided by the shelf as a whole, so a note settles only the row it names', () => {
    const entries = [read(shelved()), read(shelved({ sequence: 2 })), read(resolved({ sequence: 3, resolves: 2 }))];
    expect(outstandingIn(entries).map((entry) => entry.sequence)).toEqual([1]);
  });
});
