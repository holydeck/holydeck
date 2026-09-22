// Where the content-language registry is administered (spec LANG-01, SEED-01).
//
// Shaped like `slide-layout-routes.ts` minus boxes and revisions: one CRUD surface, one status toggle.
// `/catalogue` is gated narrower than the rest — `content.edit`, not `catalogue.manage` — because it is
// what a language picker reads from, not what the registry is administered through.
//
// Archiving a language in use is not refused here: the store itself has no such rule (see its own
// header comment), by design — every language block already keyed to an archived language keeps
// resolving, so there is nothing here for an in-use check to protect.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import {
  CONTENT_LANGUAGES_PATH,
  parseContentLanguageCreate,
  parseContentLanguageDraft,
  parseContentLanguageStatus,
} from '@holydeck/contracts/content-languages';

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { settled } from './refusals.js';
import { CATALOGUE_MANAGE, CONTENT_EDIT } from './roles.js';
import { ContentLanguageError, contentLanguageContext, subjectFor } from './content-languages.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { ContentLanguageStore } from './content-languages.js';
import type { Identity } from './onboarding.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const CONTENT_LANGUAGE_PREFIX = 'contentLanguage:';

export const CONTENT_LANGUAGE_KEY_PATH = `${CONTENT_LANGUAGES_PATH}/:key`;
export const CONTENT_LANGUAGE_STATUS_PATH = `${CONTENT_LANGUAGE_KEY_PATH}/status`;
export const CONTENT_LANGUAGE_CATALOGUE_PATH = `${CONTENT_LANGUAGES_PATH}/catalogue`;

const PERMISSION: RouteNeed = { kind: 'permission', need: CATALOGUE_MANAGE };
const CATALOGUE_PERMISSION: RouteNeed = { kind: 'permission', need: CONTENT_EDIT };

const ROUTES = [
  ['GET', CONTENT_LANGUAGES_PATH],
  ['POST', CONTENT_LANGUAGES_PATH],
  ['GET', CONTENT_LANGUAGE_CATALOGUE_PATH],
  ['GET', CONTENT_LANGUAGE_KEY_PATH],
  ['PUT', CONTENT_LANGUAGE_KEY_PATH],
  ['PATCH', CONTENT_LANGUAGE_STATUS_PATH],
] as const;

const keyIn = (request: FastifyRequest): string => (request.params as { readonly key: string }).key;

const isRefusal = (error: unknown): error is ContentLanguageError & { kind: 'state' | 'conflict' } =>
  error instanceof ContentLanguageError && (error.kind === 'state' || error.kind === 'conflict');

export interface ContentLanguageRoutesOptions {
  readonly contentLanguages: ContentLanguageStore | undefined;
  readonly identity: Identity | undefined;
}

export function serveContentLanguageRoutes(
  app: FastifyInstance,
  { contentLanguages, identity }: ContentLanguageRoutesOptions,
): void {
  if (identity === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({
        method,
        url,
        config: { need: PERMISSION },
        handler: (request, reply) => reply.code(404).send(notFound(request)),
      });
    }
    return;
  }
  const languages = contentLanguages as ContentLanguageStore;
  const call = (request: FastifyRequest) =>
    contentLanguageContext(provenSession(request).record.actor, correlationFor(CONTENT_LANGUAGE_PREFIX, request.id));

  const note = async (request: FastifyRequest, key: string, outcome: AuditOutcome, detail: string): Promise<void> => {
    try {
      await identity.audit.record(
        auditContext(provenSession(request).record.actor, correlationFor(CONTENT_LANGUAGE_PREFIX, request.id)),
        { action: 'content.change', subject: subjectFor(key), outcome, detail },
      );
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the content language trail refused an entry');
    }
  };

  app.get(CONTENT_LANGUAGES_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const items = await languages.list(call(request));
    return reply.send(successEnvelope(items, request.id, CLIENT_WINDOW.current));
  });

  app.post(CONTENT_LANGUAGES_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseContentLanguageCreate(request.body, 'contentLanguage');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const { key, ...draft } = parsed.value;
    const answer = await settled(() => languages.create(call(request), key, draft), isRefusal);
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    await note(request, key, 'allowed', 'created');
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(CONTENT_LANGUAGE_CATALOGUE_PATH, { config: { need: CATALOGUE_PERMISSION } }, async (request, reply) => {
    const items = await languages.catalogue(call(request));
    return reply.send(successEnvelope(items, request.id, CLIENT_WINDOW.current));
  });

  app.get(CONTENT_LANGUAGE_KEY_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const item = await languages.get(call(request), keyIn(request));
    if (item === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(item, request.id, CLIENT_WINDOW.current));
  });

  app.put(CONTENT_LANGUAGE_KEY_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseContentLanguageDraft(request.body, 'contentLanguage');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const key = keyIn(request);
    const answer = await settled(() => languages.edit(call(request), key, parsed.value), isRefusal);
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, key, 'allowed', 'edited');
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.patch(CONTENT_LANGUAGE_STATUS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseContentLanguageStatus(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const key = keyIn(request);
    const context = call(request);
    const answer = await settled(
      () => (parsed.value.archived ? languages.archive(context, key) : languages.unarchive(context, key)),
      isRefusal,
    );
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, key, 'allowed', parsed.value.archived ? 'archived' : 'brought back');
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });
}
