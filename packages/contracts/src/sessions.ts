// What a session is, as a client and a server both have to agree it is. The identifier is opaque and the
// claims behind it live on the server, so nothing here reads a claim out of a token: a token is
// random text, and every question about who it belongs to is a question for the store that issued it.
//
// Nothing here generates a token either. Randomness is the runtime's, and a browser and a server do not
// draw it the same way. What travels is the shape a token has to have, the cookie that carries it, the two
// windows a session lives inside, and the header a client returns its CSRF token in.

import { FIELD_CODES, type Parsed, parseObject } from './problems.js';

/** The cookie the identifier travels in, and the only place it ever travels. */
export const SESSION_COOKIE = 'holydeck_session';

/**
 * `Lax` rather than `Strict`: a service opened from a link in a message has to arrive signed in, and every
 * request that changes anything is checked for its token and its origin regardless of what the cookie
 * allows. `Strict` would buy a second layer over a checked one and cost an operator a sign-in mid-service.
 */
export const SESSION_COOKIE_ATTRIBUTES = Object.freeze({
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
  path: '/',
} as const);

/** The header a client returns the session's CSRF token in. A client holds it in memory and nowhere else. */
export const CSRF_HEADER = 'x-holydeck-csrf';

/** 32 bytes of randomness, which is 43 characters of base64url and nothing a person would guess. */
export const SESSION_TOKEN_BYTES = 32;

/** How long a session survives hearing nothing from its operator, in minutes. */
export const SESSION_IDLE_MINUTES = 120;

/** How long a session survives at all, however busy, in hours. A service day, and then sign in again. */
export const SESSION_ABSOLUTE_HOURS = 24;

/** Why a session identifier was replaced. Each of the three invalidates the identifier that came before. */
export const SESSION_ROTATIONS = ['authentication', 'privilege-change', 'reauthentication'] as const;

export type SessionRotation = (typeof SESSION_ROTATIONS)[number];

/** A browser WebSocket cannot send a header, so a socket proves itself with a ticket in the query string. */
export const TICKET_QUERY = 'ticket';

/** How long a handshake ticket is good for. Long enough to open a socket, short enough to be worth nothing. */
export const TICKET_SECONDS = 30;

/** The methods that never change anything, and so never carry a CSRF token. */
export const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;

export const SESSION_FIELDS = [
  'actor',
  'permissions',
  'startedAt',
  'lastSeenAt',
  'expiresAt',
  'rotation',
  'csrf',
] as const;

export type SessionField = (typeof SESSION_FIELDS)[number];

export interface SessionRecord {
  readonly actor: string;
  readonly permissions: readonly string[];
  readonly startedAt: string;
  readonly lastSeenAt: string;
  /** The absolute deadline, stored rather than derived because the database expires records on a field. */
  readonly expiresAt: string;
  readonly rotation: SessionRotation;
  readonly csrf: string;
}

const TOKEN = /^[A-Za-z0-9_-]{43,}$/u;

const MINUTE = 60_000;

const attributes = (maxAgeSeconds: number): string =>
  [
    `Max-Age=${maxAgeSeconds}`,
    `Path=${SESSION_COOKIE_ATTRIBUTES.path}`,
    'Secure',
    'HttpOnly',
    `SameSite=${SESSION_COOKIE_ATTRIBUTES.sameSite}`,
  ].join('; ');

export const sessionCookie = (token: string, maxAgeSeconds: number): string =>
  `${SESSION_COOKIE}=${token}; ${attributes(maxAgeSeconds)}`;

/** Cleared with the same attributes it was set with, because a cookie is only replaced by its own shape. */
export const clearedSessionCookie = (): string => `${SESSION_COOKIE}=; ${attributes(0)}`;

/** Whether a value could be a token this system issued. Length and alphabet only: meaning is the store's. */
export const isOpaqueToken = (value: string): boolean => TOKEN.test(value);

/** The first cookie of that name, because a second one of the same name is not a value to prefer. */
export function cookieIn(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** A method is safe only when it is one of the three that are; anything else is treated as a change. */
export const mutates = (method: string): boolean =>
  !SAFE_METHODS.includes(method.toUpperCase() as (typeof SAFE_METHODS)[number]);

const after = (instant: string, milliseconds: number): string =>
  new Date(Date.parse(instant) + milliseconds).toISOString();

export interface SessionDeadlines {
  readonly idle: string;
  readonly absolute: string;
}

/** Both deadlines, read off the record, so nothing downstream invents a window of its own. */
export const sessionDeadlines = (record: SessionRecord): SessionDeadlines => ({
  idle: after(record.lastSeenAt, SESSION_IDLE_MINUTES * MINUTE),
  absolute: record.expiresAt,
});

export type SessionState = 'active' | 'idle' | 'expired';

/**
 * Which of the two windows a session has left, if either. The absolute deadline is reported first because
 * it is the one no activity can extend: a session past both is over, not idle.
 */
export function sessionState(record: SessionRecord, at: string): SessionState {
  const now = Date.parse(at);
  const deadlines = sessionDeadlines(record);
  if (now >= Date.parse(deadlines.absolute)) return 'expired';
  if (now >= Date.parse(deadlines.idle)) return 'idle';
  return 'active';
}

export function parseSessionRecord(value: unknown): Parsed<SessionRecord> {
  return parseObject(value, 'session', (reader) => {
    // Read in field order, so a session missing everything reports its fields in the order they are
    // declared rather than in the order this function happened to need them.
    const record = {
      actor: reader.text('actor'),
      permissions: reader.textList('permissions'),
      startedAt: reader.time('startedAt'),
      lastSeenAt: reader.time('lastSeenAt'),
      expiresAt: reader.time('expiresAt'),
      rotation: reader.choice('rotation', SESSION_ROTATIONS),
      csrf: reader.text('csrf'),
    };
    if (record.csrf !== '' && !isOpaqueToken(record.csrf)) {
      reader.reject('csrf', FIELD_CODES.notAllowed, 'must be an opaque token this server issued');
    }
    return record;
  });
}

/**
 * Whether a request came from this deployment's own origin. An absent origin is not same-origin: a
 * mutation whose origin nothing could check is exactly the request this check exists to refuse.
 */
export const isSameOrigin = (origin: string | undefined, expected: string): boolean =>
  origin !== undefined && origin !== '' && origin === expected;
