// The surface an operator's own session is read and ended through, and the one place a socket ticket is
// issued. Signing in is not here: an account to sign in as does not exist yet, and the route that makes
// one is the task that owns accounts. What is here is everything a session can do once it exists.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope } from '@holydeck/contracts/http';
import { TICKET_SECONDS, clearedSessionCookie } from '@holydeck/contracts/sessions';

import { provenSession, sessionCallFor, sessionFor } from './csrf.js';

import type { FastifyInstance } from 'fastify';
import type { SessionStore } from './sessions.js';

export const SESSION_PATH = '/api/v1/session';

/** A ticket is a change: it is issued once, spends the session's own standing, and is then gone. */
export const TICKET_PATH = '/api/v1/live/ticket';

export interface SessionRoutesOptions {
  /** Absent in a deployment that keeps no sessions; the surface is served either way, and refuses. */
  readonly sessions: SessionStore | undefined;
}

export function serveSessionRoutes(app: FastifyInstance, { sessions }: SessionRoutesOptions): void {
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
