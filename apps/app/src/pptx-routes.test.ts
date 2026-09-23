import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT } from '@holydeck/contracts/http';
import { PPTX_IMPORTS_PATH } from '@holydeck/contracts/pptx';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import { HolyDeckError } from '@holydeck/core/messages';
import { PPTX_MAX_ENTRIES, PPTX_MAX_ENTRY_BYTES, PPTX_MAX_TOTAL_BYTES } from '@holydeck/core/pptx';
import Fastify from 'fastify';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { guardMutations } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { passkeysOn } from './passkeys.js';
import { pptxCommitOn } from './pptx-commit.js';
import { pptxImportOn } from './pptx-import.js';
import { pptxReviewOn } from './pptx-review.js';
import { PPTX_COMMIT_PATH, PPTX_ID_PATH, PPTX_REVIEW_PATH, servePptxRoutes } from './pptx-routes.js';
import { pptxSessionsOn } from './pptx-sessions.js';
import { SERVICES_MANAGE } from './roles.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { slideLabelContext, slideLabelsOn } from './slide-labels.js';
import { songContext, songsOn } from './songs.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { fakeMediaStorageIO } from '../test/helpers/media-storage-io.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { PptxImport, PptxImportResult } from './pptx-import.js';
import type { PptxRoutesOptions } from './pptx-routes.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const START = Date.parse('2026-09-22T09:30:00.000Z');
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-5e1d7b20';
const OPERATOR = `account:${'P'.repeat(22)}`;
const OTHER = `account:${'Q'.repeat(22)}`;
const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// Minimal OOXML builder, adapted from `pptx-import.test.ts` — just enough of a package for the route
// to drive a real extraction through.
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';

const textShapeXml = (text: string, id: number): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
  `<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

function buildPptx(slides: string[]): Uint8Array {
  const relIds = slides.map((_, index) => `rId${index + 1}`);
  const rels = relIds.map((id, index) => `<Relationship Id="${id}" Type="${SLIDE_REL_TYPE}" Target="slides/slide${index + 1}.xml"/>`).join('');
  const files: Record<string, Uint8Array> = {
    'ppt/presentation.xml': strToU8(
      `<p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}" xmlns:a="${A_NS}"><p:sldIdLst>` +
        `${relIds.map((id, index) => `<p:sldId id="${256 + index}" r:id="${id}"/>`).join('')}</p:sldIdLst></p:presentation>`,
    ),
    'ppt/_rels/presentation.xml.rels': strToU8(`<Relationships xmlns="${RELS_NS}">${rels}</Relationships>`),
    'docProps/core.xml': strToU8(
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
        'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Route Deck</dc:title><dc:creator>Choir</dc:creator></cp:coreProperties>',
    ),
  };
  slides.forEach((shapes, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(
      `<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`,
    );
  });
  return zipSync(files);
}

const DECK = buildPptx([textShapeXml('Amazing grace', 2) + textShapeXml('How sweet the sound', 3), textShapeXml('x2', 2)]);

// AUTH-13's own family of crafted archives, uploaded through the real (unstubbed) `pptxImport` store —
// `openArchive`'s bounds (packages/core/src/pptx.ts) fire inside `unzipSync`'s own filter callback for
// every entry, before any part is ever read, so none of these need a valid deck structure. Store mode
// (`level: 0`, no DEFLATE) keeps the too-many-entries and single-entry-too-large fixtures cheap to build
// while staying under the route's own 100 MB bodyLimit unchanged.
const TOO_MANY_ENTRIES = zipSync(
  Object.fromEntries(Array.from({ length: PPTX_MAX_ENTRIES + 1 }, (_, index) => [`f${index}.bin`, strToU8('')])),
);
const ENTRY_TOO_LARGE = zipSync({ 'big.bin': [new Uint8Array(PPTX_MAX_ENTRY_BYTES + 1), { level: 0 }] });
const UNSAFE_ENTRY_NAME = zipSync({ '../evil.xml': strToU8('x') });

// A real zip bomb, not just a big body (Fastify's own bodyLimit is tested separately above): highly
// compressible zero-filled entries, each under the per-entry cap, whose declared total tips over
// PPTX_MAX_TOTAL_BYTES once unzipped, while the physical upload stays a few hundred KB. Built lazily
// (not at module scope) since the real DEFLATE pass over ~250 MB takes a couple of seconds.
function buildArchiveTooLarge(): Uint8Array {
  const perEntry = PPTX_MAX_ENTRY_BYTES - 1024;
  const entryCount = Math.ceil(PPTX_MAX_TOTAL_BYTES / perEntry);
  const files: Record<string, Uint8Array> = {};
  for (let index = 0; index < entryCount; index += 1) files[`big${index}.bin`] = new Uint8Array(perEntry);
  return zipSync(files);
}
const ALL_VERSE = { decisions: [
  { slideIndex: 0, blockIndex: 0, label: 'Verse' },
  { slideIndex: 0, blockIndex: 1, label: 'Verse' },
  { slideIndex: 1, blockIndex: 0, label: 'Verse' },
] };
const CREATE = { mode: 'create', title: { tamil: 'அருமை', romanized: 'Arumai' }, reference: 'deck.pptx' };

let app: FastifyInstance;
let sessions: SessionStore;
let identity: Identity;
let operator: StartedSession;
let db: FakeDb;
let tick: number;
let routes: Omit<PptxRoutesOptions, 'identity'>;

const now = (): string => new Date(START + (tick += 1) * 1000).toISOString();
const at = (path: string, id: string): string => path.replace(':id', id);
const headers = (held: StartedSession = operator) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, 'x-forwarded-proto': 'https', origin: ORIGIN,
  cookie: sessionCookie(held.token, 60), [CSRF_HEADER]: held.record.csrf,
});
type Method = 'GET' | 'POST' | 'DELETE';
type Body = { readonly data: Record<string, unknown>; readonly error: { readonly code: string; readonly fields: readonly { readonly path: string; readonly code: string }[]; readonly problems: readonly Record<string, unknown>[] } };
type Response = { readonly statusCode: number; json(): Body };
const ask = (method: Method, url: string, payload?: unknown, held: StartedSession = operator): Promise<Response> =>
  app.inject({ method, url, headers: headers(held), ...(payload === undefined ? {} : { payload: payload as never }) }) as Promise<Response>;
const upload = (bytes: Uint8Array | string = DECK, held: StartedSession = operator): Promise<Response> =>
  app.inject({
    method: 'POST', url: PPTX_IMPORTS_PATH,
    headers: { ...headers(held), 'content-type': PPTX_TYPE, 'x-file-name': 'deck.pptx' },
    payload: typeof bytes === 'string' ? bytes : Buffer.from(bytes),
  }) as Promise<Response>;
const uploaded = async (): Promise<string> => (await upload()).json().data['id'] as string;
const reviewed = async (): Promise<string> => {
  const id = await uploaded();
  expect((await ask('POST', at(PPTX_REVIEW_PATH, id), ALL_VERSE)).statusCode).toBe(200);
  return id;
};

const serving = async (options: Partial<PptxRoutesOptions> = {}): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  app.addContentTypeParser(PPTX_TYPE, { parseAs: 'buffer' }, (_request, payload, done) => done(null, payload));
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  servePptxRoutes(app, { ...routes, identity, ...options });
  await app.ready();
};

beforeEach(async () => {
  tick = 0;
  db = fakeDb();
  let serial = 0;
  const newId = () => `id-${(serial += 1)}`;
  const io = fakeMediaStorageIO();
  sessions = sessionsOn(memorySessions().db, { now: () => new Date(START).toISOString() });
  identity = {
    accounts: accountsOn(memoryAccounts().db, { now, newId: () => 'A'.repeat(22), hash: async (password) => `test-hash:${password}`, verify: async (password, stored) => stored === `test-hash:${password}` }),
    audit: auditOn(db, { now, newId }), attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }), passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  routes = {
    pptxImport: pptxImportOn(db, {
      now, newId, mediaRoot: '/media', write: io.write, read: io.read,
      queue: { enqueue: async () => ({ id: `job-${(serial += 1)}`, created: true }) },
    }),
    pptxReview: pptxReviewOn(db, { now }),
    pptxCommit: pptxCommitOn(db, { now, newId }),
    pptxSessions: pptxSessionsOn(db, { now, newId }),
  };
  await slideLabelsOn(db, { now }).create(slideLabelContext(OPERATOR, CORRELATION), { name: 'Verse' });
  await serving();
  operator = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [SERVICES_MANAGE] });
});

afterEach(async () => app.close());

describe('POST /api/v1/pptx-imports', () => {
  test('creates a session and answers slides with mediaIds', async () => {
    const response = await upload();
    expect(response.statusCode).toBe(201);
    const data = response.json().data;
    expect(typeof data['id']).toBe('string');
    expect(data['fileName']).toBe('deck.pptx');
    expect(data['slides']).toEqual([
      { textBlocks: ['Amazing grace', 'How sweet the sound'], mediaIds: [] },
      { textBlocks: ['x2'], mediaIds: [] },
    ]);
    expect(data['provenance']).toEqual({ title: 'Route Deck', source: 'Choir' });
    const trail = (db.rows.get('audit_events') ?? []).find((row) => row['detail'] === 'imported');
    expect(trail).toMatchObject({ action: 'pptx.import', subject: `pptxImport:${data['id'] as string}` });
  });

  test('answers 413 pptx.too_large for a body over the configured limit', async () => {
    await app.close();
    await serving({ bodyLimit: 64 });
    const response = await upload(new Uint8Array(128));
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('pptx.too_large');
  });

  test('answers 422 pptx.invalid_format for a non-zip body', async () => {
    const response = await upload('this is not a presentation');
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('pptx.invalid_format');
  });

  test('answers 422 pptx.invalid_format for a zip that is not a presentation', async () => {
    const response = await upload(zipSync({ 'readme.txt': strToU8('hello') }));
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('pptx.invalid_format');
  });

  test('answers 422 pptx.invalid_format when the body is not sent as raw bytes', async () => {
    const response = await ask('POST', PPTX_IMPORTS_PATH, { slides: [] });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('pptx.invalid_format');
  });

  test('answers 415 pptx.invalid_format for a content type no parser reads', async () => {
    const response = await app.inject({
      method: 'POST', url: PPTX_IMPORTS_PATH, headers: { ...headers(), 'content-type': 'application/octet-stream' }, payload: Buffer.from(DECK),
    }) as Response;
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe('pptx.invalid_format');
  });

  test('answers 500 for an import failure that is not a format refusal', async () => {
    await app.close();
    await serving({ pptxImport: { import: () => Promise.reject(new Error('disk full')) } });
    expect((await upload()).statusCode).toBe(500);
  });

  // These four go through the real (unstubbed) pptxImport store wired in beforeEach, uploading crafted
  // archives that trip openArchive's own limits (packages/core/src/pptx.ts) rather than stubbing the
  // store's rejection — proving the route really enforces them, not just that it maps the error codes.
  test('answers 413 pptx.too_large for an archive over the entry-count limit', async () => {
    const response = await upload(TOO_MANY_ENTRIES);
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('pptx.too_large');
  });

  test('answers 413 pptx.too_large for a single entry over the per-entry size limit', async () => {
    const response = await upload(ENTRY_TOO_LARGE);
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('pptx.too_large');
  });

  test('answers 413 pptx.too_large for an archive over the total-decompressed-size limit', async () => {
    const response = await upload(buildArchiveTooLarge());
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('pptx.too_large');
  }, 20_000);

  test('answers 422 pptx.invalid_format for an unsafe entry name', async () => {
    const response = await upload(UNSAFE_ENTRY_NAME);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('pptx.invalid_format');
  });

  test('refuses a second concurrent import for the same account with 409 pptx.import_in_progress', async () => {
    const releases: ((result: PptxImportResult) => void)[] = [];
    let started: () => void = () => undefined;
    const nextStart = (): Promise<void> => new Promise((resolve) => { started = resolve; });
    const blocking: PptxImport = {
      import: () => new Promise((resolve) => { releases.push(resolve); started(); }),
    };
    await app.close();
    await serving({ pptxImport: blocking });
    let running = nextStart();
    const first = upload();
    await running;
    const second = await upload();
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('pptx.import_in_progress');
    releases[0]?.({ slides: [{ textBlocks: ['a'], media: [] }], skippedMedia: [], provenance: {} });
    expect((await first).statusCode).toBe(201);
    running = nextStart();
    const third = upload();
    await running;
    releases[1]?.({ slides: [{ textBlocks: ['b'], media: [] }], skippedMedia: [], provenance: {} });
    expect((await third).statusCode).toBe(201);
  });

  test('audits a refused upload under pptxImport:upload', async () => {
    const refusedTrail = () =>
      (db.rows.get('audit_events') ?? []).filter((row) => row['outcome'] === 'refused' && row['subject'] === 'pptxImport:upload');

    await ask('POST', PPTX_IMPORTS_PATH, { slides: [] });
    expect(refusedTrail()).toHaveLength(1);
    expect(refusedTrail()[0]).toMatchObject({ action: 'pptx.import', outcome: 'refused' });

    await app.close();
    await serving({ pptxImport: { import: () => Promise.reject(new HolyDeckError('pptx_too_many_entries', { max: 2000 })) } });
    await upload();
    expect(refusedTrail()).toHaveLength(2);

    await app.close();
    await serving({ pptxImport: { import: () => Promise.reject(new HolyDeckError('pptx_unsafe_entry_name', { name: '../evil.xml' })) } });
    await upload();
    expect(refusedTrail()).toHaveLength(3);
  });

  test('audits a refused upload with an import already in progress', async () => {
    let started: () => void = () => undefined;
    const nextStart = (): Promise<void> => new Promise((resolve) => { started = resolve; });
    const releases: ((result: PptxImportResult) => void)[] = [];
    const blocking: PptxImport = {
      import: () => new Promise((resolve) => { releases.push(resolve); started(); }),
    };
    await app.close();
    await serving({ pptxImport: blocking });
    const running = nextStart();
    const first = upload();
    await running;
    await upload();
    const trail = (db.rows.get('audit_events') ?? []).find((row) => row['subject'] === 'pptxImport:upload' && row['outcome'] === 'refused');
    expect(trail).toMatchObject({ action: 'pptx.import', outcome: 'refused' });
    releases[0]?.({ slides: [{ textBlocks: ['a'], media: [] }], skippedMedia: [], provenance: {} });
    await first;
  });
});

describe('GET /api/v1/pptx-imports/:id', () => {
  test('answers the caller’s own session', async () => {
    const id = await uploaded();
    const response = await ask('GET', at(PPTX_ID_PATH, id));
    expect(response.statusCode).toBe(200);
    expect(response.json().data['id']).toBe(id);
  });

  test('answers 404 for another account’s session', async () => {
    const id = await uploaded();
    const other = await sessions.start(sessionContext(CORRELATION), { actor: OTHER, permissions: [SERVICES_MANAGE] });
    expect((await ask('GET', at(PPTX_ID_PATH, id), undefined, other)).statusCode).toBe(404);
    expect((await ask('GET', at(PPTX_ID_PATH, 'missing'))).statusCode).toBe(404);
  });
});

describe('POST /api/v1/pptx-imports/:id/review', () => {
  test('stores the reviewed blocks on the session', async () => {
    const id = await uploaded();
    const response = await ask('POST', at(PPTX_REVIEW_PATH, id), ALL_VERSE);
    expect(response.statusCode).toBe(200);
    expect(response.json().data['reviewed']).toHaveLength(3);
    expect(typeof response.json().data['reviewedAt']).toBe('string');
  });

  test('passes through problems[] with slideIndex, blockIndex and kind on refusal', async () => {
    const id = await uploaded();
    const response = await ask('POST', at(PPTX_REVIEW_PATH, id), { decisions: [{ slideIndex: 0, blockIndex: 0, label: 'Nope' }] });
    expect(response.statusCode).toBe(422);
    const { error } = response.json();
    expect(error.problems).toEqual([
      expect.objectContaining({ slideIndex: 0, blockIndex: 0, kind: 'unknown-label' }),
      expect.objectContaining({ slideIndex: 0, blockIndex: 1, kind: 'unreviewed' }),
      expect.objectContaining({ slideIndex: 1, blockIndex: 0, kind: 'unreviewed' }),
    ]);
    expect(error.fields[0]).toEqual(expect.objectContaining({ path: 'slides.0.textBlocks.0', code: 'unknown-label' }));
  });

  test('answers 422 for a malformed body and 404 for a missing session', async () => {
    const id = await uploaded();
    expect((await ask('POST', at(PPTX_REVIEW_PATH, id), [{ slideIndex: 0 }])).statusCode).toBe(422);
    expect((await ask('POST', at(PPTX_REVIEW_PATH, id), { decisions: [{ slideIndex: 'a' }] })).statusCode).toBe(422);
    expect((await ask('POST', at(PPTX_REVIEW_PATH, 'missing'), ALL_VERSE)).statusCode).toBe(404);
  });
});

describe('POST /api/v1/pptx-imports/:id/commit', () => {
  test('answers 409 pptx.not_reviewed before review has succeeded', async () => {
    const id = await uploaded();
    const response = await ask('POST', at(PPTX_COMMIT_PATH, id), CREATE);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('pptx.not_reviewed');
  });

  test('creates a new song and answers an import report', async () => {
    const id = await reviewed();
    const response = await ask('POST', at(PPTX_COMMIT_PATH, id), CREATE);
    expect(response.statusCode).toBe(201);
    const { song, report } = response.json().data as {
      readonly song: { readonly stamp: { readonly id: string }; readonly body: { readonly languages: readonly string[]; readonly sections: readonly { readonly repeat?: unknown }[]; readonly provenance: Record<string, unknown> } };
      readonly report: Record<string, unknown>;
    };
    expect(song.body.sections).toHaveLength(2);
    expect(song.body.sections[1]?.repeat).toEqual({ count: 2 });
    expect(song.body.provenance).toMatchObject({ source: 'import', importer: 'powerpoint', reference: 'deck.pptx' });
    expect(report).toEqual({
      slides: 2,
      blocks: 3,
      languages: song.body.languages,
      labelsUsed: ['Verse'],
      skippedMedia: [],
      provenance: { title: 'Route Deck', source: 'Choir' },
      target: CREATE,
    });
    const trail = (db.rows.get('audit_events') ?? []).find((row) => row['detail'] === `committed as ${song.stamp.id}`);
    expect(trail).toMatchObject({ action: 'pptx.commit', subject: `pptxImport:${id}` });
  });

  test('refuses a second commit racing the same session, and creates only one song', async () => {
    const id = await reviewed();
    const before = (db.rows.get('content_library') ?? []).length;

    // What a real second commit racing this one's own claim would collide on — the same duplicate key
    // `pptx-sessions.test.ts` forces directly, forced here instead at the seam the route calls through.
    db.failOn = (collection) => (collection === 'pptx_import_sessions' ? Object.assign(new Error('E11000 duplicate key'), { code: 11_000 }) : undefined);
    const loser = await ask('POST', at(PPTX_COMMIT_PATH, id), CREATE);
    db.failOn = undefined;
    expect(loser.statusCode).toBe(409);
    expect(loser.json().error.code).toBe(ENTITY_CONFLICT);
    expect((db.rows.get('content_library') ?? []).length).toBe(before);

    const winner = await ask('POST', at(PPTX_COMMIT_PATH, id), CREATE);
    expect(winner.statusCode).toBe(201);
    expect((db.rows.get('content_library') ?? []).length).toBe(before + 1);
  });

  test('appends onto an existing song', async () => {
    const existing = await songsOn(db, { now }).create(songContext(OPERATOR, CORRELATION), 'Arumai', {
      titles: { tamil: 'அருமை', romanized: 'Arumai' }, languages: ['ta-Latn'],
      sections: [{ id: 's1', label: 'Verse', text: [{ languageKey: 'ta-Latn', text: 'first' }] }],
      provenance: { source: 'manual' },
    });
    const id = await reviewed();
    const response = await ask('POST', at(PPTX_COMMIT_PATH, id), { mode: 'append', id: existing.stamp.id });
    expect(response.statusCode).toBe(200);
    const { song } = response.json().data as { readonly song: { readonly body: { readonly sections: readonly unknown[] } } };
    expect(song.body.sections).toHaveLength(3);
  });

  test('answers 409 for an append target naming a song that does not exist', async () => {
    const id = await reviewed();
    const response = await ask('POST', at(PPTX_COMMIT_PATH, id), { mode: 'append', id: 'no-such-song' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
    expect((await ask('GET', at(PPTX_ID_PATH, id))).statusCode).toBe(200);
  });

  test('answers 500 for a commit failure that is not a refusal', async () => {
    await app.close();
    await serving({ pptxCommit: { commit: () => Promise.reject(new Error('disk full')) } });
    const id = await reviewed();
    expect((await ask('POST', at(PPTX_COMMIT_PATH, id), CREATE)).statusCode).toBe(500);
  });

  test('answers 422 for a malformed target and 404 for a missing session', async () => {
    const id = await reviewed();
    expect((await ask('POST', at(PPTX_COMMIT_PATH, id), { mode: 'other' })).statusCode).toBe(422);
    expect((await ask('POST', at(PPTX_COMMIT_PATH, 'missing'), CREATE)).statusCode).toBe(404);
  });

  test('deletes the session after a successful commit', async () => {
    const id = await reviewed();
    expect((await ask('POST', at(PPTX_COMMIT_PATH, id), CREATE)).statusCode).toBe(201);
    expect((await ask('GET', at(PPTX_ID_PATH, id))).statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/pptx-imports/:id', () => {
  test('discards the session', async () => {
    const id = await uploaded();
    const response = await app.inject({ method: 'DELETE', url: at(PPTX_ID_PATH, id), headers: headers() });
    expect(response.statusCode).toBe(204);
    expect((await ask('GET', at(PPTX_ID_PATH, id))).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: at(PPTX_ID_PATH, id), headers: headers() })).statusCode).toBe(404);
  });
});

describe('pptx route guards', () => {
  test('refuses a session without services.manage', async () => {
    const member = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [] });
    expect((await ask('GET', at(PPTX_ID_PATH, 'x'), undefined, member)).statusCode).toBe(403);
  });

  test('keeps writing when the audit trail refuses an entry', async () => {
    await app.close();
    identity = { ...identity, audit: { ...identity.audit, record: () => Promise.reject(new Error('trail down')) } };
    await serving();
    expect((await upload()).statusCode).toBe(201);
  });

  test.each([
    ['POST', PPTX_IMPORTS_PATH], ['GET', PPTX_ID_PATH], ['POST', PPTX_REVIEW_PATH], ['POST', PPTX_COMMIT_PATH], ['DELETE', PPTX_ID_PATH],
  ])('answers not-found for %s %s without the stores', async (method, path) => {
    await app.close();
    await serving({ pptxSessions: undefined });
    const response = await ask(method as Method, at(path, 'x'), method === 'POST' ? {} : undefined);
    expect(response.statusCode).toBe(404);
  });
});
