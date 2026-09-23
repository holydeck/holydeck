// D03-2 serves an asset's real bytes without first collecting them into a buffer, so a seek reads only
// the requested range and a whole response remains a stream. MEDI-01 says every retained reference
// protects its bytes: archiving hides an asset from new choices but does not break an existing reference,
// so an archived record is deliberately inspected and streamed exactly like a live one.

import { errorEnvelope } from '@holydeck/contracts/http';

import { parseByteRange } from './byte-range.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { mediaContext } from './media.js';

import type { RouteNeed } from './authorization.js';
import type { MediaLibrary } from './media.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const MEDIA_PREFIX = 'media:';
const SESSION: RouteNeed = { kind: 'session' };
const CACHE_CONTROL = 'private, max-age=31536000, immutable';

export const MEDIA_CONTENT_PATH = '/api/v1/media/:id/content';
export const MEDIA_DERIVATIVE_PATH = '/api/v1/media/:id/derivatives/:name';

/** Every route this module serves, in the order it registers them. */
const ROUTES = [
  ['GET', MEDIA_CONTENT_PATH],
  ['GET', MEDIA_DERIVATIVE_PATH],
] as const;

export interface MediaByteSource {
  size(key: string): Promise<number>;
  stream(key: string, range?: { start: number; end: number }): NodeJS.ReadableStream;
}

export interface MediaDeliveryRoutesOptions {
  readonly media: MediaLibrary | undefined;
  readonly bytes: MediaByteSource | undefined;
}

interface Delivery {
  readonly key: string;
  readonly hash: string;
  readonly type: string;
  /** What to answer when the key has no file behind it; without one a missing file stays a failure. */
  readonly missing?: () => FastifyReply;
}

const DELIVERY_HEADERS = ['Content-Type', 'ETag', 'Cache-Control', 'Accept-Ranges'] as const;

const isMissingFile = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { readonly code?: unknown }).code === 'ENOENT';

const deliver = async (
  request: FastifyRequest,
  reply: FastifyReply,
  bytes: MediaByteSource,
  delivery: Delivery,
) => {
  const etag = `"${delivery.hash.replace(/^sha256:/u, '')}"`;
  reply
    .header('Content-Type', delivery.type)
    .header('ETag', etag)
    .header('Cache-Control', CACHE_CONTROL)
    .header('Accept-Ranges', 'bytes');

  if (request.headers['if-none-match'] === etag) return reply.code(304).send();

  let size: number;
  try {
    size = await bytes.size(delivery.key);
  } catch (error) {
    if (delivery.missing === undefined || !isMissingFile(error)) throw error;
    // The headers above describe bytes that are not there; the refusal is a JSON envelope, not a JPEG.
    for (const name of DELIVERY_HEADERS) reply.removeHeader(name);
    return delivery.missing();
  }
  const range = parseByteRange(request.headers.range, size);
  if (range.kind === 'unsatisfiable') {
    return reply.code(416).header('Content-Range', `bytes */${size}`).send();
  }
  if (range.kind === 'partial') {
    return reply
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      .header('Content-Length', range.end - range.start + 1)
      .send(bytes.stream(delivery.key, { start: range.start, end: range.end }));
  }
  return reply.header('Content-Length', size).send(bytes.stream(delivery.key));
};

export function serveMediaDeliveryRoutes(
  app: FastifyInstance,
  { media, bytes }: MediaDeliveryRoutesOptions,
): void {
  if (media === undefined || bytes === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({
        method,
        url,
        config: { need: SESSION },
        handler: (request, reply) => reply.code(404).send(notFound(request)),
      });
    }
    return;
  }

  app.get(MEDIA_CONTENT_PATH, { config: { need: SESSION } }, async (request, reply) => {
    const { id } = request.params as { readonly id: string };
    const actor = provenSession(request).record.actor;
    const record = await media.inspect(mediaContext(actor, correlationFor(MEDIA_PREFIX, request.id)), id);
    if (record === undefined) return reply.code(404).send(notFound(request));
    return deliver(request, reply, bytes, {
      key: record.storageKey,
      hash: record.manifest.hash,
      type: record.manifest.type,
    });
  });

  app.get(MEDIA_DERIVATIVE_PATH, { config: { need: SESSION } }, async (request, reply) => {
    const { id, name } = request.params as { readonly id: string; readonly name: string };
    const actor = provenSession(request).record.actor;
    const record = await media.inspect(mediaContext(actor, correlationFor(MEDIA_PREFIX, request.id)), id);
    if (record === undefined) return reply.code(404).send(notFound(request));
    const missing = () =>
      reply
        .code(404)
        .send(errorEnvelope('media.derivative_missing', `No ${name} derivative has been produced for this asset yet`, request.id));
    const derivative = record.manifest.derivatives.find((candidate) => candidate.kind === name);
    if (derivative === undefined) return missing();
    // A manifest can list a derivative whose file was never written or has since gone; that is the same
    // "not produced" a preview already knows how to explain, not a server failure.
    return deliver(request, reply, bytes, {
      key: `${record.storageKey}.${name}.jpg`,
      hash: derivative.hash,
      type: 'image/jpeg',
      missing,
    });
  });
}
