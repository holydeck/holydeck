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

import { accountIdIn, actorFor, parseSignIn } from '@holydeck/contracts/accounts';
import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { SIGN_IN_REFUSED } from '@holydeck/contracts/sessions';
export { SIGN_IN_REFUSED } from '@holydeck/contracts/sessions';
import {
  SESSION_ABSOLUTE_HOURS,
  SESSION_COOKIE,
  SESSION_PATH,
  TICKET_PATH,
  TICKET_SECONDS,
  clearedSessionCookie,
  cookieIn,
  isSameOrigin,
  sessionCookie,
} from '@holydeck/contracts/sessions';
import { isPasskeySignIn, parsePasskeySignIn } from '@holydeck/contracts/webauthn';

import { accountContext } from './accounts.js';
import { accountScope, addressScope, attemptContext } from './attempts.js';
import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { originOf, provenSession, refuseAsForbidden, refuseAsStoreSaid, sessionCallFor } from './csrf.js';
import { passkeyContext } from './passkeys.js';
import { permissionsFor } from './roles.js';
import { SessionError, sessionContext } from './sessions.js';
import { totpContext } from './totp.js';
import { authenticationOptions, challengeIn, verifiedAssertion } from './webauthn.js';

import type { AuditEntry, AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { SessionStore } from './sessions.js';
import type { RelyingParty } from './webauthn.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const PUBLIC: RouteNeed = { kind: 'public' };

const SESSION: RouteNeed = { kind: 'session' };

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
  app.post(SESSION_PATH, { config: { need: PUBLIC } }, async (request, reply) => {
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
    // Read once, before either branch: a live container is joined by a new slot rather than replaced, so
    // an operator already signed in elsewhere in this browser keeps that slot when signing in as another.
    const join = cookieIn(request.headers.cookie, SESSION_COOKIE);
    const note = (actor: string, entry: AuditEntry): Promise<void> =>
      recorded(request, 'the sign-in trail refused an entry', async () => {
        await identity.audit.record(auditContext(actor, correlation), entry);
      });
    const notedJoin = (opened: { readonly joined: boolean }, actor: string): Promise<void> =>
      opened.joined
        ? note(actor, { action: 'session.slot.add', subject: actor, outcome: 'allowed' })
        : Promise.resolve();

    // The handle gate below cannot see a caller working through a list of handles: a hundred handles
    // guessed once each never reaches any one handle's threshold. So the caller is gated too, by where it
    // is speaking from, on a far looser threshold — the two are asked together and neither stands in for
    // the other. The scope is a digest of the address rather than the address itself, so the ledger and
    // the trail it writes hold no record of who connected from where.
    const from = addressScope(request.ip);
    if (await identity.attempts.locked(gate, from)) return refused();

    /**
     * Charges a refusal that cost this server real work to the address it came from. Only refusals that
     * reached a credential are charged: a body that failed its grading never got far enough to be a guess.
     * Nothing forgives this scope, unlike the handle's — a caller who guesses their way to one success
     * must not buy a fresh run of guesses with it, and the threshold is set high enough that an office
     * or a household behind one address never reaches it by signing in the way people actually do.
     */
    const chargeAddress = (): Promise<void> =>
      recorded(request, 'the sign-in gate could not count a failure against an address', async () => {
        if (await identity.attempts.failed(gate, from)) {
          await note('system', {
            action: 'session.lock',
            subject: from,
            outcome: 'refused',
            detail: 'too many attempts have been made from this address',
          });
        }
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
        await chargeAddress();
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
        // Charged to the address and to nothing else: there is no handle to charge, which is exactly the
        // gap a caller working through stolen credential identifiers would otherwise sit in forever.
        await chargeAddress();
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
        await chargeAddress();
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

      // Proven is not the same as permitted. The password path gets this refusal from `authenticate`,
      // which reads a disabled account back as nobody; the key path looks the account up itself, so the
      // same refusal is made here rather than inside `read`, which every other caller needs to hand back
      // a disabled account exactly as it stands. Asked after the signature, so a disabled handle costs a
      // caller the same work a live one does and tells them nothing by answering faster.
      if (account.disabled) {
        await chargeAddress();
        await note('system', {
          action: 'passkey.use',
          subject: stored.id,
          outcome: 'refused',
          detail: 'the account this key was registered to is disabled',
        });
        return refused();
      }

      await identity.passkeys.used(context, stored.id, verified.value.counter);
      await recorded(request, 'the sign-in gate could not forgive a scope', () => identity.attempts.forgiven(gate, asked));
      const opened = await sessions.start(
        sessionContext(correlation),
        { actor: actorFor(stored.account), permissions: permissionsFor(account) },
        join,
      );
      await notedJoin(opened, actorFor(stored.account));
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
      await chargeAddress();
      await recorded(request, 'the sign-in gate could not count a failure', async () => {
        if (await identity.attempts.failed(gate, asked)) {
          await note(actor, {
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
    // What the operator may do is granted from the account this session was opened for, the same way a
    // passkey sign-in above grants it: by the roles this server enforces, not by what a client claims.
    const opened = await sessions.start(
      sessionContext(correlation),
      { actor: actorFor(account.id), permissions: permissionsFor(account) },
      join,
    );
    await notedJoin(opened, actorFor(account.id));
    await note(actorFor(account.id), { action: 'session.signIn', subject: account.name, outcome: 'allowed' });
    return reply
      .code(201)
      .header('set-cookie', sessionCookie(opened.token, COOKIE_SECONDS))
      .send(successEnvelope(opened.record, request.id, CLIENT_WINDOW.current));
  });

  // Safe, and so not behind the guard, which is why the authorization check proves the session in its
  // place. It answers what a client needs to render an operator and to return a token with — never the
  // identifier itself — plus every slot the container holds, redacted to what another slot may be told.
  app.get(SESSION_PATH, { config: { need: SESSION } }, async (request) => {
    const proven = provenSession(request);
    const slots = await proven.sessions.slots(sessionCallFor(request), proven.token);
    const id = accountIdIn(proven.record.actor);
    const account = identity === undefined || id === undefined
      ? undefined
      : await identity.accounts.read(accountContext(correlationFor(SIGN_IN_PREFIX, request.id)), id);
    return successEnvelope({
      ...proven.record,
      slots,
      ...(account === undefined
        ? {}
        : {
            account: {
              id: account.id,
              name: account.name,
              displayName: account.displayName,
              role: account.role,
              controlPresentation: account.controlPresentation,
            },
          }),
    }, request.id, CLIENT_WINDOW.current);
  });

  app.delete(SESSION_PATH, { config: { need: SESSION } }, async (request, reply) => {
    const proven = provenSession(request);
    const ended = await proven.sessions.revoke(sessionCallFor(request), proven.token);
    return reply
      .header('set-cookie', clearedSessionCookie())
      .send(successEnvelope({ ended }, request.id, CLIENT_WINDOW.current));
  });

  // The one mutation `guardMutations` proves before this runs: a switch changes nothing but the container's
  // own pointer, and only among slots it already holds, so no cookie is set and none is cleared either way.
  app.patch(SESSION_PATH, { config: { need: SESSION } }, async (request, reply) => {
    const proven = provenSession(request);
    const body = request.body as { readonly active?: unknown } | undefined;
    const active = typeof body?.active === 'string' ? body.active : '';
    const correlation = correlationFor('switch:', request.id);
    const note = (subject: string, outcome: AuditOutcome): Promise<void> =>
      recorded(request, 'the slot-switch trail refused an entry', async () => {
        if (identity !== undefined) {
          await identity.audit.record(auditContext(proven.record.actor, correlation), {
            action: 'session.slot.switch',
            subject,
            outcome,
          });
        }
      });
    try {
      const record = await proven.sessions.activate(sessionCallFor(request), proven.token, active);
      await note(record.actor, 'allowed');
      return reply.send(successEnvelope(record, request.id, CLIENT_WINDOW.current));
    } catch (error: unknown) {
      if (error instanceof SessionError && error.kind === 'slot') {
        await note(active, 'refused');
        await refuseAsForbidden(request, reply, 'active', 'no slot with that identifier in this session');
        return reply;
      }
      await refuseAsStoreSaid(request, reply, error, 'this session is over, or was never one this server issued');
      return reply;
    }
  });

  app.post(TICKET_PATH, { config: { need: SESSION } }, async (request) => {
    const proven = provenSession(request);
    const ticket = await proven.sessions.issueTicket(sessionCallFor(request), proven.token);
    return successEnvelope({ ticket, expiresInSeconds: TICKET_SECONDS }, request.id, CLIENT_WINDOW.current);
  });
}
