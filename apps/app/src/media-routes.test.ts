import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { CONTENT_EDIT, MEDIA_MANAGE } from './roles.js';
import { mediaContext, mediaLibraryOn } from './media.js';
import { MEDIA_PATH, MEDIA_PIXEL_CEILING, serveMediaRoutes } from './media-routes.js';
import { passkeysOn } from './passkeys.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { fakeMediaStorageIO } from '../test/helpers/media-storage-io.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { MediaLibrary } from './media.js';
import type { Document } from './repositories.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const NOW = '2026-09-13T09:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const ADMINISTRATOR = 'account:' + 'C'.repeat(22);
const BOUNDARY = 'holydeckTestBoundary';

const now = (): string => NOW;

// A PNG signature and IHDR chunk alone — enough for `sniffMediaType` and `imageDimensionsOf` to read,
// carrying no pixel data at all, which is exactly what `upload()` needs and what a decoder never gets
// the chance to touch here.
const png = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

const multipartBody = (file: { readonly filename: string; readonly contentType: string; readonly bytes: Uint8Array }): Buffer =>
  Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
    Buffer.from(file.bytes),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);

let app: FastifyInstance;
let sessions: SessionStore;
let trail: FakeDb;
let identity: Identity;
let media: MediaLibrary;
let upload: ReturnType<typeof vi.fn>;
let admin: StartedSession;

const entries = (): Document[] => trail.rows.get('audit_events') ?? [];

const withHeaders = (held: StartedSession = admin) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  cookie: sessionCookie(held.token, 60),
  [CSRF_HEADER]: held.record.csrf,
  'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
});

const uploading = (
  file: { readonly filename: string; readonly contentType: string; readonly bytes: Uint8Array },
  held: StartedSession = admin,
) => app.inject({ method: 'POST', url: MEDIA_PATH, headers: withHeaders(held), payload: multipartBody(file) });

const requesting = (method: 'GET' | 'PATCH' | 'POST', url: string, held: StartedSession = admin, payload?: unknown) =>
  app.inject({ method, url, headers: { ...withHeaders(held), 'content-type': 'application/json' }, payload: payload as never });

const uploaded = async (width = 4): Promise<string> => {
  const response = await uploading({ filename: `${width}.png`, contentType: 'image/png', bytes: png(width, 4) });
  return response.json().data.stamp.id as string;
};

const served = async (options: {
  readonly media: MediaLibrary | undefined;
  readonly noIdentity?: boolean;
  readonly ceiling?: number;
}): Promise<FastifyInstance> => {
  const built = Fastify({ logger: false });
  withSafeErrors(built);
  built.register(multipart, { limits: { fileSize: options.ceiling ?? 10_000_000 } });
  guardMutations(built, { sessions });
  enforceAuthorization(built, { sessions, identity: undefined });
  serveMediaRoutes(built, { media: options.media, identity: options.noIdentity === true ? undefined : identity });
  await built.ready();
  return built;
};

beforeEach(async () => {
  trail = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now });
  const accounts = accountsOn(memoryAccounts().db, {
    now,
    newId: () => 'A'.repeat(22),
    hash: async (password) => `test-hash:${password}`,
    verify: async (password, stored) => stored === `test-hash:${password}`,
  });
  identity = {
    accounts,
    audit: auditOn(trail, { now, newId: () => `e${entries().length}` }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  const io = fakeMediaStorageIO();
  let serial = 0;
  const real = mediaLibraryOn(fakeDb(), {
    now,
    newId: () => `media-${(serial += 1)}`,
    mediaRoot: '/media',
    write: io.write,
    read: io.read,
    queue: { enqueue: async (_context, input) => ({ id: `job-${input.idempotencyKey}`, created: true }) },
  });
  upload = vi.fn((...args: Parameters<MediaLibrary['upload']>) => real.upload(...args));
  media = { ...real, upload: upload as unknown as MediaLibrary['upload'] };
  app = await served({ media });
  admin = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [MEDIA_MANAGE] });
});

afterEach(async () => {
  await app.close();
});

describe('uploading a file', () => {
  test('an authenticated admin request reaches upload() and a stored, inspectable entry results', async () => {
    const response = await uploading({ filename: 'a.png', contentType: 'image/png', bytes: png(4, 4) });
    expect(response.statusCode).toBe(201);
    expect(upload).toHaveBeenCalledTimes(1);
    const id = response.json().data.stamp.id as string;
    const inspected = await media.inspect(mediaContext(ADMINISTRATOR, 'req-inspect'), id);
    expect(inspected?.manifest.type).toBe('image/png');
  });

  test('records exactly one audit entry per successful upload, naming the asset', async () => {
    const response = await uploading({ filename: 'a.png', contentType: 'image/png', bytes: png(4, 4) });
    const id = response.json().data.stamp.id as string;
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      actor: ADMINISTRATOR,
      action: 'content.change',
      subject: `media:${id}`,
      outcome: 'allowed',
      detail: 'uploaded',
    });
  });

  test('a trail that refuses an entry does not cost the upload', async () => {
    identity = { ...identity, audit: { record: () => Promise.reject(new Error('the trail is unavailable')) } };
    await app.close();
    app = await served({ media });
    const response = await uploading({ filename: 'a.png', contentType: 'image/png', bytes: png(4, 4) });
    expect(response.statusCode).toBe(201);
  });
});

describe('listing media', () => {
  test('shows an editor active media only, even when archived=true is asked for', async () => {
    const id = await uploaded();
    await requesting('PATCH', `${MEDIA_PATH}/${id}/status`, admin, { archived: true });
    const editor = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [CONTENT_EDIT] });
    const response = await requesting('GET', `${MEDIA_PATH}?archived=true`, editor);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });

  test('shows archived media to an admin only when asked', async () => {
    const active = await uploaded(4);
    const archived = await uploaded(5);
    await requesting('PATCH', `${MEDIA_PATH}/${archived}/status`, admin, { archived: true });
    expect((await requesting('GET', MEDIA_PATH)).json().data.map((row: { stamp: { id: string } }) => row.stamp.id)).toEqual([active]);
    expect((await requesting('GET', `${MEDIA_PATH}?archived=true`)).json().data.map((row: { stamp: { id: string } }) => row.stamp.id)).toEqual([
      active,
      archived,
    ]);
  });
});

describe('inspecting media', () => {
  test('answers an existing item to a content editor and not-found for an unknown id', async () => {
    const id = await uploaded();
    const editor = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [CONTENT_EDIT] });
    const found = await requesting('GET', `${MEDIA_PATH}/${id}`, editor);
    expect(found.statusCode).toBe(200);
    expect(found.json().data.stamp.id).toBe(id);
    expect((await requesting('GET', `${MEDIA_PATH}/media-99`, editor)).statusCode).toBe(404);
  });

  test('hides the storage path from a content editor but not from media managers', async () => {
    const id = await uploaded();
    const editor = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [CONTENT_EDIT] });
    const manager = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [CONTENT_EDIT, MEDIA_MANAGE] });
    expect((await requesting('GET', `${MEDIA_PATH}/${id}`, editor)).json().data.storageKey).toBeUndefined();
    expect((await requesting('GET', `${MEDIA_PATH}/${id}`, manager)).json().data.storageKey).toBeTypeOf('string');
    expect((await requesting('GET', MEDIA_PATH, editor)).json().data[0].storageKey).toBeUndefined();
    expect((await requesting('GET', MEDIA_PATH, manager)).json().data[0].storageKey).toBeTypeOf('string');
  });

  test('gates an archived item by id the same way the list does', async () => {
    const id = await uploaded();
    await requesting('PATCH', `${MEDIA_PATH}/${id}/status`, admin, { archived: true });
    const editor = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [CONTENT_EDIT] });
    const manager = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [CONTENT_EDIT, MEDIA_MANAGE] });
    expect((await requesting('GET', `${MEDIA_PATH}/${id}`, editor)).statusCode).toBe(404);
    expect((await requesting('GET', `${MEDIA_PATH}/${id}`, manager)).statusCode).toBe(200);
  });
});

describe('changing media status', () => {
  test('archives and restores media, recording both changes', async () => {
    const id = await uploaded();
    const archived = await requesting('PATCH', `${MEDIA_PATH}/${id}/status`, admin, { archived: true });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().data.stamp.archivedAt).toBe(NOW);
    const restored = await requesting('PATCH', `${MEDIA_PATH}/${id}/status`, admin, { archived: false });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().data.stamp.archivedAt).toBeUndefined();
    expect(entries().slice(-2)).toMatchObject([
      { action: 'content.change', detail: 'archived' },
      { action: 'content.change', detail: 'restored' },
    ]);
  });

  test('refuses a second archive as a conflict', async () => {
    const id = await uploaded();
    await requesting('PATCH', `${MEDIA_PATH}/${id}/status`, admin, { archived: true });
    const response = await requesting('PATCH', `${MEDIA_PATH}/${id}/status`, admin, { archived: true });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
  });

  test('refuses malformed status bodies and unknown ids', async () => {
    expect((await requesting('PATCH', `${MEDIA_PATH}/media-1/status`, admin, {})).statusCode).toBe(422);
    expect((await requesting('PATCH', `${MEDIA_PATH}/media-99/status`, admin, { archived: true })).statusCode).toBe(404);
  });

  test('requires media.manage', async () => {
    const editor = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [CONTENT_EDIT] });
    expect((await requesting('PATCH', `${MEDIA_PATH}/media-1/status`, editor, { archived: true })).statusCode).toBe(403);
  });
});

describe('retrying media processing', () => {
  test('returns failed media to pending and records the retry', async () => {
    const id = await uploaded();
    await media.startProcessing(mediaContext(ADMINISTRATOR, 'req-start'), id);
    await media.failProcessing(mediaContext(ADMINISTRATOR, 'req-fail'), id);
    const response = await requesting('POST', `${MEDIA_PATH}/${id}/retry`, admin, {});
    expect(response.statusCode).toBe(200);
    expect(response.json().data.manifest.processingState).toBe('pending');
    expect(entries().at(-1)).toMatchObject({ action: 'content.change', detail: 'retried' });
  });

  test('refuses retrying non-failed media and unknown ids', async () => {
    const id = await uploaded();
    const nonFailed = await requesting('POST', `${MEDIA_PATH}/${id}/retry`, admin, {});
    expect(nonFailed.statusCode).toBe(409);
    expect(nonFailed.json().error.code).toBe(ENTITY_CONFLICT);
    expect((await requesting('POST', `${MEDIA_PATH}/media-99/retry`, admin, {})).statusCode).toBe(404);
  });

  test('requires media.manage', async () => {
    const editor = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [CONTENT_EDIT] });
    expect((await requesting('POST', `${MEDIA_PATH}/media-1/retry`, editor, {})).statusCode).toBe(403);
  });
});

describe('who may ask any of it', () => {
  test('every route here that changes something is behind the guard', () => {
    expect(mutatingRoutesOf(app)).toEqual([
      { method: 'POST', url: MEDIA_PATH },
      { method: 'PATCH', url: `${MEDIA_PATH}/:id/status` },
      { method: 'POST', url: `${MEDIA_PATH}/:id/retry` },
    ]);
  });

  test('refuses a request that carries no session, before upload() is ever reached', async () => {
    const response = await app.inject({
      method: 'POST',
      url: MEDIA_PATH,
      headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, origin: ORIGIN },
    });
    expect(response.statusCode).toBe(401);
    expect(upload).not.toHaveBeenCalled();
    expect(entries()).toEqual([]);
  });

  test('refuses a session that carries no media.manage permission, before upload() is ever reached', async () => {
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [] });
    const response = await uploading({ filename: 'a.png', contentType: 'image/png', bytes: png(4, 4) }, guest);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('the real, enforced size ceiling', () => {
  test('refuses a body over it before the file is fully read, and never reaches upload()', async () => {
    await app.close();
    app = await served({ media, ceiling: 16 });
    const response = await uploading({ filename: 'a.png', contentType: 'image/png', bytes: png(4, 4) });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('media.too_large');
    expect(upload).not.toHaveBeenCalled();
    expect(entries()).toEqual([]);
  });
});

describe('the pixel-count ceiling', () => {
  test('refuses a declared dimension over it before upload() decodes or stores anything', async () => {
    const huge = Math.ceil(Math.sqrt(MEDIA_PIXEL_CEILING)) + 1;
    const response = await uploading({ filename: 'bomb.png', contentType: 'image/png', bytes: png(huge, huge) });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields[0]).toMatchObject({ path: 'file', code: 'field.too_large' });
    expect(upload).not.toHaveBeenCalled();
    expect(entries()).toEqual([]);
  });

  test('a non-image file carries no declared dimension, and reaches upload() regardless', async () => {
    const response = await uploading({ filename: 'a.woff2', contentType: 'font/woff2', bytes: new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]) });
    expect(response.statusCode).toBe(201);
    expect(upload).toHaveBeenCalledTimes(1);
  });
});

describe('what MediaLibrary.upload() refuses', () => {
  test('a type this server does not recognise is a 422 field refusal, not a 500', async () => {
    const response = await uploading({ filename: 'a.txt', contentType: 'text/plain', bytes: new TextEncoder().encode('not media') });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields[0]).toMatchObject({ path: 'file', code: 'field.not_allowed' });
    expect(entries()).toEqual([]);
  });

  test('bytes already in the library are a 409 conflict, not a duplicate record', async () => {
    const first = await uploading({ filename: 'a.png', contentType: 'image/png', bytes: png(4, 4) });
    expect(first.statusCode).toBe(201);
    const second = await uploading({ filename: 'a.png', contentType: 'image/png', bytes: png(4, 4) });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe(ENTITY_CONFLICT);
    expect(entries()).toHaveLength(1);
  });
});

describe('a request malformed before a file is even read', () => {
  test('refuses a request that is not multipart at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: MEDIA_PATH,
      headers: {
        [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
        host: HOST,
        'x-forwarded-proto': 'https',
        origin: ORIGIN,
        cookie: sessionCookie(admin.token, 60),
        [CSRF_HEADER]: admin.record.csrf,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({}),
    });
    expect(response.statusCode).toBe(422);
    expect(upload).not.toHaveBeenCalled();
  });

  test('refuses a multipart request carrying no file part', async () => {
    const body = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="notes"\r\n\r\nhello\r\n--${BOUNDARY}--\r\n`);
    const response = await app.inject({ method: 'POST', url: MEDIA_PATH, headers: withHeaders(), payload: body });
    expect(response.statusCode).toBe(422);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('what this surface refuses to answer at all', () => {
  test('a deployment that keeps no identity serves the path and answers not-found', async () => {
    await app.close();
    app = await served({ media: undefined, noIdentity: true });
    const response = await uploading({ filename: 'a.png', contentType: 'image/png', bytes: png(4, 4) });
    expect(response.statusCode).toBe(404);
  });
});
