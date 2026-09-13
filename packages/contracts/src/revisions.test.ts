import { describe, expect, it } from 'vitest';

import { FIELD_CODES } from './problems.js';
import {
  HASH_ALGORITHM,
  historyProblems,
  isRevisionAddress,
  parseRevisionRecord,
  REVISION_FIELDS,
  REVISION_KEY_SEPARATOR,
  REVISION_ORIGINS,
  revisionAddress,
  revisionBytes,
  revisionKey,
} from './revisions.js';

import type { RevisionRecord } from './revisions.js';

const digest = (fill: string) => fill.repeat(64).slice(0, 64);

const stored = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  contentId: 'song-1',
  revision: 1,
  hash: revisionAddress(digest('a')),
  origin: 'manual-checkpoint',
  at: '2026-09-13T09:30:00.000Z',
  actor: 'account:7f3a',
  correlationId: 'req-0f9c2a41',
  body: { title: 'Andru' },
  ...overrides,
});

const read = (value: unknown): RevisionRecord => {
  const parsed = parseRevisionRecord(value);
  if (!parsed.ok) throw new Error(parsed.problems.map((problem) => problem.path).join(', '));
  return parsed.value;
};

const codes = (value: unknown): string[] => {
  const parsed = parseRevisionRecord(value);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}=${problem.code}`);
};

const run = (count: number, overrides: (ordinal: number) => Record<string, unknown> = () => ({})): RevisionRecord[] =>
  Array.from({ length: count }, (_, index) => read(stored({ revision: index + 1, ...overrides(index + 1) })));

describe('what a revision records', () => {
  it('records the two origins the specification names, and no third', () => {
    expect(REVISION_ORIGINS).toEqual(['autosave', 'manual-checkpoint']);
  });

  it('names every field a revision carries', () => {
    expect([...REVISION_FIELDS]).toEqual([
      'contentId',
      'revision',
      'hash',
      'origin',
      'at',
      'actor',
      'correlationId',
      'body',
    ]);
  });

  it('addresses a body by algorithm and digest, so the algorithm can change without ambiguity', () => {
    expect(revisionAddress(digest('a'))).toBe(`${HASH_ALGORITHM}-${digest('a')}`);
    expect(isRevisionAddress(revisionAddress(digest('0')))).toBe(true);
  });

  it('refuses an address that is not this algorithm over a full digest', () => {
    expect(isRevisionAddress(digest('a'))).toBe(false);
    expect(isRevisionAddress(`${HASH_ALGORITHM}-${digest('a').slice(1)}`)).toBe(false);
    expect(isRevisionAddress(`${HASH_ALGORITHM}-${digest('A')}`)).toBe(false);
    expect(isRevisionAddress(`md5-${digest('a')}`)).toBe(false);
  });

  it('takes the address over the canonical body, so two saves differing only in key order are one save', () => {
    expect(revisionBytes({ title: 'Andru', id: 'song-1' })).toBe(revisionBytes({ id: 'song-1', title: 'Andru' }));
    expect(revisionBytes({ title: 'Andru' })).toBe('{"title":"Andru"}');
  });

  it('keys a revision by the content it belongs to and the ordinal it is', () => {
    expect(revisionKey('song-1', 3)).toBe(`song-1${REVISION_KEY_SEPARATOR}3`);
  });
});

describe('reading a stored revision', () => {
  it('reads a whole revision back as it was appended', () => {
    expect(read(stored())).toEqual({
      contentId: 'song-1',
      revision: 1,
      hash: revisionAddress(digest('a')),
      origin: 'manual-checkpoint',
      at: '2026-09-13T09:30:00.000Z',
      actor: 'account:7f3a',
      correlationId: 'req-0f9c2a41',
      body: { title: 'Andru' },
    });
  });

  it('lists every field that is missing at once, rather than the first one', () => {
    expect(codes({}).sort()).toEqual(
      [
        'revision.actor',
        'revision.at',
        'revision.body',
        'revision.contentId',
        'revision.correlationId',
        'revision.hash',
        'revision.origin',
        'revision.revision',
      ]
        .map((path) => `${path}=${FIELD_CODES.required}`)
        .sort(),
    );
  });

  it('refuses a content identifier carrying the character that separates it from the ordinal', () => {
    expect(codes(stored({ contentId: `song${REVISION_KEY_SEPARATOR}1` }))).toEqual([
      `revision.contentId=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses an ordinal that is not a whole number of revisions starting at one', () => {
    expect(codes(stored({ revision: 0 }))).toEqual([`revision.revision=${FIELD_CODES.tooSmall}`]);
    expect(codes(stored({ revision: 1.5 }))).toEqual([`revision.revision=${FIELD_CODES.notAWholeNumber}`]);
  });

  it('refuses a hash that does not address a body', () => {
    expect(codes(stored({ hash: 'sha256-not-a-digest' }))).toEqual([`revision.hash=${FIELD_CODES.notAllowed}`]);
  });

  it('faults a missing hash once, as missing rather than as malformed', () => {
    expect(codes(stored({ hash: undefined }))).toEqual([`revision.hash=${FIELD_CODES.required}`]);
  });

  it('refuses an origin outside the two a revision can have', () => {
    expect(codes(stored({ origin: 'restore' }))).toEqual([`revision.origin=${FIELD_CODES.notAllowed}`]);
  });

  it('refuses a body that is not an object, because a body is addressed by its fields', () => {
    expect(codes(stored({ body: 'Andru' }))).toEqual([`revision.body=${FIELD_CODES.notAnObject}`]);
  });

  it('refuses a time that is not an instant, and a record that is not an object at all', () => {
    expect(codes(stored({ at: 'sunday morning' }))).toEqual([`revision.at=${FIELD_CODES.notATime}`]);
    expect(codes('song-1')).toEqual([`revision=${FIELD_CODES.notAnObject}`]);
  });
});

describe('history read as a whole', () => {
  it('faults nothing in a content that has no revisions yet', () => {
    expect(historyProblems([])).toEqual([]);
  });

  it('accepts a run of ordinals that only ever grew by one', () => {
    expect(historyProblems(run(3))).toEqual([]);
  });

  it('accepts a body that came back, because a restore appends the address it restored', () => {
    const restored = run(2, (ordinal) => (ordinal === 2 ? { hash: revisionAddress(digest('a')) } : {}));
    expect(historyProblems(restored)).toEqual([]);
  });

  it('refuses a gap, because nothing is ever removed from history', () => {
    const gapped = [read(stored({ revision: 1 })), read(stored({ revision: 3 }))];
    expect(historyProblems(gapped)).toEqual(['revision 3: follows revision 1, and history only ever grows by one']);
  });

  it('refuses a repeated ordinal, because that is history written twice', () => {
    const repeated = [read(stored({ revision: 1 })), read(stored({ revision: 1 }))];
    expect(historyProblems(repeated)).toEqual(['revision 1: follows revision 1, and history only ever grows by one']);
  });

  it('refuses a history that does not start at the first revision', () => {
    expect(historyProblems([read(stored({ revision: 2 }))])).toEqual(['revision 2: history starts at revision 1']);
  });

  it('refuses one history holding the revisions of two contents', () => {
    const mixed = run(2, (ordinal) => (ordinal === 2 ? { contentId: 'song-2' } : {}));
    expect(historyProblems(mixed)).toEqual(['revision 2: belongs to song-2, not to song-1']);
  });
});
