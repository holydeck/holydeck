import { Readable } from 'node:stream';

import { actorFor } from '@holydeck/contracts/accounts';
import { archivedStamp, createdStamp } from '@holydeck/contracts/entities';
import { sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { enforceAuthorization } from './authorization.js';
import { guardMutations } from './csrf.js';
import {
  MEDIA_CONTENT_PATH,
  MEDIA_DERIVATIVE_PATH,
  serveMediaDeliveryRoutes,
} from './media-delivery-routes.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { MediaByteSource } from './media-delivery-routes.js';
import type { MediaLibrary, MediaRecord } from './media.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FastifyInstance } from 'fastify';
import type { Mock } from 'vitest';

const NOW = '2026-09-22T09:30:00.000Z';
const LATER = '2026-09-22T10:30:00.000Z';
const ACTOR = actorFor('C'.repeat(22));
const CORRELATION = 'req-0f9c2a41';
const CONTENT = Buffer.from('0123456789');

const contentPath = (id = 'asset-1'): string => MEDIA_CONTENT_PATH.replace(':id', id);
const derivativePath = (name = 'poster', id = 'asset-1'): string =>
  MEDIA_DERIVATIVE_PATH.replace(':id', id).replace(':name', name);

const freshRecord = (): MediaRecord => ({
  stamp: createdStamp({ id: 'asset-1', kind: 'mediaAsset', at: NOW, by: ACTOR }),
  storageKey: 'k',
  manifest: {
    id: 'asset-1',
    bytes: 10,
    hash: 'sha256:abc',
    type: 'image/png',
    processingState: 'ready',
    derivatives: [],
  },
});

let app: FastifyInstance;
let sessions: SessionStore;
let session: StartedSession;
let record: MediaRecord;
let inspect: ReturnType<typeof vi.fn>;
let size: Mock<MediaByteSource['size']>;
let stream: Mock<MediaByteSource['stream']>;
let media: MediaLibrary;
let bytes: MediaByteSource;

const served = async (
  heldMedia: MediaLibrary | undefined,
  heldBytes: MediaByteSource | undefined,
): Promise<FastifyInstance> => {
  const built = Fastify({ logger: false });
  guardMutations(built, { sessions });
  enforceAuthorization(built, { sessions, identity: undefined });
  serveMediaDeliveryRoutes(built, { media: heldMedia, bytes: heldBytes });
  await built.ready();
  return built;
};

const asking = (url: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'GET',
    url,
    headers: { cookie: sessionCookie(session.token, 60), ...headers },
  });

beforeEach(async () => {
  sessions = sessionsOn(memorySessions().db, { now: () => NOW });
  session = await sessions.start(sessionContext(CORRELATION), { actor: ACTOR, permissions: [] });
  record = freshRecord();
  inspect = vi.fn(async (_context: unknown, id: string) => (id === record.stamp.id ? record : undefined));
  media = { inspect } as unknown as MediaLibrary;
  const sources = new Map<string, Buffer>([['k', CONTENT]]);
  size = vi.fn(async (key: string) => sources.get(key)?.length ?? 0);
  stream = vi.fn((key: string, range?: { start: number; end: number }) => {
    const source = sources.get(key) ?? Buffer.alloc(0);
    const start = range?.start ?? 0;
    const end = range?.end ?? source.length - 1;
    return Readable.from(source.subarray(start, end + 1));
  });
  bytes = { size, stream };
  app = await served(media, bytes);
});

afterEach(async () => {
  await app.close();
});

describe('media content delivery', () => {
  test('streams the whole asset with immutable cache and byte-range headers', async () => {
    const response = await asking(contentPath());

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('0123456789');
    expect(response.headers).toMatchObject({
      'content-type': 'image/png',
      etag: '"abc"',
      'cache-control': 'private, max-age=31536000, immutable',
      'accept-ranges': 'bytes',
      'content-length': '10',
    });
    expect(stream).toHaveBeenCalledWith('k');
  });

  test('streams only the requested byte range', async () => {
    const response = await asking(contentPath(), { range: 'bytes=2-4' });

    expect(response.statusCode).toBe(206);
    expect(response.body).toBe('234');
    expect(response.headers['content-range']).toBe('bytes 2-4/10');
    expect(stream).toHaveBeenCalledWith('k', { start: 2, end: 4 });
  });

  test('refuses a range beyond the stored bytes without opening a stream', async () => {
    const response = await asking(contentPath(), { range: 'bytes=20-' });

    expect(response.statusCode).toBe(416);
    expect(response.headers['content-range']).toBe('bytes */10');
    expect(stream).not.toHaveBeenCalled();
  });

  test('answers a matching cache validator without reading the stored file', async () => {
    const response = await asking(contentPath(), { 'if-none-match': '"abc"' });

    expect(response.statusCode).toBe(304);
    expect(response.body).toBe('');
    expect(size).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  test('still streams an archived asset', async () => {
    record = { ...record, stamp: archivedStamp(record.stamp, { at: LATER, by: ACTOR }) };

    expect((await asking(contentPath())).statusCode).toBe(200);
  });

  test('answers not-found for an unknown asset', async () => {
    expect((await asking(contentPath('unknown'))).statusCode).toBe(404);
  });

  test('refuses a request with no session before inspecting the library', async () => {
    const response = await app.inject({ method: 'GET', url: contentPath() });

    expect(response.statusCode).toBe(401);
    expect(inspect).not.toHaveBeenCalled();
  });
});

describe('media derivative delivery', () => {
  test('answers a specific error while the requested derivative is missing', async () => {
    const response = await asking(derivativePath());

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('media.derivative_missing');
  });

  test('answers the same specific error when a recorded derivative has no file behind it', async () => {
    record = {
      ...record,
      manifest: {
        ...record.manifest,
        derivatives: [{ kind: 'poster', bytes: 3, hash: 'sha256:def', from: 'sha256:abc' }],
      },
    };
    size.mockRejectedValueOnce(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }));

    const response = await asking(derivativePath());

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('media.derivative_missing');
    expect(stream).not.toHaveBeenCalled();
  });

  test('streams the produced JPEG under its real storage key and validator', async () => {
    record = {
      ...record,
      manifest: {
        ...record.manifest,
        derivatives: [{ kind: 'poster', bytes: 3, hash: 'sha256:def', from: 'sha256:abc' }],
      },
    };
    size.mockResolvedValueOnce(3);
    stream.mockReturnValueOnce(Readable.from(Buffer.from('jpg')));

    const response = await asking(derivativePath());

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('jpg');
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers.etag).toBe('"def"');
    expect(size).toHaveBeenCalledWith('k.poster.jpg');
    expect(stream).toHaveBeenCalledWith('k.poster.jpg');
  });
});

describe('an unconfigured media delivery surface', () => {
  test.each([
    ['media', undefined, {} as MediaByteSource],
    ['byte source', {} as MediaLibrary, undefined],
  ] as const)('answers both paths with not-found when the %s is absent', async (_missing, heldMedia, heldBytes) => {
    await app.close();
    app = await served(heldMedia, heldBytes);

    expect((await asking(contentPath())).statusCode).toBe(404);
    expect((await asking(derivativePath())).statusCode).toBe(404);
  });
});
