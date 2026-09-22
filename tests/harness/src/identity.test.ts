import { ACCOUNTS_PATH, ONBOARDING_PATH, actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER } from '@holydeck/contracts/clients';
import { CSRF_HEADER, SESSION_PATH, TICKET_PATH } from '@holydeck/contracts/sessions';
import { describe, expect, it } from 'vitest';

import { HarnessSignInError, OPERATOR, signInTo, signInWithControlTo } from './identity.js';

import type { Fetching } from './identity.js';

const BASE = 'http://127.0.0.1:4711';
const COOKIE = 'holydeck_session=abc123';

interface Asked {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** Every request the helper made, answered by status and body in the order the helper makes them. */
const answering = (answers: Array<{ status: number; body?: unknown; cookie?: string }>): { asked: Asked[]; fetching: Fetching } => {
  const asked: Asked[] = [];
  const fetching = (async (url: unknown, init: RequestInit = {}): Promise<Response> => {
    asked.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const answer = answers[asked.length - 1] ?? { status: 500 };
    return {
      status: answer.status,
      headers: { get: (name: string) => (name === 'set-cookie' ? (answer.cookie ?? null) : null) },
      json: () => Promise.resolve(answer.body),
    } as unknown as Response;
  }) as unknown as Fetching;
  return { asked, fetching };
};

const SIGNED_IN = [
  { status: 201 },
  { status: 201, cookie: `${COOKIE}; Path=/; HttpOnly; Secure; SameSite=Lax`, body: { data: { csrf: 'csrf-token' } } },
];

describe('the operator a harness run signs in as', () => {
  it('claims the instance, signs in, and keeps the cookie and the token a change returns', async () => {
    const { asked, fetching } = answering(SIGNED_IN);
    const session = await signInTo(BASE, fetching);
    expect(session).toMatchObject({ cookie: COOKIE, csrf: 'csrf-token' });
    expect(asked.map((request) => request.url)).toEqual([`${BASE}${ONBOARDING_PATH}`, `${BASE}${SESSION_PATH}`]);
    // What a browser would send, sent because the application grades both: its own origin, and a version.
    expect(asked[0]?.headers).toMatchObject({ origin: BASE, [CLIENT_VERSION_HEADER]: '1' });
    expect(asked[0]?.body).toEqual({ ...OPERATOR });
    expect(asked[1]?.body).toEqual({ name: OPERATOR.name, password: OPERATOR.password });
  });

  // Three browser projects drive one stack, and the first of them claims it. A claim answered not-found
  // is the instance already being claimed, which is the state the run wanted in the first place.
  it('signs in on a stack another run already claimed', async () => {
    const { fetching } = answering([{ status: 404 }, SIGNED_IN[1]!]);
    await expect(signInTo(BASE, fetching)).resolves.toMatchObject({ csrf: 'csrf-token' });
  });

  it('spends the session on a ticket, returning the session and the token it was issued against', async () => {
    const { asked, fetching } = answering([...SIGNED_IN, { status: 200, body: { data: { ticket: 'ticket-1' } } }]);
    const session = await signInTo(BASE, fetching);
    expect(await session.ticket()).toBe('ticket-1');
    expect(asked[2]?.url).toBe(`${BASE}${TICKET_PATH}`);
    expect(asked[2]?.headers).toMatchObject({ cookie: COOKIE, [CSRF_HEADER]: 'csrf-token' });
  });

  it('carries no cookie where the application set none, rather than sending the word undefined', async () => {
    const { fetching } = answering([{ status: 201 }, { status: 201, body: { data: { csrf: 'csrf-token' } } }]);
    await expect(signInTo(BASE, fetching)).resolves.toMatchObject({ cookie: '' });
  });
});

describe('the operator allowed to control presentation', () => {
  const id = 'a'.repeat(22);
  const current = { status: 200, body: { data: { actor: actorFor(id) } } };

  it('self-grants over HTTP and uses a fresh session and CSRF token after revocation', async () => {
    const { asked, fetching } = answering([
      ...SIGNED_IN,
      current,
      { status: 200 },
      { status: 404 },
      { status: 201, cookie: 'holydeck_session=fresh; Path=/', body: { data: { csrf: 'fresh-csrf' } } },
      { status: 200, body: { data: { ticket: 'fresh-ticket' } } },
    ]);
    const session = await signInWithControlTo(BASE, fetching);

    expect(asked[2]).toMatchObject({ url: `${BASE}${SESSION_PATH}`, method: 'GET', headers: { cookie: COOKIE } });
    expect(asked[3]).toEqual({
      url: `${BASE}${ACCOUNTS_PATH}/${id}/control-presentation`,
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        origin: BASE,
        [CLIENT_VERSION_HEADER]: '1',
        cookie: COOKIE,
        [CSRF_HEADER]: 'csrf-token',
      },
      body: { granted: true },
    });
    expect(asked[5]).toMatchObject({ url: `${BASE}${SESSION_PATH}`, method: 'POST' });
    expect(session).toMatchObject({ cookie: 'holydeck_session=fresh', csrf: 'fresh-csrf' });
    expect(await session.ticket()).toBe('fresh-ticket');
    expect(asked[6]?.headers).toMatchObject({ cookie: 'holydeck_session=fresh', [CSRF_HEADER]: 'fresh-csrf' });
  });

  it('reports a refused session read before attempting a grant', async () => {
    const { asked, fetching } = answering([...SIGNED_IN, { status: 401 }]);
    await expect(signInWithControlTo(BASE, fetching)).rejects.toThrow(
      'the harness could not read the operator session: the application answered 401',
    );
    expect(asked).toHaveLength(3);
  });

  it('refuses to grant control for a session without an account actor', async () => {
    const { asked, fetching } = answering([...SIGNED_IN, { status: 200, body: { data: { actor: 'system' } } }]);
    await expect(signInWithControlTo(BASE, fetching)).rejects.toThrow('the harness operator session does not identify an account');
    expect(asked).toHaveLength(3);
  });

  it('reports a refused grant without signing in again', async () => {
    const { asked, fetching } = answering([...SIGNED_IN, current, { status: 403 }]);
    await expect(signInWithControlTo(BASE, fetching)).rejects.toThrow(
      'the harness could not grant presentation control: the application answered 403',
    );
    expect(asked).toHaveLength(4);
  });
});

// A harness that cannot sign in has to say so where it happened. Answering a socket test with "the
// frame never arrived" would send the next person reading it into the live protocol instead.
describe('what the harness says when it cannot', () => {
  it('names the claim that was refused for any other reason', async () => {
    const { fetching } = answering([{ status: 422 }]);
    await expect(signInTo(BASE, fetching)).rejects.toThrow(HarnessSignInError);
    await expect(signInTo(BASE, answering([{ status: 422 }]).fetching)).rejects.toThrow(
      'the harness could not claim the instance: the application answered 422',
    );
  });

  it('names a sign-in that was refused', async () => {
    const { fetching } = answering([{ status: 201 }, { status: 401 }]);
    await expect(signInTo(BASE, fetching)).rejects.toThrow(
      'the harness could not sign in: the application answered 401',
    );
  });

  it('names a ticket that was refused', async () => {
    const { fetching } = answering([...SIGNED_IN, { status: 403 }]);
    const session = await signInTo(BASE, fetching);
    await expect(session.ticket()).rejects.toThrow(
      'the harness could not ask for a socket ticket: the application answered 403',
    );
  });
});
