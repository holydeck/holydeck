// Who is currently editing one piece of content, as the store writes it and reads it back (spec COLL-01).
//
// Presence is an observation, never a claim: nothing here says an editor may write and nothing here says
// another editor may not. An entry is a lease only in the sense that it runs out — an editor whose screen
// was closed, whose laptop slept or whose network went away stops being present without anyone having to
// notice, because the instant it stops being true is written down in advance.
//
// Three instants are carried rather than one. `enteredAt` is when this editor arrived and is what an
// "editing since" reads; `heartbeatAt` is the last time they said so and is what a stale feed is told
// apart by; `expiresAt` is when the entry stops counting and is the only one a reader compares against,
// so a reader never has to know how long a lease is to know whether one is still good.

import { FIELD_CODES, type FieldReader, type Parsed, type ParseFn, parseObject } from './problems.js';

/** Every field a presence entry carries, in the order a record reads. */
export const PRESENCE_FIELDS = ['contentId', 'actor', 'enteredAt', 'heartbeatAt', 'expiresAt'] as const;

export type PresenceField = (typeof PRESENCE_FIELDS)[number];

/** What separates the content from the editor in an entry's key, and so cannot be in either of them. */
export const PRESENCE_KEY_SEPARATOR = '#';

export interface PresenceEntry {
  readonly contentId: string;
  /** The editor, named the way a request context names one. One entry per editor per content, never more. */
  readonly actor: string;
  readonly enteredAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
  /**
   * The editor's name as their account gives it, added by a listing and never stored: the store keeps
   * who, a reader is told what to call them. Absent when no account answers for the actor.
   */
  readonly displayName?: string;
}

/** The identity of an entry as the database stores it, so re-entering refreshes rather than duplicates. */
export const presenceKey = (contentId: string, actor: string): string =>
  `${contentId}${PRESENCE_KEY_SEPARATOR}${actor}`;

/**
 * Whether an entry still counts at a given instant. Comparing text is comparing the instants it names
 * only while both are written the same way, which is what the store's own clock check is there for.
 */
export const isPresent = (entry: PresenceEntry, now: string): boolean => entry.expiresAt > now;

/** Reads a field that goes into the key, which is the one thing neither half may contain. */
function keyPart(reader: FieldReader, name: string): string {
  const value = reader.text(name);
  if (value.includes(PRESENCE_KEY_SEPARATOR)) {
    reader.reject(
      name,
      FIELD_CODES.notAllowed,
      `must not contain ${PRESENCE_KEY_SEPARATOR}, which separates the content from the editor in an entry's key`,
    );
  }
  return value;
}

export const parsePresenceEntry: ParseFn<PresenceEntry> = (value, path) =>
  parseObject(value, path, (reader) => ({
    contentId: keyPart(reader, 'contentId'),
    actor: keyPart(reader, 'actor'),
    enteredAt: reader.time('enteredAt'),
    heartbeatAt: reader.time('heartbeatAt'),
    expiresAt: reader.time('expiresAt'),
    ...(reader.names.includes('displayName') ? { displayName: reader.text('displayName') } : {}),
  }));

/** What an editor names when entering: enough to find their one lease without claiming any write. */
export interface PresenceEnterInput {
  readonly contentId: string;
}

/** Reads an enter request through the same key rule the store relies on when it refreshes an entry. */
export function parsePresenceEnter(value: unknown, path = 'params'): Parsed<PresenceEnterInput> {
  return parseObject(value, path, (reader) => ({ contentId: keyPart(reader, 'contentId') }));
}
