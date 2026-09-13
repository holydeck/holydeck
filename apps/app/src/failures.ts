// What a client is told when the fault is this server's.
//
// Fastify's own handler answers with the message the error carried, which is how a connection string, a
// credential or a token reaches a browser and a proxy log along the way. This replaces it with
// one stable code and one sentence, and leaves the detail in the log where an operator can read it.

import { UNEXPECTED_ERROR, errorEnvelope } from '@holydeck/contracts/http';

import type { ErrorEnvelope } from '@holydeck/contracts/http';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Deliberately says nothing about the fault: what a client can do about it is the same either way. */
export const UNEXPECTED_MESSAGE = 'The request could not be completed.';

export const unexpectedFailure = (requestId: string): ErrorEnvelope =>
  errorEnvelope(UNEXPECTED_ERROR, UNEXPECTED_MESSAGE, requestId);

export const NOT_FOUND = 'resource.not_found';

/**
 * A path this server does not serve. Shared rather than written twice, because a route that closes —
 * onboarding, once the instance is claimed — has to be indistinguishable from a path that was never
 * there: a different message, or a different code, would answer the question the closed route refuses.
 */
export const notFound = (request: Pick<FastifyRequest, 'id' | 'method' | 'url'>): ErrorEnvelope =>
  errorEnvelope(NOT_FOUND, `${request.method} ${request.url} is not a path this server serves.`, request.id);

/** Installs the handler. Called before routes, so nothing registered later can answer with its own. */
export function withSafeErrors(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    return reply.code(500).send(unexpectedFailure(request.id));
  });
}
