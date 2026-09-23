import { describe, expect, it } from 'vitest';

import {
  PRESENCE_FIELDS,
  PRESENCE_KEY_SEPARATOR,
  isPresent,
  parsePresenceEnter,
  parsePresenceEntry,
  presenceKey,
} from './presence.js';
import { FIELD_CODES } from './problems.js';

import type { PresenceEntry } from './presence.js';

const stored = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  contentId: 'song-1',
  actor: 'account:7f3a',
  enteredAt: '2026-09-17T09:30:00.000Z',
  heartbeatAt: '2026-09-17T09:30:20.000Z',
  expiresAt: '2026-09-17T09:30:50.000Z',
  ...overrides,
});

const read = (value: unknown): PresenceEntry => {
  const parsed = parsePresenceEntry(value, 'presence');
  if (!parsed.ok) throw new Error(parsed.problems.map((problem) => problem.path).join(', '));
  return parsed.value;
};

const codes = (value: unknown): string[] => {
  const parsed = parsePresenceEntry(value, 'presence');
  expect(parsed.ok).toBe(false);
  return parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}=${problem.code}`);
};

describe('what an entry says somebody is doing', () => {
  it('names every field an entry carries', () => {
    expect([...PRESENCE_FIELDS]).toEqual(['contentId', 'actor', 'enteredAt', 'heartbeatAt', 'expiresAt']);
  });

  it('reads back the name a listing gives the editor, and leaves it out when there is none', () => {
    expect(read(stored({ displayName: 'Chioma Obi' })).displayName).toBe('Chioma Obi');
    expect(read(stored())).not.toHaveProperty('displayName');
  });

  it('reads back the content, the editor and the three instants', () => {
    expect(read(stored())).toEqual({
      contentId: 'song-1',
      actor: 'account:7f3a',
      enteredAt: '2026-09-17T09:30:00.000Z',
      heartbeatAt: '2026-09-17T09:30:20.000Z',
      expiresAt: '2026-09-17T09:30:50.000Z',
    });
  });

  it('names one editor of one piece of content, so a second editor is a second entry', () => {
    expect(presenceKey('song-1', 'account:7f3a')).toBe(`song-1${PRESENCE_KEY_SEPARATOR}account:7f3a`);
    expect(presenceKey('song-1', 'account:b2c9')).not.toBe(presenceKey('song-1', 'account:7f3a'));
  });

  it('refuses a content identifier or an editor carrying the separator, which would name another pair', () => {
    expect(codes(stored({ contentId: `song-1${PRESENCE_KEY_SEPARATOR}account:b2c9` }))).toEqual([
      `presence.contentId=${FIELD_CODES.notAllowed}`,
    ]);
    expect(codes(stored({ actor: `a${PRESENCE_KEY_SEPARATOR}b` }))).toEqual([`presence.actor=${FIELD_CODES.notAllowed}`]);
  });

  it('refuses an entry missing a field, naming every one of them rather than the first', () => {
    expect(codes({ contentId: 'song-1' }).sort()).toEqual(
      ['presence.actor', 'presence.enteredAt', 'presence.expiresAt', 'presence.heartbeatAt']
        .map((path) => `${path}=${FIELD_CODES.required}`)
        .sort(),
    );
  });

  it('refuses an instant that is not one, because presence is compared as text', () => {
    expect(codes(stored({ expiresAt: 'later' }))).toEqual([`presence.expiresAt=${FIELD_CODES.notATime}`]);
  });

  it('refuses something that is not an object at all', () => {
    expect(codes('account:7f3a')).toEqual([`presence=${FIELD_CODES.notAnObject}`]);
  });
});

describe('whether an entry still stands', () => {
  const entry = read(stored());

  it('stands right up to the instant it expires, and not at it', () => {
    expect(isPresent(entry, '2026-09-17T09:30:49.999Z')).toBe(true);
    expect(isPresent(entry, '2026-09-17T09:30:50.000Z')).toBe(false);
    expect(isPresent(entry, '2026-09-17T09:31:00.000Z')).toBe(false);
  });
});

describe('parsePresenceEnter', () => {
  it('accepts a plain contentId', () => {
    const result = parsePresenceEnter({ contentId: 'song:1' });
    expect(result).toEqual({ ok: true, value: { contentId: 'song:1' } });
  });

  it('rejects a missing contentId', () => {
    const result = parsePresenceEnter({});
    expect(result.ok).toBe(false);
  });

  it('rejects a contentId containing the reserved separator', () => {
    const result = parsePresenceEnter({ contentId: 'song#1' });
    expect(result.ok).toBe(false);
  });
});
