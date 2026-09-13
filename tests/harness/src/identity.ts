// The operator an integration or browser run signs in as, and the ticket its socket is opened with.
//
// A deployment that keeps records keeps sessions, and every socket it serves is opened by spending a
// ticket the session was issued. So a harness that wants a socket has to do what a person does: claim
// the instance it just started, sign in, and ask that session for a ticket. This is that, done once per
// run and against the running stack, so nothing here reaches past the HTTP surface a client has.

import { ONBOARDING_PATH } from '@holydeck/contracts/accounts';
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

/**
 * Claims the instance if it is still claimable and signs in as the operator that claimed it. The claim
 * is allowed to have happened already — a second browser project drives the same stack — which is the
 * one status this helper reads without refusing.
 */
export async function signInTo(baseUrl: string, fetching: Fetching = fetch): Promise<SignedIn> {
  const claim = await posting(fetching, baseUrl, ONBOARDING_PATH, OPERATOR);
  if (claim.status !== 201 && claim.status !== 404) throw new HarnessSignInError('claim the instance', claim.status);

  const opened = await posting(fetching, baseUrl, SESSION_PATH, {
    name: OPERATOR.name,
    password: OPERATOR.password,
  });
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
