import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { FIELD_CODES } from '@holydeck/contracts/problems';
import { SERMONS_PATH, parseSermonGenerationRequest } from '@holydeck/contracts/sermons';

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { staleRevision } from './refusals.js';
import { CONTENT_EDIT } from './roles.js';
import { SERMON_PATH, parseSermonDraft, parseSermonEdit } from './sermon-body.js';
import { sermonStoreFilesFromCorpus } from './sermon-corpus.js';
import { SermonError, sermonContext, subjectFor } from './sermons.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { corpusClient } from './corpus.js';
import type { Identity } from './onboarding.js';
import type { SermonRefusal, SermonStore } from './sermons.js';
import type { LocatedProblem } from './sermon-yaml.js';
import type { TranslationStoreFile } from '@holydeck/core/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const SERMON_PREFIX = 'sermon:';

export const SERMON_ID_PATH = `${SERMONS_PATH}/:id`;
const SERMON_RAW_PATH = `${SERMON_ID_PATH}/raw`;
const SERMON_HISTORY_PATH = `${SERMON_ID_PATH}/history`;
const SERMON_SLIDES_PATH = `${SERMON_ID_PATH}/slides`;
const ROUTES = [
  ['POST', SERMONS_PATH], ['GET', SERMON_ID_PATH], ['PUT', SERMON_ID_PATH],
  ['GET', SERMON_RAW_PATH], ['PUT', SERMON_RAW_PATH],
  ['GET', SERMON_HISTORY_PATH], ['POST', SERMON_SLIDES_PATH],
] as const;

const PERMISSION: RouteNeed = { kind: 'permission', need: CONTENT_EDIT };
const ORDINAL = /^[1-9][0-9]*$/u;
const ordinalIn = (value: unknown): number | undefined =>
  typeof value === 'string' && ORDINAL.test(value) ? Number(value) : undefined;
const NOT_AN_ORDINAL = [
  { path: 'revision', code: FIELD_CODES.notANumber, message: 'must be an ordinal counting from one' },
];
const expectedRevisionProblem = (asked: string | undefined): readonly LocatedProblem[] => [{
  path: 'expectedRevision',
  code: asked === undefined ? FIELD_CODES.required : FIELD_CODES.notANumber,
  message: asked === undefined ? 'is required' : 'must be an ordinal counting from one',
}];
const idIn = (request: FastifyRequest): string => (request.params as { readonly id: string }).id;

type SermonFailure = {
  readonly ok: false;
  readonly kind: Exclude<SermonRefusal, 'corrupt'>;
  readonly message: string;
  readonly problems: readonly LocatedProblem[];
};
type SermonAnswer<T> = { readonly ok: true; readonly value: T } | SermonFailure;

async function settled<T>(work: () => Promise<T>): Promise<SermonAnswer<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof SermonError && error.kind !== 'corrupt') {
      return { ok: false, kind: error.kind, message: error.message, problems: error.problems };
    }
    throw error;
  }
}

function refused(request: FastifyRequest, reply: FastifyReply, answer: SermonFailure): FastifyReply {
  if (answer.kind === 'schema') {
    const problems = answer.problems.length > 0
      ? answer.problems
      : [{ path: SERMON_PATH, code: FIELD_CODES.notAnObject, message: answer.message }];
    return reply.code(422).send(validationFailure(request.id, problems));
  }
  if (answer.kind === 'permission') return reply.code(403).send(errorEnvelope('auth.forbidden', answer.message, request.id));
  return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
}

export interface SermonRoutesOptions {
  readonly sermons: SermonStore | undefined;
  readonly corpus: ReturnType<typeof corpusClient>;
  readonly identity: Identity | undefined;
}

export function serveSermonRoutes(app: FastifyInstance, { sermons, corpus, identity }: SermonRoutesOptions): void {
  if (identity === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({ method, url, config: { need: PERMISSION }, handler: (request, reply) => reply.code(404).send(notFound(request)) });
    }
    return;
  }

  const store = sermons as SermonStore;
  const call = (request: FastifyRequest) =>
    sermonContext(provenSession(request).record.actor, correlationFor(SERMON_PREFIX, request.id));
  const note = async (request: FastifyRequest, id: string, outcome: AuditOutcome, detail: string): Promise<void> => {
    try {
      await identity.audit.record(
        auditContext(provenSession(request).record.actor, correlationFor(SERMON_PREFIX, request.id)),
        { action: 'content.change', subject: subjectFor(id), outcome, detail },
      );
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the sermon trail refused an entry');
    }
  };

  app.post(SERMONS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSermonDraft(request.body, SERMON_PATH);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() => store.create(call(request), parsed.value.title, parsed.value.body));
    if (!answer.ok) return refused(request, reply, answer);
    await note(request, answer.value.stamp.id, 'allowed', 'created');
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERMON_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const asked = (request.query as { readonly revision?: string }).revision;
    const revision = ordinalIn(asked);
    if (asked !== undefined && revision === undefined) return reply.code(422).send(validationFailure(request.id, NOT_AN_ORDINAL));
    const current = await store.current(call(request), idIn(request), revision);
    if (current === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(current, request.id, CLIENT_WINDOW.current));
  });

  app.put(SERMON_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSermonEdit(request.body, SERMON_PATH);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const context = call(request);
    const current = await store.current(context, id);
    if (current === undefined) return reply.code(404).send(notFound(request));
    const stale = staleRevision(id, parsed.value.expectedRevision, current.revision);
    if (stale !== undefined) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, stale, request.id));
    const answer = await settled(() => store.edit(context, id, parsed.value.body));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', `saved revision ${answer.value.revision}`);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERMON_RAW_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const asked = (request.query as { readonly revision?: string }).revision;
    const revision = ordinalIn(asked);
    if (asked !== undefined && revision === undefined) return reply.code(422).send(validationFailure(request.id, NOT_AN_ORDINAL));
    const text = await store.raw(call(request), idIn(request), revision);
    if (text === undefined) return reply.code(404).send(notFound(request));
    return reply.type('text/yaml').send(text);
  });

  app.put(SERMON_RAW_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    if (typeof request.body !== 'string') {
      return reply.code(422).send(validationFailure(request.id, [{ path: 'body', code: FIELD_CODES.notText, message: 'must be sent as text' }]));
    }
    const asked = (request.query as { readonly expectedRevision?: string }).expectedRevision;
    const expectedRevision = ordinalIn(asked);
    if (expectedRevision === undefined) return reply.code(422).send(validationFailure(request.id, expectedRevisionProblem(asked)));
    const id = idIn(request);
    const context = call(request);
    const current = await store.current(context, id);
    if (current === undefined) return reply.code(404).send(notFound(request));
    const stale = staleRevision(id, expectedRevision, current.revision);
    if (stale !== undefined) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, stale, request.id));
    const answer = await settled(() => store.editRaw(context, id, request.body as string));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', `saved raw revision ${answer.value.revision}`);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERMON_HISTORY_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const history = await store.history(call(request), idIn(request));
    if (history.length === 0) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(history, request.id, CLIENT_WINDOW.current));
  });

  app.post(SERMON_SLIDES_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSermonGenerationRequest(request.body, SERMON_PATH);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const context = call(request);
    const source = await store.current(context, id, parsed.value.sermonRevision);
    let storeFiles: Record<string, TranslationStoreFile | undefined> = {};
    if (source !== undefined) {
      const built = await sermonStoreFilesFromCorpus(corpus, source.body.sermon);
      if (!built.ok) return reply.code(built.refusal.status).send(errorEnvelope(built.refusal.code, built.refusal.message, request.id));
      storeFiles = built.value;
    }
    const answer = await settled(() => store.generate(context, id, { ...parsed.value, storeFiles }));
    if (!answer.ok) return refused(request, reply, answer);
    await note(request, id, 'allowed', 'generated slides');
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });
}
