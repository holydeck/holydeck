// The operator an integration or browser run signs in as, and the ticket its socket is opened with.
//
// A deployment that keeps records keeps sessions, and every socket it serves is opened by spending a
// ticket the session was issued. So a harness that wants a socket has to do what a person does: claim
// the instance it just started, sign in, and ask that session for a ticket. This is that, done once per
// run and against the running stack, so nothing here reaches past the HTTP surface a client has.

import { ACCOUNTS_PATH, ONBOARDING_PATH, accountIdIn } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CSRF_HEADER, SESSION_PATH, TICKET_PATH } from '@holydeck/contracts/sessions';

/** The only account these runs have, claimed on a stack that is thrown away when the run ends. */
export const OPERATOR = Object.freeze({
  name: 'harness',
  displayName: 'Harness Operator',
  password: 'a-long-enough-passphrase',
});

export interface SignedIn {
  /** What a later request sends the session back in, ready to be a `cookie` header. */
  readonly cookie: string;
  /** What a later change returns, which is every request this helper makes after signing in. */
  readonly csrf: string;
  /** A ticket, good once and for seconds, which is what opening a socket spends. */
  ticket(): Promise<string>;
}

export type Fetching = typeof fetch;

export class HarnessSignInError extends Error {
  constructor(what: string, status: number) {
    super(`the harness could not ${what}: the application answered ${status}`);
    this.name = 'HarnessSignInError';
  }
}

const posting = async (
  fetching: Fetching,
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetching(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // A terminal may omit it and a browser may not, so the harness sends what the browser sends.
      origin: baseUrl,
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      ...headers,
    },
    body: JSON.stringify(body),
  });

/** The name and value only: the attributes are the browser's business, and this is not a browser. */
const cookieIn = (response: Response): string => (response.headers.get('set-cookie') ?? '').split(';', 1).join('');

export interface Credentials {
  readonly name: string;
  readonly password: string;
}

/** Signs in with credentials for an account this run already created — the same request `signInTo`
 *  makes once it has claimed the instance, generalized to whichever name and password a caller has. */
export async function signInAs(baseUrl: string, credentials: Credentials, fetching: Fetching = fetch): Promise<SignedIn> {
  const opened = await posting(fetching, baseUrl, SESSION_PATH, credentials);
  if (opened.status !== 201) throw new HarnessSignInError('sign in', opened.status);
  const body = (await opened.json()) as { data: { csrf: string } };
  const cookie = cookieIn(opened);

  return {
    cookie,
    csrf: body.data.csrf,
    ticket: async (): Promise<string> => {
      const issued = await posting(fetching, baseUrl, TICKET_PATH, {}, {
        cookie,
        [CSRF_HEADER]: body.data.csrf,
      });
      if (issued.status !== 200) throw new HarnessSignInError('ask for a socket ticket', issued.status);
      const ticket = (await issued.json()) as { data: { ticket: string } };
      return ticket.data.ticket;
    },
  };
}

/**
 * Claims the instance if it is still claimable and signs in as the operator that claimed it. The claim
 * is allowed to have happened already — a second browser project drives the same stack — which is the
 * one status this helper reads without refusing.
 */
export async function signInTo(baseUrl: string, fetching: Fetching = fetch): Promise<SignedIn> {
  const claim = await posting(fetching, baseUrl, ONBOARDING_PATH, OPERATOR);
  if (claim.status !== 201 && claim.status !== 404) throw new HarnessSignInError('claim the instance', claim.status);
  return signInAs(baseUrl, { name: OPERATOR.name, password: OPERATOR.password }, fetching);
}

/** Self-granting control revokes every operator session, so only the fresh sign-in may be used. */
export async function signInWithControlTo(baseUrl: string, fetching: Fetching = fetch): Promise<SignedIn> {
  const session = await signInTo(baseUrl, fetching);
  const current = await fetching(`${baseUrl}${SESSION_PATH}`, {
    headers: { cookie: session.cookie, [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current) },
  });
  if (current.status !== 200) throw new HarnessSignInError('read the operator session', current.status);
  const body = (await current.json()) as { data: { actor: string } };
  const id = accountIdIn(body.data.actor);
  if (id === undefined) throw new Error('the harness operator session does not identify an account');

  const granted = await fetching(`${baseUrl}${ACCOUNTS_PATH}/${id}/control-presentation`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      origin: baseUrl,
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrf,
    },
    body: JSON.stringify({ granted: true }),
  });
  if (granted.status !== 200) throw new HarnessSignInError('grant presentation control', granted.status);
  return signInTo(baseUrl, fetching);
}
