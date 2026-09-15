// The surface a session is opened, read and ended through, and the one place a socket ticket is issued.
//
// Requirement IDEN-02: signing in is the second — and last — change a request with no session may make,
// because it is the request that opens one. Everything that could tell a caller something they have not
// proved is answered the same way: a password that is not that account's, a handle nobody holds, a body
// that is not a sign-in at all, a handle that has been tried too often, and a deployment that keeps no
// accounts to sign in to all take one status, one code and one sentence. What separates them is kept
// where it belongs — in the trail an administrator reads, and in the counter the gate keeps.
//
// The order below is the security of it. The gate is asked before the credential is read, so a handle
// under attack costs no derivation; the credential is then read at the same cost whether anybody holds
// the handle or not, which is the store's promise and not this route's; and the counter is told and the
// entry written only after the answer has been decided, so neither can change what is answered.

import { actorFor, parseSignIn } from '@holydeck/contracts/accounts';
import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import {
  SESSION_ABSOLUTE_HOURS,
  SESSION_PATH,
  TICKET_PATH,
  TICKET_SECONDS,
  clearedSessionCookie,
  isSameOrigin,
  sessionCookie,
} from '@holydeck/contracts/sessions';
import { isPasskeySignIn, parsePasskeySignIn } from '@holydeck/contracts/webauthn';

import { accountContext } from './accounts.js';
import { accountScope, attemptContext } from './attempts.js';
import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { originOf, provenSession, refuseAsForbidden, sessionCallFor, sessionFor } from './csrf.js';
import { passkeyContext } from './passkeys.js';
import { sessionContext } from './sessions.js';
import { totpContext } from './totp.js';
import { authenticationOptions, challengeIn, verifiedAssertion } from './webauthn.js';

import type { AuditEntry } from './audit.js';
import type { Identity } from './onboarding.js';
import type { SessionStore } from './sessions.js';
import type { RelyingParty } from './webauthn.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** The one answer every refused sign-in takes, whatever it was refused for. */
export const SIGN_IN_REFUSED = 'auth.sign_in_refused';

const SIGN_IN_MESSAGE = 'Signing in failed. Check the handle and the password, and try again in a few minutes.';

/** Said in full, because saying which of the three it was is the whole of what this route must not say. */
const WHY = 'the handle, the password, or how often they have been tried — this answer does not say which';

const REFUSED_ELSEWHERE = 'a session is opened from this deployment’s own pages, or from a terminal';

const SIGN_IN_PREFIX = 'signin:';

/** How long the browser keeps the cookie: the window no activity extends, which the server enforces too. */
const COOKIE_SECONDS = SESSION_ABSOLUTE_HOURS * 3600;

const partyOf = (request: FastifyRequest): RelyingParty => {
  const host = String(request.headers.host).replace(/:\d+$/u, '');
  return { id: host, origin: originOf(request) };
};

export interface SessionRoutesOptions {
  /** Absent in a deployment that keeps no sessions; the surface is served either way, and refuses. */
  readonly sessions: SessionStore | undefined;
  /** Absent in a deployment that keeps no accounts. Signing in is then refused in the same words. */
  readonly identity: Identity | undefined;
}

/**
 * What is recorded rather than decided. Both the trail and the gate's counter are written after the
 * answer is settled, and a write that failed is logged as the defect it is instead of being answered
 * with: an operator who signed in has signed in, and a guess that was wrong was wrong, whether or not
 * this server managed to write either of those down.
 */
const recorded = async (request: FastifyRequest, what: string, write: () => Promise<void>): Promise<void> => {
  try {
    await write();
  } catch (error: unknown) {
    request.log.error({ err: error }, what);
  }
};

export function serveSessionRoutes(app: FastifyInstance, { sessions, identity }: SessionRoutesOptions): void {
  app.post(SESSION_PATH, async (request, reply) => {
    const refused = (): FastifyReply =>
      reply
        .code(401)
        .send(
          errorEnvelope(SIGN_IN_REFUSED, SIGN_IN_MESSAGE, request.id, [
            { path: 'credentials', code: SIGN_IN_REFUSED, message: WHY },
          ]),
        );

    if (sessions === undefined || identity === undefined) return refused();

    // Before anything is read, and not behind the guard's own origin check: this is the one mutation the
    // guard lets past, so the check it would have made is made here.
    const origin = request.headers.origin;
    if (origin !== undefined && !isSameOrigin(origin, originOf(request))) {
      await refuseAsForbidden(request, reply, 'origin', REFUSED_ELSEWHERE);
      return reply;
    }

    const correlation = correlationFor(SIGN_IN_PREFIX, request.id);
    const gate = attemptContext(correlation);
    const note = (actor: string, entry: AuditEntry): Promise<void> =>
      recorded(request, 'the sign-in trail refused an entry', async () => {
        await identity.audit.record(auditContext(actor, correlation), entry);
      });

    // A passkey names no handle up front — that is the point of a resident key — so it is told apart from
    // a password before either is read, and answered in the same refusal a wrong password is.
    if (isPasskeySignIn(request.body)) {
      const parsed = parsePasskeySignIn(request.body);
      if (!parsed.ok) return refused();
      const context = passkeyContext(correlation);

      if (parsed.value.step === 'challenge') {
        const challenge = await identity.passkeys.challenge(context, 'authentication');
        const options = await authenticationOptions({ party: partyOf(request), challenge });
        return successEnvelope({ passkey: options }, request.id, CLIENT_WINDOW.current);
      }

      const { assertion } = parsed.value;
      const drawnChallenge = challengeIn(assertion.clientDataJSON);
      if (drawnChallenge === undefined) {
        await note('system', { action: 'passkey.use', subject: assertion.id, outcome: 'refused', detail: 'no readable challenge' });
        return refused();
      }
      const spent = await identity.passkeys.spend(context, 'authentication', drawnChallenge);
      if (spent === undefined) {
        await note('system', {
          action: 'passkey.use',
          subject: assertion.id,
          outcome: 'refused',
          detail: 'the challenge was not one this server drew for a sign-in',
        });
        return refused();
      }

      // Found by the credential's own identifier, because a sign-in that named no account has nothing
      // else to look it up by. Existing does not mean proven — the signature below is what proves it.
      const stored = await identity.passkeys.find(context, assertion.id);
      const account = stored === undefined ? undefined : await identity.accounts.read(accountContext(correlation), stored.account);
      if (stored === undefined || account === undefined) {
        await note('system', { action: 'passkey.use', subject: assertion.id, outcome: 'refused', detail: 'no key answers that identifier' });
        return refused();
      }

      // The gate is asked before the signature is checked, and scoped to the account a wrong password
      // would be, so a stolen or cloned credential does not get more guesses than a guessed password would.
      const asked = accountScope(account.name);
      if (await identity.attempts.locked(gate, asked)) return refused();

      const verified = await verifiedAssertion({
        party: partyOf(request),
        challenge: drawnChallenge,
        response: assertion,
        credential: stored,
      });
      if (!verified.ok) {
        await recorded(request, 'the sign-in gate could not count a failure', async () => {
          if (await identity.attempts.failed(gate, asked)) {
            await note('system', {
              action: 'session.lock',
              subject: asked,
              outcome: 'refused',
              detail: 'too many attempts have been made on this handle',
            });
          }
        });
        // Found does not mean proven: a signature that did not check out is answered the way any other
        // unproven caller is, under the actor a proven one would be recorded under.
        await note('system', { action: 'passkey.use', subject: stored.id, outcome: 'refused', detail: verified.reason });
        return refused();
      }

      await identity.passkeys.used(context, stored.id, verified.value.counter);
      await recorded(request, 'the sign-in gate could not forgive a scope', () => identity.attempts.forgiven(gate, asked));
      const opened = await sessions.start(sessionContext(correlation), { actor: actorFor(stored.account), permissions: [] });
      await note(actorFor(stored.account), { action: 'passkey.use', subject: stored.id, outcome: 'allowed' });
      return reply
        .code(201)
        .header('set-cookie', sessionCookie(opened.token, COOKIE_SECONDS))
        .send(successEnvelope(opened.record, request.id, CLIENT_WINDOW.current));
    }

    // Graded only for its ceilings, so a megabyte never reaches a slow hash. Anything the grading refuses
    // is refused as a sign-in, because a validation problem is the cheapest answer of all to ask for.
    const credentials = parseSignIn(request.body);
    if (!credentials.ok) return refused();

    // The handle that was asked for, not an account that was found: a handle nobody holds locks like any
    // other, which is what stops the lock from answering whether anybody holds it.
    const asked = accountScope(credentials.value.name);
    if (await identity.attempts.locked(gate, asked)) return refused();

    /** One refusal, whichever half of the sign-in was wrong. What differs is written down, not answered. */
    const denied = async (actor: string, subject: string, detail: string): Promise<FastifyReply> => {
      await recorded(request, 'the sign-in gate could not count a failure', async () => {
        if (await identity.attempts.failed(gate, asked)) {
          await note('system', {
            action: 'session.lock',
            subject: asked,
            outcome: 'refused',
            detail: 'too many attempts have been made on this handle',
          });
        }
      });
      await note(actor, { action: 'session.signIn', subject, outcome: 'refused', detail });
      return refused();
    };

    const account = await identity.accounts.authenticate(accountContext(correlation), credentials.value);
    if (account === undefined) {
      return denied('system', credentials.value.name, 'the handle or the password was wrong');
    }

    // Asked only once the password is this account's, which is the one thing that makes the extra read
    // safe to make: a caller guessing handles never gets this far, so the read tells them nothing. What
    // comes back says whether anything is owed and whether what was typed settles it, in one answer, so
    // no separate question is asked that could say by its cost alone that this account owes a factor.
    const second = await identity.totp.satisfied(totpContext(correlation), account.id, credentials.value.code ?? '');
    if (second === 'refused') {
      // Counted on the same scope a wrong password is: a password that has leaked is exactly what puts a
      // second factor under a guessing attack, and the gate is what makes guessing it cost something.
      return denied(actorFor(account.id), account.name, 'the second factor was wrong, or was not given');
    }
    if (second === 'accepted') {
      await note(actorFor(account.id), { action: 'totp.use', subject: actorFor(account.id), outcome: 'allowed' });
    }

    await recorded(request, 'the sign-in gate could not forgive a scope', () =>
      identity.attempts.forgiven(gate, asked),
    );
    // What the operator may do is not granted here: a session says who, and the roles this server
    // enforces say what. Granting nothing is the safe half of not knowing yet.
    const opened = await sessions.start(sessionContext(correlation), { actor: actorFor(account.id), permissions: [] });
    await note(actorFor(account.id), { action: 'session.signIn', subject: account.name, outcome: 'allowed' });
    return reply
      .code(201)
      .header('set-cookie', sessionCookie(opened.token, COOKIE_SECONDS))
      .send(successEnvelope(opened.record, request.id, CLIENT_WINDOW.current));
  });

  // Safe, and so not behind the guard, which is why it reads the session for itself. It answers what a
  // client needs to render an operator and to return a token with — never the identifier itself.
  app.get(SESSION_PATH, async (request, reply) => {
    const proven = await sessionFor(sessions, request, reply);
    if (proven === undefined) return reply;
    return successEnvelope(proven.record, request.id, CLIENT_WINDOW.current);
  });

  app.delete(SESSION_PATH, async (request, reply) => {
    const proven = provenSession(request);
    const ended = await proven.sessions.revoke(sessionCallFor(request), proven.token);
    return reply
      .header('set-cookie', clearedSessionCookie())
      .send(successEnvelope({ ended }, request.id, CLIENT_WINDOW.current));
  });

  app.post(TICKET_PATH, async (request) => {
    const proven = provenSession(request);
    const ticket = await proven.sessions.issueTicket(sessionCallFor(request), proven.token);
    return successEnvelope({ ticket, expiresInSeconds: TICKET_SECONDS }, request.id, CLIENT_WINDOW.current);
  });
}
