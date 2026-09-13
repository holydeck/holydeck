// What a client is told when the fault is this server's.
//
// Fastify's own handler answers with the message the error carried, which is how a connection string, a
// credential or a token reaches a browser and a proxy log along the way. This replaces it with
// one stable code and one sentence, and leaves the detail in the log where an operator can read it.

import { UNEXPECTED_ERROR, errorEnvelope } from '@holydeck/contracts/http';

import type { ErrorEnvelope } from '@holydeck/contracts/http';
import type { FastifyInstance } from 'fastify';

/** Deliberately says nothing about the fault: what a client can do about it is the same either way. */
export const UNEXPECTED_MESSAGE = 'The request could not be completed.';

export const unexpectedFailure = (requestId: string): ErrorEnvelope =>
  errorEnvelope(UNEXPECTED_ERROR, UNEXPECTED_MESSAGE, requestId);

/** Installs the handler. Called before routes, so nothing registered later can answer with its own. */
export function withSafeErrors(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    return reply.code(500).send(unexpectedFailure(request.id));
  });
}
