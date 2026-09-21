// Where a browser hands this server a file, and MediaLibrary.upload() sees it for the first time.
//
// Shaped like `settings-routes.ts`: one permission, `MEDIA_MANAGE`, gates the route, and a deployment
// with nowhere to keep an identity serves the same path answering not-found — `main.ts` never constructs
// a `media` library without an `identity` alongside it either, both coming from the same `mongoUrl !== ''`
// block, so this one gate covers both.
//
// THR-07's three defenses live here, in the order a request meets them, each refusing before the next
// would even see the bytes: `@fastify/multipart`'s own `limits.fileSize` (registered in `app.ts`, against
// `MEDIA_SIZE_CEILING_BYTES`) refuses an oversized body while it is still streaming in, never buffered
// whole; `imageDimensionsOf` refuses a pixel-count bomb from its header alone, before `upload()` — and so
// before anything is decoded or stored; and `upload()` itself sniffs the real type from bytes, never from
// what a client claims a file is named or typed.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { imageDimensionsOf } from '@holydeck/contracts/media';
import { FIELD_CODES } from '@holydeck/contracts/problems';

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { MediaError, mediaContext } from './media.js';
import { MEDIA_MANAGE } from './roles.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { MediaLibrary } from './media.js';
import type { Identity } from './onboarding.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const MEDIA_PREFIX = 'media:';

export const MEDIA_PATH = '/api/v1/media';

/**
 * MEDI-01's stated default for the per-file ceiling: 1 GB. The full configurable 1 GB/5 GB policy system
 * stays out of this task's scope — this is the real, enforced, hardcoded-reasonable number THR-07 asks
 * for, not the deployment-tunable surface around it.
 */
export const MEDIA_SIZE_CEILING_BYTES = 1_073_741_824;

/**
 * The pixel count a decoder would have to hold for one image, read from its header alone. 100 megapixels
 * is comfortably past any legitimate slide asset or output-window background this application serves —
 * a 4K frame is under 8.3 megapixels — while still refusing a file whose declared dimensions alone would
 * demand hundreds of megabytes to a few gigabytes of decoded pixel data from a few header bytes on the wire.
 */
export const MEDIA_PIXEL_CEILING = 100_000_000;

const PERMISSION: RouteNeed = { kind: 'permission', need: MEDIA_MANAGE };

/** Every route this module serves, in the order it registers them. */
const ROUTES = [['POST', MEDIA_PATH]] as const;

export interface MediaRoutesOptions {
  /** Absent whenever `identity` is, per `main.ts`'s wiring — never independently, from this module's view. */
  readonly media: MediaLibrary | undefined;
  /** Absent in a deployment that keeps no identity, which has nothing here to audit an upload against. */
  readonly identity: Identity | undefined;
}

export function serveMediaRoutes(app: FastifyInstance, { media, identity }: MediaRoutesOptions): void {
  // A deployment with nowhere to keep an identity has nothing here to audit an upload against. Every path
  // is still served, so the guard's table remains the complete shape of the surface in every deployment.
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

  // Guaranteed by `main.ts`'s wiring, not by this module: an `identity` never exists without a `media`
  // library alongside it, so the gate above is this module's only check for either.
  const library = media as MediaLibrary;

  /**
   * Written after the change, and logged rather than answered when the trail refuses it: an upload holds
   * that it happened, whether or not this server managed to write it down. Reuses `content.change` —
   * `audit.ts`'s own declared action for every content surface, media included, rather than a media-only
   * action that would say the same sentence in a second vocabulary.
   */
  const note = async (request: FastifyRequest, actor: string, subject: string, outcome: AuditOutcome): Promise<void> => {
    try {
      await identity.audit.record(auditContext(actor, correlationFor(MEDIA_PREFIX, request.id)), {
        action: 'content.change',
        subject,
        outcome,
        detail: 'uploaded',
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the media trail refused an entry');
    }
  };

  app.post(MEDIA_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(422).send(
        validationFailure(request.id, [
          { path: 'file', code: FIELD_CODES.required, message: 'must be a multipart request carrying a file' },
        ]),
      );
    }

    const file = await request.file();
    if (file === undefined) {
      return reply
        .code(422)
        .send(validationFailure(request.id, [{ path: 'file', code: FIELD_CODES.required, message: 'is required' }]));
    }

    let bytes: Uint8Array;
    try {
      bytes = await file.toBuffer();
    } catch (error) {
      // Thrown mid-stream, by `@fastify/multipart` itself, the moment the body it was still reading passed
      // the `limits.fileSize` ceiling `app.ts` registered — the bytes past that ceiling are discarded as
      // they arrive, never buffered whole, and `upload()` below is never reached with them.
      if (error instanceof request.server.multipartErrors.RequestFileTooLargeError) {
        return reply
          .code(413)
          .send(errorEnvelope('media.too_large', 'the file exceeds this deployment’s upload size ceiling', request.id));
      }
      throw error;
    }

    // Read from the format's own header fields, never a decode: a pixel-count bomb is refused here, before
    // `upload()` — and so before anything below this line would decode, store, or queue it for ffmpeg.
    const dimensions = imageDimensionsOf(bytes);
    if (dimensions !== undefined && dimensions.width * dimensions.height > MEDIA_PIXEL_CEILING) {
      return reply.code(422).send(
        validationFailure(request.id, [
          { path: 'file', code: FIELD_CODES.tooLarge, message: `must not exceed ${MEDIA_PIXEL_CEILING} pixels` },
        ]),
      );
    }

    const actor = provenSession(request).record.actor;
    try {
      const record = await library.upload(mediaContext(actor, correlationFor(MEDIA_PREFIX, request.id)), {
        bytes,
        name: file.filename,
        type: file.mimetype,
      });
      await note(request, actor, `media:${record.stamp.id}`, 'allowed');
      return reply.code(201).send(successEnvelope(record, request.id, CLIENT_WINDOW.current));
    } catch (error) {
      // A type this server's own content-sniffing does not recognise is exactly the same category of
      // user-correctable problem as any other field validation failure.
      if (error instanceof MediaError && error.kind === 'invalid-type') {
        return reply
          .code(422)
          .send(validationFailure(request.id, [{ path: 'file', code: FIELD_CODES.notAllowed, message: error.message }]));
      }
      // Bytes already in the library: a request that disagrees with the state it is aimed at, the same
      // `slide-layout-routes.ts` answers with this code for the conflicts of its own.
      if (error instanceof MediaError && error.kind === 'duplicate') {
        return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, error.message, request.id));
      }
      throw error;
    }
  });
}
