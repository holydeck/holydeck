import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { MEDIA_MANAGE } from './roles.js';
import { mediaContext, mediaLibraryOn } from './media.js';
import { MEDIA_PATH, MEDIA_PIXEL_CEILING, serveMediaRoutes } from './media-routes.js';
import { passkeysOn } from './passkeys.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { fakeMediaPurgeDb } from '../test/helpers/media-purge-db.js';
import { fakeMediaStorageIO } from '../test/helpers/media-storage-io.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { MediaLibrary } from './media.js';
import type { Document } from './repositories.js';
import type { SettingsAdmin } from './settings-admin.js';
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
let mediaRoot: string;
let freeSpaceReserveBytes: number;

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

const settingsAdmin: Pick<SettingsAdmin, 'current'> = {
  current: () => ({
    values: { ...DEFAULT_SETTINGS, mediaRoot, mediaFreeSpaceReserveBytes: freeSpaceReserveBytes },
    sources: {} as never,
    path: '/data/holydeck/config/settings.yaml',
  }),
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
  serveMediaRoutes(built, {
    media: options.media,
    identity: options.noIdentity === true ? undefined : identity,
    settingsAdmin,
  });
  await built.ready();
  return built;
};

beforeEach(async () => {
  trail = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now });
  mediaRoot = join(tmpdir(), `holydeck-media-routes-${Math.random().toString(36).slice(2)}`);
  await mkdir(mediaRoot, { recursive: true });
  freeSpaceReserveBytes = 0;
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
  const db = fakeDb();
  const real = mediaLibraryOn(db, {
    now,
    newId: () => `media-${(serial += 1)}`,
    mediaRoot: () => mediaRoot,
    write: io.write,
    read: io.read,
    remove: io.remove,
    purge: fakeMediaPurgeDb(db),
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

describe('who may ask any of it', () => {
  test('every route here changes something, and so it is behind the guard', () => {
    expect(mutatingRoutesOf(app)).toEqual([{ method: 'POST', url: MEDIA_PATH }]);
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

describe('the free-space reserve', () => {
  test('accepts an upload when free space comfortably clears the reserve', async () => {
    freeSpaceReserveBytes = 0;
    const response = await uploading({ filename: 'a.png', contentType: 'image/png', bytes: png(4, 4) });
    expect(response.statusCode).toBe(201);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  test('refuses an upload that would leave free space under the reserve, and never reaches upload()', async () => {
    freeSpaceReserveBytes = Number.MAX_SAFE_INTEGER;
    const response = await uploading({ filename: 'a.png', contentType: 'image/png', bytes: png(4, 4) });
    expect(response.statusCode).toBe(507);
    expect(response.json().error.code).toBe('media.insufficient_space');
    expect(upload).not.toHaveBeenCalled();
    expect(entries()).toEqual([]);
  });

  // A fresh volume has nothing written to it yet, so `mediaRoot` itself may not exist — the same state
  // `write()` already handles by mkdir'ing lazily on the first accepted upload. This check runs before
  // that, so it has to make the same allowance itself rather than reading `statfs` a beat too early and
  // refusing every upload with 507 until something else happens to create the directory first.
  test('creates the media root first when nothing has written to it yet, rather than failing closed', async () => {
    await rm(mediaRoot, { recursive: true, force: true });
    const response = await uploading({ filename: 'a.png', contentType: 'image/png', bytes: png(4, 4) });
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
