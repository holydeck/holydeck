import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { FIELD_CODES } from '@holydeck/contracts/problems';
import { SERMON_IMPORT_PREVIEW_PATH, parseSermonImportRequest } from '@holydeck/contracts/sermon-import';
import { SERMONS_PATH, parseSermonGenerationRequest } from '@holydeck/contracts/sermons';
import { generateSermonFromText } from '@holydeck/core/sermon-ai';

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { settled } from './refusals.js';
import { CONTENT_EDIT, SERVICES_MANAGE } from './roles.js';
import { SERMON_PATH, parseSermonDraft, parseSermonEdit } from './sermon-body.js';
import { sermonStoreFilesFromCorpus } from './sermon-corpus.js';
import { SermonError, sermonContext, subjectFor } from './sermons.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { corpusClient } from './corpus.js';
import type { Identity } from './onboarding.js';
import type { Answer } from './refusals.js';
import type { SermonRefusal, SermonStore } from './sermons.js';
import type { LocatedProblem } from './sermon-yaml.js';
import type { HttpPost } from '@holydeck/core/anthropic';
import type { TranslationStoreFile } from '@holydeck/core/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const SERMON_PREFIX = 'sermon:';

export const SERMON_ID_PATH = `${SERMONS_PATH}/:id`;
const SERMON_RAW_PATH = `${SERMON_ID_PATH}/raw`;
const SERMON_HISTORY_PATH = `${SERMON_ID_PATH}/history`;
const SERMON_SLIDES_PATH = `${SERMON_ID_PATH}/slides`;
const CONTENT_PERMISSION: RouteNeed = { kind: 'permission', need: CONTENT_EDIT };
const IMPORT_PERMISSION: RouteNeed = { kind: 'permission', need: SERVICES_MANAGE };
const ROUTES = [
  ['POST', SERMONS_PATH, CONTENT_PERMISSION], ['GET', SERMON_ID_PATH, CONTENT_PERMISSION],
  ['PUT', SERMON_ID_PATH, CONTENT_PERMISSION],
  ['GET', SERMON_RAW_PATH, CONTENT_PERMISSION], ['PUT', SERMON_RAW_PATH, CONTENT_PERMISSION],
  ['GET', SERMON_HISTORY_PATH, CONTENT_PERMISSION], ['POST', SERMON_SLIDES_PATH, CONTENT_PERMISSION],
  ['POST', SERMON_IMPORT_PREVIEW_PATH, IMPORT_PERMISSION],
] as const;
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

type SermonRefused = Exclude<SermonRefusal, 'corrupt'>;
type SermonFailure = Extract<Answer<unknown, SermonRefused>, { readonly ok: false }>;

const isSermonRefusal = (error: unknown): error is SermonError & { readonly kind: SermonRefused } =>
  error instanceof SermonError && error.kind !== 'corrupt';

function refused(request: FastifyRequest, reply: FastifyReply, answer: SermonFailure): FastifyReply {
  if (answer.kind === 'schema') {
    const problems = answer.problems !== undefined && answer.problems.length > 0
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
  /** Bare ANTHROPIC_API_KEY, optional, never logged — absent disables the resolver. */
  readonly anthropicApiKey?: string | undefined;
  /** Test-only override for the resolver's HTTP client; production never sets this (core defaults to real fetch). */
  readonly httpPost?: HttpPost | undefined;
}

export function serveSermonRoutes(
  app: FastifyInstance,
  { sermons, corpus, identity, anthropicApiKey, httpPost }: SermonRoutesOptions,
): void {
  if (identity === undefined) {
    for (const [method, url, need] of ROUTES) {
      app.route({ method, url, config: { need }, handler: (request, reply) => reply.code(404).send(notFound(request)) });
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

  app.post(SERMONS_PATH, { config: { need: CONTENT_PERMISSION } }, async (request, reply) => {
    const parsed = parseSermonDraft(request.body, SERMON_PATH);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() => store.create(call(request), parsed.value.title, parsed.value.body), isSermonRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    await note(request, answer.value.stamp.id, 'allowed', 'created');
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERMON_ID_PATH, { config: { need: CONTENT_PERMISSION } }, async (request, reply) => {
    const asked = (request.query as { readonly revision?: string }).revision;
    const revision = ordinalIn(asked);
    if (asked !== undefined && revision === undefined) return reply.code(422).send(validationFailure(request.id, NOT_AN_ORDINAL));
    const current = await store.current(call(request), idIn(request), revision);
    if (current === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(current, request.id, CLIENT_WINDOW.current));
  });

  app.put(SERMON_ID_PATH, { config: { need: CONTENT_PERMISSION } }, async (request, reply) => {
    const parsed = parseSermonEdit(request.body, SERMON_PATH);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    // Checked by the save itself, which shelves a stale body for the conflict banner (COLAB-02).
    const answer = await settled(() => store.edit(call(request), id, parsed.value.body, parsed.value.expectedRevision), isSermonRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', `saved revision ${answer.value.revision}`);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERMON_RAW_PATH, { config: { need: CONTENT_PERMISSION } }, async (request, reply) => {
    const asked = (request.query as { readonly revision?: string }).revision;
    const revision = ordinalIn(asked);
    if (asked !== undefined && revision === undefined) return reply.code(422).send(validationFailure(request.id, NOT_AN_ORDINAL));
    const text = await store.raw(call(request), idIn(request), revision);
    if (text === undefined) return reply.code(404).send(notFound(request));
    return reply.type('text/yaml').send(text);
  });

  app.put(SERMON_RAW_PATH, { config: { need: CONTENT_PERMISSION } }, async (request, reply) => {
    if (typeof request.body !== 'string') {
      return reply.code(422).send(validationFailure(request.id, [{ path: 'body', code: FIELD_CODES.notText, message: 'must be sent as text' }]));
    }
    const asked = (request.query as { readonly expectedRevision?: string }).expectedRevision;
    const expectedRevision = ordinalIn(asked);
    if (expectedRevision === undefined) return reply.code(422).send(validationFailure(request.id, expectedRevisionProblem(asked)));
    const id = idIn(request);
    const answer = await settled(() => store.editRaw(call(request), id, request.body as string, expectedRevision), isSermonRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', `saved raw revision ${answer.value.revision}`);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERMON_HISTORY_PATH, { config: { need: CONTENT_PERMISSION } }, async (request, reply) => {
    const history = await store.history(call(request), idIn(request));
    if (history.length === 0) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(history, request.id, CLIENT_WINDOW.current));
  });

  app.post(SERMON_SLIDES_PATH, { config: { need: CONTENT_PERMISSION } }, async (request, reply) => {
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
    const answer = await settled(() => store.generate(context, id, { ...parsed.value, storeFiles }), isSermonRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    await note(request, id, 'allowed', 'generated slides');
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  // Per-account, per-process throttle on the preview: nothing else in this build needs a shared rate
  // limit store, and a pastor pasting the same message ten times inside a minute is already unusual.
  const previewLimiter = new Map<string, { count: number; windowStart: number }>();
  const PREVIEW_WINDOW_MS = 60_000;
  const PREVIEW_LIMIT = 10;

  // Every request's own window has already expired by the time this runs again a minute later, so
  // sweeping it here keeps the map bounded by actors active in the last window, not every actor ever.
  const pruneExpiredPreviewWindows = (now: number): void => {
    for (const [actor, window] of previewLimiter) {
      if (now - window.windowStart >= PREVIEW_WINDOW_MS) previewLimiter.delete(actor);
    }
  };

  app.post(SERMON_IMPORT_PREVIEW_PATH, { config: { need: IMPORT_PERMISSION } }, async (request, reply) => {
    const parsed = parseSermonImportRequest(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const actor = provenSession(request).record.actor;
    const now = Date.now();
    pruneExpiredPreviewWindows(now);
    const window = previewLimiter.get(actor);
    if (window !== undefined && now - window.windowStart < PREVIEW_WINDOW_MS) {
      if (window.count >= PREVIEW_LIMIT) {
        return reply.code(429).send(errorEnvelope('sermon.import_rate_limited', 'too many previews, try again shortly', request.id));
      }
      window.count += 1;
    } else {
      previewLimiter.set(actor, { count: 1, windowStart: now });
    }
    const generated = await generateSermonFromText(parsed.value.text, {
      translations: [...parsed.value.translations],
      now: new Date(),
      apiKey: anthropicApiKey,
      httpPost,
      onIntegrationCall: async (call) => {
        try {
          await identity.audit.record(
            auditContext(actor, correlationFor(SERMON_PREFIX, request.id)),
            {
              action: 'integration.call',
              subject: call.subject,
              outcome: call.outcome,
              detail: call.detail,
              requestTokens: call.requestTokens,
              responseTokens: call.responseTokens,
            },
          );
        } catch (error) {
          request.log.error({ err: error }, 'the resolver trail refused an entry');
        }
      },
    });
    return reply.send(successEnvelope(
      { suggestedTitle: generated.title, yaml: generated.yaml, notices: generated.notices, resolver: generated.resolver, resolvedTokens: generated.resolvedTokens },
      request.id,
      CLIENT_WINDOW.current,
    ));
  });
}
