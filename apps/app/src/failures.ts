// What a client is told when the fault is this server's.
//
// Fastify's own handler answers with the message the error carried, which is how a connection string, a
// credential or a token reaches a browser and a proxy log along the way. This replaces it with
// one stable code and one sentence, and leaves the detail in the log where an operator can read it.
//
// There is one way to get the detail back into the answer, and it is deliberately hard to reach: the
// `developmentDiagnostics` setting, which `settings.ts` refuses to read from the settings file and will
// take only from this deployment's own environment. Holding the permission that manages settings is
// therefore not enough to turn it on — reaching the machine is.

import { NOT_FOUND, UNEXPECTED_ERROR, errorEnvelope } from '@holydeck/contracts/http';

import type { ErrorDiagnostics, ErrorEnvelope } from '@holydeck/contracts/http';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Deliberately says nothing about the fault: what a client can do about it is the same either way. */
export const UNEXPECTED_MESSAGE = 'The request could not be completed.';

export const unexpectedFailure = (requestId: string): ErrorEnvelope =>
  errorEnvelope(UNEXPECTED_ERROR, UNEXPECTED_MESSAGE, requestId);

export { NOT_FOUND };

/**
 * A path this server does not serve. Shared rather than written twice, because a route that closes —
 * onboarding, once the instance is claimed — has to be indistinguishable from a path that was never
 * there: a different message, or a different code, would answer the question the closed route refuses.
 */
export const notFound = (request: Pick<FastifyRequest, 'id' | 'method' | 'url'>): ErrorEnvelope =>
  errorEnvelope(NOT_FOUND, `${request.method} ${request.url} is not a path this server serves.`, request.id);

export interface SafeErrorOptions {
  /**
   * Whether an answer may carry what was actually thrown, as `ErrorEnvelope.error.diagnostics`.
   *
   * Absent means no, and absent is how every caller but `app.ts` installs this. Turning it on is a
   * decision only a deployment can make — see `PROTECTED_SETTINGS` in `settings.ts` — because the detail
   * it adds is the detail the handler below exists to keep out of a response.
   */
  readonly diagnostics?: boolean;
}

/** What was thrown, for the one deployment that asked. A stack is only present where there was one:
 *  anything at all can be thrown in JavaScript, and libraries throw strings. */
const diagnosticsOf = (error: unknown): ErrorDiagnostics => {
  if (!(error instanceof Error)) return { message: String(error) };
  return error.stack === undefined ? { message: error.message } : { message: error.message, stack: error.stack };
};

/**
 * Installs the handler. Called before routes, so nothing registered later can answer with its own.
 *
 * The code, the sentence and the request identifier are the same either way: a client never has to
 * behave differently against a deployment with diagnostics on, and a deployment with them off answers
 * an envelope with no trace of the setting in it — not even an emptied key, which would itself say
 * which deployments have it available.
 */
export function withSafeErrors(app: FastifyInstance, options: SafeErrorOptions = {}): void {
  const { diagnostics = false } = options;
  app.setErrorHandler((error, request, reply) => {
    // Logged first and always. Whichever way the answer goes, this is where the detail belongs, and
    // turning diagnostics off must never be the reason a fault went unrecorded.
    request.log.error(error);
    const failure = unexpectedFailure(request.id);
    if (!diagnostics) return reply.code(500).send(failure);
    return reply.code(500).send({ error: { ...failure.error, diagnostics: diagnosticsOf(error) } });
  });
}
