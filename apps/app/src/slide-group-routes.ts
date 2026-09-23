import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import {
  SLIDE_GROUPS_PATH,
  parseLanguageBlockOrder,
  parseSlideBackgroundOverride,
  parseSlideGroupBody,
  parseSlideGroupDraft,
  parseSlideGroupStatus,
  parseSlideLayoutOverride,
  parseSlideOrder,
} from '@holydeck/contracts/slide-groups';

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { settled } from './refusals.js';
import { CONTENT_EDIT } from './roles.js';
import { SlideGroupError, slideGroupContext, subjectFor } from './slide-groups.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { Answer } from './refusals.js';
import type { SlideGroupStore } from './slide-groups.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const SLIDE_GROUP_PREFIX = 'slideGroup:';

export const SLIDE_GROUP_ID_PATH = `${SLIDE_GROUPS_PATH}/:id`;
const SLIDE_GROUP_DUPLICATE_PATH = `${SLIDE_GROUP_ID_PATH}/duplicate`;
const SLIDE_GROUP_STATUS_PATH = `${SLIDE_GROUP_ID_PATH}/status`;
const SLIDE_GROUP_REGENERATE_PATH = `${SLIDE_GROUP_ID_PATH}/regenerate`;
const SLIDE_GROUP_HISTORY_PATH = `${SLIDE_GROUP_ID_PATH}/history`;
const SLIDE_GROUP_SLIDE_ORDER_PATH = `${SLIDE_GROUP_ID_PATH}/slide-order`;
export const SLIDE_PATH = `${SLIDE_GROUP_ID_PATH}/slides/:slideId`;
const SLIDE_DUPLICATE_PATH = `${SLIDE_PATH}/duplicate`;
const SLIDE_LAYOUT_OVERRIDE_PATH = `${SLIDE_PATH}/layout`;
const SLIDE_BACKGROUND_OVERRIDE_PATH = `${SLIDE_PATH}/background`;
const LANGUAGE_BLOCK_DUPLICATE_PATH = `${SLIDE_PATH}/language-blocks/:blockId/duplicate`;
const LANGUAGE_BLOCK_ORDER_PATH = `${SLIDE_PATH}/language-block-order`;

const PERMISSION: RouteNeed = { kind: 'permission', need: CONTENT_EDIT };

const ROUTES = [
  ['POST', SLIDE_GROUPS_PATH],
  ['GET', SLIDE_GROUP_ID_PATH],
  ['PUT', SLIDE_GROUP_ID_PATH],
  ['POST', SLIDE_GROUP_DUPLICATE_PATH],
  ['PATCH', SLIDE_GROUP_STATUS_PATH],
  ['POST', SLIDE_GROUP_REGENERATE_PATH],
  ['GET', SLIDE_GROUP_HISTORY_PATH],
  ['PUT', SLIDE_GROUP_SLIDE_ORDER_PATH],
  ['PATCH', SLIDE_PATH],
  ['POST', SLIDE_DUPLICATE_PATH],
  ['PUT', SLIDE_LAYOUT_OVERRIDE_PATH],
  ['DELETE', SLIDE_LAYOUT_OVERRIDE_PATH],
  ['PUT', SLIDE_BACKGROUND_OVERRIDE_PATH],
  ['DELETE', SLIDE_BACKGROUND_OVERRIDE_PATH],
  ['POST', LANGUAGE_BLOCK_DUPLICATE_PATH],
  ['PUT', LANGUAGE_BLOCK_ORDER_PATH],
] as const;

type Refusal = 'schema' | 'state' | 'conflict';

const isRefusal = (error: unknown): error is SlideGroupError & { kind: Refusal } =>
  error instanceof SlideGroupError && error.kind !== 'corrupt';

const refused = (
  request: FastifyRequest,
  reply: FastifyReply,
  answer: Extract<Answer<never, Refusal>, { ok: false }>,
) =>
  answer.kind === 'schema'
    ? reply.code(422).send(validationFailure(request.id, [{ path: '', code: 'invalid', message: answer.message }]))
    : reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));

const idIn = (request: FastifyRequest): string => (request.params as { readonly id: string }).id;
const slideIdIn = (request: FastifyRequest): string => (request.params as { readonly slideId: string }).slideId;
const blockIdIn = (request: FastifyRequest): string => (request.params as { readonly blockId: string }).blockId;

export interface SlideGroupRoutesOptions {
  readonly slideGroups: SlideGroupStore | undefined;
  readonly identity: Identity | undefined;
}

export function serveSlideGroupRoutes(
  app: FastifyInstance,
  { slideGroups, identity }: SlideGroupRoutesOptions,
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

  const store = slideGroups as SlideGroupStore;
  const call = (request: FastifyRequest) =>
    slideGroupContext(provenSession(request).record.actor, correlationFor(SLIDE_GROUP_PREFIX, request.id));
  const note = async (request: FastifyRequest, id: string, outcome: AuditOutcome, detail: string): Promise<void> => {
    try {
      await identity.audit.record(
        auditContext(provenSession(request).record.actor, correlationFor(SLIDE_GROUP_PREFIX, request.id)),
        { action: 'content.change', subject: subjectFor(id), outcome, detail },
      );
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the slide group trail refused an entry');
    }
  };

  app.post(SLIDE_GROUPS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSlideGroupDraft(request.body, 'slideGroup');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(
      () => store.create(call(request), parsed.value.kind, parsed.value.title, parsed.value.body),
      isRefusal,
    );
    if (!answer.ok) return refused(request, reply, answer);
    await note(request, answer.value.stamp.id, 'allowed', 'created');
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SLIDE_GROUP_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const current = await store.current(call(request), idIn(request));
    if (current === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(current, request.id, CLIENT_WINDOW.current));
  });

  app.put(SLIDE_GROUP_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSlideGroupBody(request.body, 'slideGroup');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const answer = await settled(() => store.edit(call(request), id, parsed.value), isRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', 'saved');
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SLIDE_GROUP_DUPLICATE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => store.duplicate(call(request), idIn(request)), isRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, answer.value.stamp.id, 'allowed', `duplicated from ${idIn(request)}`);
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.patch(SLIDE_GROUP_STATUS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSlideGroupStatus(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const context = call(request);
    const answer = await settled(
      () => (parsed.value.enabled ? store.enable(context, id) : store.disable(context, id)),
      isRefusal,
    );
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', parsed.value.enabled ? 'enabled' : 'disabled');
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SLIDE_GROUP_REGENERATE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSlideGroupBody(request.body, 'slideGroup');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const answer = await settled(() => store.regenerate(call(request), id, parsed.value), isRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', 'regenerated');
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SLIDE_GROUP_HISTORY_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const history = await store.history(call(request), idIn(request));
    if (history.length === 0) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(history, request.id, CLIENT_WINDOW.current));
  });

  app.put(SLIDE_GROUP_SLIDE_ORDER_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSlideOrder(request.body, 'slideGroup');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const answer = await settled(() => store.reorderSlides(call(request), id, parsed.value.slideIds), isRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', 'reordered slides');
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.patch(SLIDE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSlideGroupStatus(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const slideId = slideIdIn(request);
    const context = call(request);
    const answer = await settled(
      () => (parsed.value.enabled ? store.enableSlide(context, id, slideId) : store.disableSlide(context, id, slideId)),
      isRefusal,
    );
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', `${parsed.value.enabled ? 'enabled' : 'disabled'} slide ${slideId}`);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SLIDE_DUPLICATE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const id = idIn(request);
    const slideId = slideIdIn(request);
    const answer = await settled(() => store.duplicateSlide(call(request), id, slideId), isRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', `duplicated slide ${slideId}`);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.put(SLIDE_LAYOUT_OVERRIDE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSlideLayoutOverride(request.body, 'slideGroup');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const slideId = slideIdIn(request);
    const answer = await settled(
      () => store.overrideSlideLayout(call(request), id, slideId, parsed.value.slideLayoutId),
      isRefusal,
    );
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', `overrode slide ${slideId} layout`);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.delete(SLIDE_LAYOUT_OVERRIDE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const id = idIn(request);
    const slideId = slideIdIn(request);
    const answer = await settled(() => store.clearSlideLayoutOverride(call(request), id, slideId), isRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', `cleared slide ${slideId} layout override`);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.put(SLIDE_BACKGROUND_OVERRIDE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSlideBackgroundOverride(request.body, 'slideGroup');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const slideId = slideIdIn(request);
    const answer = await settled(
      () => store.overrideSlideBackground(call(request), id, slideId, parsed.value.background),
      isRefusal,
    );
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', `overrode slide ${slideId} background`);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.delete(SLIDE_BACKGROUND_OVERRIDE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const id = idIn(request);
    const slideId = slideIdIn(request);
    const answer = await settled(() => store.clearSlideBackgroundOverride(call(request), id, slideId), isRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', `cleared slide ${slideId} background override`);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(LANGUAGE_BLOCK_DUPLICATE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const id = idIn(request);
    const slideId = slideIdIn(request);
    const blockId = blockIdIn(request);
    const answer = await settled(() => store.duplicateLanguageBlock(call(request), id, slideId, blockId), isRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', `duplicated language block ${blockId} on slide ${slideId}`);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.put(LANGUAGE_BLOCK_ORDER_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseLanguageBlockOrder(request.body, 'slideGroup');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const slideId = slideIdIn(request);
    const answer = await settled(
      () => store.reorderLanguageBlocks(call(request), id, slideId, parsed.value.blockIds),
      isRefusal,
    );
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', `reordered slide ${slideId} language blocks`);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });
}
