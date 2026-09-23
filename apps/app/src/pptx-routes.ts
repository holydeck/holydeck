// Spec AUTH-04: the HTTP surface a PowerPoint import is driven through, and the one place its three
// domain steps — extraction (`pptx-import.ts`), review (`pptx-review.ts`) and commit (`pptx-commit.ts`)
// — are ever composed together. Between requests the import lives in `pptx-sessions.ts`, never in the
// client (Decision D08-1): review and commit read the slides back from the session, so nothing a client
// sends can become song text that never came from the uploaded file.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { PPTX_IMPORTS_PATH, parsePptxCommitTarget, parsePptxReviewDecisions } from '@holydeck/contracts/pptx';
import { HolyDeckError } from '@holydeck/core/messages';

import { auditContext } from './audit.js';
import { correlationFor, requestContext } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { LIBRARY_PERMISSIONS } from './library.js';
import { MEDIA_ASSET_PERMISSIONS } from './media.js';
import { PptxReviewError } from './pptx-review.js';
import { PPTX_SESSION_PERMISSIONS } from './pptx-sessions.js';
import { QUEUE_PERMISSIONS } from './queue.js';
import { REVISION_PERMISSIONS } from './revisions.js';
import { SERVICES_MANAGE } from './roles.js';
import { SLIDE_LABEL_PERMISSIONS } from './slide-labels.js';
import { LAYOUT_PERMISSIONS } from './slide-layouts.js';
import { SongError } from './songs.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { RequestContext } from './context.js';
import type { Identity } from './onboarding.js';
import type { PptxCommit } from './pptx-commit.js';
import type { PptxImport, PptxImportResult } from './pptx-import.js';
import type { PptxReview, PptxReviewedBlock } from './pptx-review.js';
import type { PptxSessionRecord, PptxSessionStore } from './pptx-sessions.js';
import type { SongRecord } from './songs.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const PPTX_PREFIX = 'pptx:';

export const PPTX_ID_PATH = `${PPTX_IMPORTS_PATH}/:id`;
export const PPTX_REVIEW_PATH = `${PPTX_ID_PATH}/review`;
export const PPTX_COMMIT_PATH = `${PPTX_ID_PATH}/commit`;

/** The ceiling spec AUTH-04 sets on one uploaded deck, enforced by Fastify on this route alone. */
export const PPTX_BODY_LIMIT_BYTES = 100 * 1024 * 1024;

const INVALID_FORMAT_CODES: ReadonlySet<string> = new Set([
  'pptx_empty',
  'pptx_corrupt',
  'pptx_unsupported',
  'pptx_unsafe_entry_name',
]);

// AUTH-13: `openArchive`'s own bounds (packages/core/src/pptx.ts) refuse an archive that decompresses
// past its entry-count/entry-size/total-size limits. That is a body the client sent us too much of, same
// as the raw-byte-count check the route's own `bodyLimit` already answers 413 for below — so map it the
// same way, distinct from a merely malformed/unsupported file (422).
const SIZE_LIMIT_CODES: ReadonlySet<string> = new Set([
  'pptx_too_many_entries',
  'pptx_entry_too_large',
  'pptx_archive_too_large',
]);

const DEFAULT_FILE_NAME = 'import.pptx';

const PERMISSION: RouteNeed = { kind: 'permission', need: SERVICES_MANAGE };

const ROUTES = [
  ['POST', PPTX_IMPORTS_PATH],
  ['GET', PPTX_ID_PATH],
  ['POST', PPTX_REVIEW_PATH],
  ['POST', PPTX_COMMIT_PATH],
  ['DELETE', PPTX_ID_PATH],
] as const;

const idIn = (request: FastifyRequest): string => (request.params as { readonly id: string }).id;

const importSubject = (id: string): string => `pptxImport:${id}`;

/** A refused upload has no session id yet — nothing was created — so it is audited under this instead. */
const UPLOAD_SUBJECT = 'pptxImport:upload';

const fileNameIn = (request: FastifyRequest): string => {
  const named = request.headers['x-file-name'];
  return typeof named === 'string' && named.length > 0 ? named : DEFAULT_FILE_NAME;
};

/** The spec asks for `{ decisions: [...] }`; anything else is read as no list at all. */
const decisionsIn = (body: unknown): unknown =>
  typeof body === 'object' && body !== null ? (body as { readonly decisions?: unknown }).decisions : undefined;

export interface PptxRoutesOptions {
  readonly pptxImport: PptxImport | undefined;
  readonly pptxReview: PptxReview | undefined;
  readonly pptxCommit: PptxCommit | undefined;
  readonly pptxSessions: PptxSessionStore | undefined;
  readonly identity: Identity | undefined;
  /** Test-only override of `PPTX_BODY_LIMIT_BYTES`, so a test need not build a 100 MB body. */
  readonly bodyLimit?: number;
}

/** Everything any of the three domain steps and the session store might need, in one context: each
 *  domain's own `*Context` factory grants only its own narrower set, and this route is the one place
 *  all of them run under the same request. */
function pptxRouteContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [
      ...Object.values(MEDIA_ASSET_PERMISSIONS),
      QUEUE_PERMISSIONS.enqueue,
      ...Object.values(LIBRARY_PERMISSIONS),
      ...Object.values(REVISION_PERMISSIONS),
      LAYOUT_PERMISSIONS.read,
      SLIDE_LABEL_PERMISSIONS.read,
      ...Object.values(PPTX_SESSION_PERMISSIONS),
    ],
    correlationId,
  });
}

/** A session as a client reads it: each slide's media named by id rather than carried whole. */
const viewOf = (session: PptxSessionRecord) => ({
  id: session.id,
  fileName: session.fileName,
  createdAt: session.createdAt,
  expiresAt: session.expiresAt,
  slides: session.slides.map((slide) => ({ textBlocks: slide.textBlocks, mediaIds: slide.media.map((media) => media.stamp.id) })),
  skippedMedia: session.skippedMedia,
  provenance: session.provenance,
  ...(session.duplicate === undefined ? {} : { duplicate: session.duplicate }),
  ...(session.reviewed === undefined ? {} : { reviewed: session.reviewed, reviewedAt: session.reviewedAt }),
});

const textBlocksOf = (session: PptxSessionRecord): readonly (readonly string[])[] =>
  session.slides.map((slide) => slide.textBlocks);

export function servePptxRoutes(
  app: FastifyInstance,
  { pptxImport, pptxReview, pptxCommit, pptxSessions, identity, bodyLimit = PPTX_BODY_LIMIT_BYTES }: PptxRoutesOptions,
): void {
  if (
    identity === undefined || pptxImport === undefined || pptxReview === undefined ||
    pptxCommit === undefined || pptxSessions === undefined
  ) {
    for (const [method, url] of ROUTES) {
      app.route({ method, url, config: { need: PERMISSION }, handler: (request, reply) => reply.code(404).send(notFound(request)) });
    }
    return;
  }

  const importStore = pptxImport;
  const reviewStore = pptxReview;
  const commitStore = pptxCommit;
  const sessions = pptxSessions;
  const call = (request: FastifyRequest) =>
    pptxRouteContext(provenSession(request).record.actor, correlationFor(PPTX_PREFIX, request.id));
  const note = async (
    request: FastifyRequest,
    action: 'pptx.import' | 'pptx.commit',
    subject: string,
    outcome: AuditOutcome,
    detail: string,
  ): Promise<void> => {
    try {
      await identity.audit.record(
        auditContext(provenSession(request).record.actor, correlationFor(PPTX_PREFIX, request.id)),
        { action, subject, outcome, detail },
      );
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the pptx import trail refused an entry');
    }
  };

  // One import per account at a time, per process: each one holds a deck of up to 100 MB in memory.
  const inFlight = new Set<string>();

  app.post(PPTX_IMPORTS_PATH, {
    config: { need: PERMISSION },
    bodyLimit,
    errorHandler(error, request, reply) {
      if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        return reply.code(413).send(errorEnvelope('pptx.too_large', error.message, request.id));
      }
      if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
        return reply.code(415).send(errorEnvelope('pptx.invalid_format', error.message, request.id));
      }
      return reply.send(error);
    },
  }, async (request, reply) => {
    if (!(request.body instanceof Uint8Array)) {
      await note(request, 'pptx.import', UPLOAD_SUBJECT, 'refused', 'sent as something other than raw bytes');
      return reply.code(422).send(errorEnvelope('pptx.invalid_format', 'send the presentation as its own raw bytes', request.id));
    }
    const actor = provenSession(request).record.actor;
    if (inFlight.has(actor)) {
      await note(request, 'pptx.import', UPLOAD_SUBJECT, 'refused', 'an import was already in progress for this account');
      return reply.code(409).send(errorEnvelope('pptx.import_in_progress', 'an import is already in progress for this account', request.id));
    }
    inFlight.add(actor);
    try {
      let result: PptxImportResult;
      try {
        result = await importStore.import(call(request), request.body);
      } catch (error: unknown) {
        if (error instanceof HolyDeckError && SIZE_LIMIT_CODES.has(error.code)) {
          await note(request, 'pptx.import', UPLOAD_SUBJECT, 'refused', error.message);
          return reply.code(413).send(errorEnvelope('pptx.too_large', error.message, request.id));
        }
        if (error instanceof HolyDeckError && INVALID_FORMAT_CODES.has(error.code)) {
          await note(request, 'pptx.import', UPLOAD_SUBJECT, 'refused', error.message);
          return reply.code(422).send(errorEnvelope('pptx.invalid_format', error.message, request.id));
        }
        throw error;
      }
      const session = await sessions.create(call(request), { fileName: fileNameIn(request), result });
      await note(request, 'pptx.import', importSubject(session.id), 'allowed', 'imported');
      return reply.code(201).send(successEnvelope(viewOf(session), request.id, CLIENT_WINDOW.current));
    } finally {
      inFlight.delete(actor);
    }
  });

  app.get(PPTX_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const session = await sessions.get(call(request), idIn(request));
    if (session === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(viewOf(session), request.id, CLIENT_WINDOW.current));
  });

  app.post(PPTX_REVIEW_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parsePptxReviewDecisions(decisionsIn(request.body));
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const context = call(request);
    const session = await sessions.get(context, id);
    if (session === undefined) return reply.code(404).send(notFound(request));
    let reviewed: readonly PptxReviewedBlock[];
    try {
      reviewed = await reviewStore.review(context, textBlocksOf(session), parsed.value);
    } catch (error: unknown) {
      if (error instanceof PptxReviewError) {
        const failure = validationFailure(request.id, error.problems.map((problem) => ({
          path: `slides.${problem.slideIndex}.textBlocks.${problem.blockIndex}`,
          code: problem.kind,
          message: problem.message,
        })));
        return reply.code(422).send({ error: { ...failure.error, problems: error.problems } });
      }
      throw error;
    }
    const updated = await sessions.review(context, id, reviewed);
    if (updated === undefined) return reply.code(404).send(notFound(request));
    await note(request, 'pptx.import', importSubject(id), 'allowed', 'reviewed');
    return reply.send(successEnvelope(viewOf(updated), request.id, CLIENT_WINDOW.current));
  });

  app.post(PPTX_COMMIT_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parsePptxCommitTarget(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const context = call(request);
    const session = await sessions.get(context, id);
    if (session === undefined) return reply.code(404).send(notFound(request));
    const reviewed = session.reviewed;
    if (reviewed === undefined) {
      return reply.code(409).send(errorEnvelope('pptx.not_reviewed', 'review this import before committing it', request.id));
    }
    let song: SongRecord;
    try {
      song = await commitStore.commit(context, parsed.value, textBlocksOf(session), reviewed);
    } catch (error: unknown) {
      if (error instanceof SongError && error.kind === 'state') {
        return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, error.message, request.id));
      }
      throw error;
    }
    await sessions.discard(context, id);
    await note(request, 'pptx.commit', importSubject(id), 'allowed', `committed as ${song.stamp.id}`);
    const report = {
      slides: session.slides.length,
      blocks: reviewed.length,
      languages: song.body.languages,
      labelsUsed: [...new Set(reviewed.map((block) => block.label.name))],
      skippedMedia: session.skippedMedia,
      provenance: session.provenance,
      target: parsed.value,
    };
    return reply
      .code(parsed.value.mode === 'create' ? 201 : 200)
      .send(successEnvelope({ song, report }, request.id, CLIENT_WINDOW.current));
  });

  app.delete(PPTX_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const id = idIn(request);
    if (!(await sessions.discard(call(request), id))) return reply.code(404).send(notFound(request));
    await note(request, 'pptx.import', importSubject(id), 'allowed', 'discarded');
    return reply.code(204).send();
  });
}
