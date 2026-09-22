import { describe, expect, it } from 'vitest';

import {
  CSRF_HEADER,
  SESSION_ABSOLUTE_HOURS,
  SESSION_COOKIE,
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_IDLE_MINUTES,
  SESSION_ROTATIONS,
  SESSION_TOKEN_BYTES,
  TICKET_QUERY,
  TICKET_SECONDS,
  clearedSessionCookie,
  cookieIn,
  isOpaqueToken,
  isSameOrigin,
  mutates,
  parseSessionRecord,
  parseSessionView,
  sessionCookie,
  sessionDeadlines,
  sessionState,
} from './sessions.js';

import type { SessionRecord, SessionView } from './sessions.js';

const TOKEN = 'Zm9vYmFyYmF6cXV1eGNvcmdlZ3JhdWx0Z2FycGx5eHg';

const RECORD: SessionRecord = {
  actor: 'account:7f3a',
  permissions: ['content.revisions.append', 'content.revisions.read'],
  startedAt: '2026-09-13T09:00:00.000Z',
  lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:00:00.000Z',
  rotation: 'authentication',
  csrf: 'Y3NyZi10b2tlbi13aXRoLWVub3VnaC1sZW5ndGgtdG8tY291bnQ',
};

const VIEW: SessionView = {
  ...RECORD,
  slots: [{ slotId: 'slot-1', actor: RECORD.actor }],
  account: {
    id: 'ZmFrZS1hY2NvdW50LWlk',
    name: 'andru',
    displayName: 'Andru Tharmarajah',
    role: 'admin',
    controlPresentation: true,
  },
};

describe('what a session is', () => {
  it('is carried by a cookie a script cannot read and a foreign site cannot send', () => {
    const header = sessionCookie(TOKEN, 3600);
    expect(SESSION_COOKIE).toBe('__Host-holydeck_session');
    expect(header.startsWith(`${SESSION_COOKIE}=${TOKEN};`)).toBe(true);
    expect(header).not.toMatch(/Domain=/iu);
    expect(header).toContain('Secure');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=3600');
    expect(SESSION_COOKIE_ATTRIBUTES).toEqual({ secure: true, httpOnly: true, sameSite: 'Lax', path: '/' });
  });

  it('is cleared by the same cookie with no life left in it', () => {
    const header = clearedSessionCookie();
    expect(header.startsWith(`${SESSION_COOKIE}=;`)).toBe(true);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
  });

  it('is a token long enough that guessing one is not a strategy', () => {
    expect(SESSION_TOKEN_BYTES).toBe(32);
    expect(isOpaqueToken(TOKEN)).toBe(true);
    expect(isOpaqueToken('short')).toBe(false);
    expect(isOpaqueToken(`${TOKEN}=`)).toBe(false);
    expect(isOpaqueToken('account:7f3a.signature.that.says.who.you.are')).toBe(false);
  });

  it('is read out of a cookie header by name and by nothing else', () => {
    const header = `theme=dark; ${SESSION_COOKIE}=${TOKEN}; locale=ta`;
    expect(cookieIn(header, SESSION_COOKIE)).toBe(TOKEN);
    expect(cookieIn(header, 'locale')).toBe('ta');
    expect(cookieIn(header, 'absent')).toBeUndefined();
    expect(cookieIn(undefined, SESSION_COOKIE)).toBeUndefined();
    expect(cookieIn('nonsense-with-no-equals', SESSION_COOKIE)).toBeUndefined();
    expect(cookieIn(`${SESSION_COOKIE}=first; ${SESSION_COOKIE}=second`, SESSION_COOKIE)).toBe('first');
  });

  it('names the header a client returns its token in, and the query a socket carries its ticket in', () => {
    expect(CSRF_HEADER).toBe('x-holydeck-csrf');
    expect(TICKET_QUERY).toBe('ticket');
    expect(TICKET_SECONDS).toBeLessThanOrEqual(60);
  });
});

describe('which requests change something', () => {
  it('calls a method safe only when it is one of the three that are', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head', 'options']) expect(mutates(method)).toBe(false);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete']) expect(mutates(method)).toBe(true);
  });

  it('treats a method it has never heard of as one that changes something', () => {
    expect(mutates('QUERY')).toBe(true);
    expect(mutates('')).toBe(true);
  });
});

describe('when a session stops being one', () => {
  const at = (instant: string): string => instant;

  it('is active while it is inside both windows', () => {
    expect(sessionState(RECORD, at('2026-09-13T10:00:00.000Z'))).toBe('active');
  });

  it('goes idle when nothing has been heard from it for the idle window', () => {
    expect(SESSION_IDLE_MINUTES).toBe(120);
    expect(sessionState(RECORD, at('2026-09-13T11:29:59.000Z'))).toBe('active');
    expect(sessionState(RECORD, at('2026-09-13T11:30:00.000Z'))).toBe('idle');
  });

  it('ends at the absolute deadline however busy it has been', () => {
    expect(SESSION_ABSOLUTE_HOURS).toBe(24);
    const busy = { ...RECORD, lastSeenAt: '2026-09-14T08:59:00.000Z' };
    expect(sessionState(busy, at('2026-09-14T08:59:30.000Z'))).toBe('active');
    expect(sessionState(busy, at('2026-09-14T09:00:00.000Z'))).toBe('expired');
  });

  it('reports the expired end of a session that is past both deadlines, because that is the one that stands', () => {
    expect(sessionState(RECORD, at('2026-09-15T00:00:00.000Z'))).toBe('expired');
  });

  it('states both deadlines from the record, so the store never computes one of its own', () => {
    expect(sessionDeadlines(RECORD)).toEqual({
      idle: '2026-09-13T11:30:00.000Z',
      absolute: '2026-09-14T09:00:00.000Z',
    });
  });
});

describe('reading a stored session', () => {
  it('reads a whole one', () => {
    const parsed = parseSessionRecord(RECORD);
    expect(parsed.ok && parsed.value).toEqual(RECORD);
  });

  it('names every field it is missing at once', () => {
    const parsed = parseSessionRecord({});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.map((problem) => problem.path)).toEqual([
      'session.actor',
      'session.permissions',
      'session.startedAt',
      'session.lastSeenAt',
      'session.expiresAt',
      'session.rotation',
      'session.csrf',
    ]);
  });

  it('refuses a rotation reason nobody decided on', () => {
    const parsed = parseSessionRecord({ ...RECORD, rotation: 'because' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems[0]?.message).toContain(SESSION_ROTATIONS.join(', '));
  });

  it('refuses a CSRF token that is not one', () => {
    const parsed = parseSessionRecord({ ...RECORD, csrf: 'abc' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems[0]?.path).toBe('session.csrf');
  });

  it('refuses permissions that are not a list of names', () => {
    const parsed = parseSessionRecord({ ...RECORD, permissions: 'content.revisions.read' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems[0]?.path).toBe('session.permissions');
  });

  it('rotates for three reasons and no others', () => {
    expect([...SESSION_ROTATIONS]).toEqual(['authentication', 'privilege-change', 'reauthentication']);
  });
});

describe('reading the session view', () => {
  it('reads a view with the account behind its actor', () => {
    const parsed = parseSessionView(VIEW);
    expect(parsed.ok && parsed.value).toEqual(VIEW);
  });

  it('reads a view without an account for an actor that has none', () => {
    const withoutAccount = Object.fromEntries(Object.entries(VIEW).filter(([name]) => name !== 'account'));
    const parsed = parseSessionView(withoutAccount);
    expect(parsed.ok && parsed.value).toEqual(withoutAccount);
  });

  it('refuses an account role the permission model does not name', () => {
    const parsed = parseSessionView({ ...VIEW, account: { ...VIEW.account, role: 'owner' } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems[0]?.path).toBe('session.account.role');
  });

  it('refuses a view without its slots', () => {
    const withoutSlots = Object.fromEntries(Object.entries(VIEW).filter(([name]) => name !== 'slots'));
    const parsed = parseSessionView(withoutSlots);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems[0]?.path).toBe('session.slots');
  });
});

describe('where a request came from', () => {
  it('is same-origin only when the origin is exactly the one this deployment serves', () => {
    expect(isSameOrigin('https://holydeck.example', 'https://holydeck.example')).toBe(true);
    expect(isSameOrigin('https://holydeck.example.attacker.test', 'https://holydeck.example')).toBe(false);
    expect(isSameOrigin('http://holydeck.example', 'https://holydeck.example')).toBe(false);
    expect(isSameOrigin('https://holydeck.example:8443', 'https://holydeck.example')).toBe(false);
  });

  it('is not same-origin when there is no origin to check, because an unchecked origin is the defect', () => {
    expect(isSameOrigin(undefined, 'https://holydeck.example')).toBe(false);
    expect(isSameOrigin('null', 'https://holydeck.example')).toBe(false);
    expect(isSameOrigin('', 'https://holydeck.example')).toBe(false);
  });
});
