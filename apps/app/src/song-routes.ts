import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, locatedValidationFailure, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import {
  SONG_PATH,
  SONGS_PATH,
  parseSongDraft,
  parseSongEdit,
  parseSongGeneration,
  parseSongImportRequest,
  parseSongSingerChordsDraft,
} from '@holydeck/contracts/songs';
import { FIELD_CODES } from '@holydeck/contracts/problems';

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { settled } from './refusals.js';
import { CONTENT_EDIT } from './roles.js';
import { SongError, songContext, subjectFor } from './songs.js';
import { SongSingerChordsError, songSingerChordsContext, subjectFor as chordSubjectFor } from './song-singer-chords.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { SongRefusal, SongStore } from './songs.js';
import type { SongSingerChordsStore } from './song-singer-chords.js';
import type { LocatedProblem } from './song-yaml.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const SONG_PREFIX = 'song:';

export const SONG_ID_PATH = `${SONGS_PATH}/:id`;
const SONG_RAW_PATH = `${SONG_ID_PATH}/raw`;
const SONG_EXPORT_PATH = `${SONG_ID_PATH}/export`;
const SONG_HISTORY_PATH = `${SONG_ID_PATH}/history`;
const SONG_SLIDES_PATH = `${SONG_ID_PATH}/slides`;
const SONG_IMPORT_PATH = `${SONGS_PATH}/import`;
const SONG_SINGER_CHORDS_PATH = `${SONG_ID_PATH}/singers/:singerId/chords`;

const PERMISSION: RouteNeed = { kind: 'permission', need: CONTENT_EDIT };

const ROUTES = [
  ['POST', SONGS_PATH],
  ['GET', SONG_ID_PATH],
  ['PUT', SONG_ID_PATH],
  ['GET', SONG_RAW_PATH],
  ['PUT', SONG_RAW_PATH],
  ['GET', SONG_EXPORT_PATH],
  ['POST', SONG_IMPORT_PATH],
  ['GET', SONG_HISTORY_PATH],
  ['POST', SONG_SLIDES_PATH],
  ['POST', SONG_SINGER_CHORDS_PATH],
  ['GET', SONG_SINGER_CHORDS_PATH],
  ['PUT', SONG_SINGER_CHORDS_PATH],
] as const;

const ORDINAL = /^[1-9][0-9]*$/u;
const ordinalIn = (value: unknown): number | undefined =>
  typeof value === 'string' && ORDINAL.test(value) ? Number(value) : undefined;
const NOT_AN_ORDINAL = [
  { path: 'revision', code: FIELD_CODES.notANumber, message: 'must be an ordinal counting from one' },
];

const idIn = (request: FastifyRequest): string => (request.params as { readonly id: string }).id;

// A path param, not the stamp this song was actually found by, so it is escaped before landing in a
// quoted header value rather than trusted to already be free of '"', '\' and control characters.
const attachmentName = (id: string): string => `${id.replace(/["\\\r\n]/gu, '_')}.json`;

const singerIdIn = (request: FastifyRequest): string =>
  (request.params as { readonly id: string; readonly singerId: string }).singerId;

// `song-singer-chords.ts`'s `idFor` joins songId and singerId with `:` to make one identity for the
// pair; a singerId carrying that separator could otherwise misread as a different pair's identity.
const SINGER_ID_PROBLEM = [
  { path: 'singerId', code: FIELD_CODES.notAllowed, message: 'must not be empty or contain \':\'' },
];
const singerIdInvalid = (singerId: string): boolean => singerId.length === 0 || singerId.includes(':');

const isRefusal = (error: unknown): error is SongError & { kind: 'state' | 'conflict' } =>
  error instanceof SongError && (error.kind === 'state' || error.kind === 'conflict');

const isChordRefusal = (error: unknown): error is SongSingerChordsError & { kind: 'state' | 'conflict' } =>
  error instanceof SongSingerChordsError && (error.kind === 'state' || error.kind === 'conflict');

type TextAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: SongRefusal; readonly message: string; readonly problems: readonly LocatedProblem[] };

async function settledText<T>(work: () => Promise<T>): Promise<TextAnswer<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof SongError && error.kind !== 'corrupt') {
      return { ok: false, kind: error.kind, message: error.message, problems: error.problems };
    }
    throw error;
  }
}

export interface SongRoutesOptions {
  readonly songs: SongStore | undefined;
  readonly chords: SongSingerChordsStore | undefined;
  readonly identity: Identity | undefined;
}

export function serveSongRoutes(app: FastifyInstance, { songs, chords, identity }: SongRoutesOptions): void {
  if (identity === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({ method, url, config: { need: PERMISSION }, handler: (request, reply) => reply.code(404).send(notFound(request)) });
    }
    return;
  }

  const store = songs as SongStore;
  const chordsStore = chords as SongSingerChordsStore;
  const call = (request: FastifyRequest) =>
    songContext(provenSession(request).record.actor, correlationFor(SONG_PREFIX, request.id));
  const note = async (request: FastifyRequest, id: string, outcome: AuditOutcome, detail: string): Promise<void> => {
    try {
      await identity.audit.record(
        auditContext(provenSession(request).record.actor, correlationFor(SONG_PREFIX, request.id)),
        { action: 'content.change', subject: subjectFor(id), outcome, detail },
      );
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the song trail refused an entry');
    }
  };
  const noteChord = async (
    request: FastifyRequest,
    songId: string,
    singerId: string,
    outcome: AuditOutcome,
    detail: string,
  ): Promise<void> => {
    try {
      await identity.audit.record(
        auditContext(provenSession(request).record.actor, correlationFor(SONG_PREFIX, request.id)),
        { action: 'content.change', subject: chordSubjectFor(songId, singerId), outcome, detail },
      );
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the song-singer chord trail refused an entry');
    }
  };

  app.post(SONGS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSongDraft(request.body, SONG_PATH);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() => store.create(call(request), parsed.value.title, parsed.value.body), isRefusal);
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    await note(request, answer.value.stamp.id, 'allowed', 'created');
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SONG_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const asked = (request.query as { readonly revision?: string }).revision;
    const revision = ordinalIn(asked);
    if (asked !== undefined && revision === undefined) return reply.code(422).send(validationFailure(request.id, NOT_AN_ORDINAL));
    const current = await store.current(call(request), idIn(request), revision);
    if (current === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(current, request.id, CLIENT_WINDOW.current));
  });

  app.put(SONG_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSongEdit(request.body, SONG_PATH);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    // The revision check lives in the save itself, so a stale save is shelved for the conflict banner
    // rather than only refused, and no second writer can land between a check here and the append.
    const answer = await settled(() => store.edit(call(request), id, parsed.value.body, parsed.value.expectedRevision), isRefusal);
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', `saved revision ${answer.value.revision}`);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SONG_RAW_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const asked = (request.query as { readonly revision?: string }).revision;
    const revision = ordinalIn(asked);
    if (asked !== undefined && revision === undefined) return reply.code(422).send(validationFailure(request.id, NOT_AN_ORDINAL));
    const text = await store.raw(call(request), idIn(request), revision);
    if (text === undefined) return reply.code(404).send(notFound(request));
    return reply.type('text/yaml').send(text);
  });

  app.put(SONG_RAW_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    if (typeof request.body !== 'string') {
      return reply.code(422).send(validationFailure(request.id, [{ path: 'body', code: FIELD_CODES.notText, message: 'must be sent as text' }]));
    }
    const id = idIn(request);
    const answer = await settledText(() => store.editRaw(call(request), id, request.body as string));
    if (!answer.ok) {
      return answer.kind === 'schema'
        ? reply.code(422).send(locatedValidationFailure(request.id, answer.problems))
        : reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    }
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, id, 'allowed', `saved raw revision ${answer.value.revision}`);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SONG_EXPORT_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const asked = (request.query as { readonly revision?: string }).revision;
    const revision = ordinalIn(asked);
    if (asked !== undefined && revision === undefined) return reply.code(422).send(validationFailure(request.id, NOT_AN_ORDINAL));
    const id = idIn(request);
    const text = await store.exportPortable(call(request), id, revision);
    if (text === undefined) return reply.code(404).send(notFound(request));
    return reply.header('content-disposition', `attachment; filename="${attachmentName(id)}"`).type('application/json').send(text);
  });

  app.post(SONG_IMPORT_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSongImportRequest(request.body, SONG_PATH);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settledText(() => store.importPortable(call(request), parsed.value.title, parsed.value.text));
    if (!answer.ok) {
      return answer.kind === 'schema'
        ? reply.code(422).send(validationFailure(request.id, answer.problems))
        : reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    }
    await note(request, answer.value.stamp.id, 'allowed', 'imported');
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SONG_HISTORY_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const history = await store.history(call(request), idIn(request));
    if (history.length === 0) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(history, request.id, CLIENT_WINDOW.current));
  });

  app.post(SONG_SLIDES_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSongGeneration(request.body, SONG_PATH);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const answer = await settled(() => store.generate(call(request), id, parsed.value), isRefusal);
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    await note(request, id, 'allowed', 'generated slides');
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SONG_SINGER_CHORDS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSongSingerChordsDraft(request.body, 'songSingerChords');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const songId = idIn(request);
    const singerId = singerIdIn(request);
    if (singerIdInvalid(singerId)) return reply.code(422).send(validationFailure(request.id, SINGER_ID_PROBLEM));
    if ((await store.current(call(request), songId)) === undefined) return reply.code(404).send(notFound(request));
    const answer = await settled(
      () => chordsStore.create(songSingerChordsContext(provenSession(request).record.actor, correlationFor(SONG_PREFIX, request.id)), songId, singerId, parsed.value),
      isChordRefusal,
    );
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    await noteChord(request, songId, singerId, 'allowed', 'created');
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SONG_SINGER_CHORDS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const songId = idIn(request);
    const singerId = singerIdIn(request);
    if (singerIdInvalid(singerId)) return reply.code(422).send(validationFailure(request.id, SINGER_ID_PROBLEM));
    if ((await store.current(call(request), songId)) === undefined) return reply.code(404).send(notFound(request));
    const value = await chordsStore.get(
      songSingerChordsContext(provenSession(request).record.actor, correlationFor(SONG_PREFIX, request.id)), songId, singerId,
    );
    if (value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(value, request.id, CLIENT_WINDOW.current));
  });

  app.put(SONG_SINGER_CHORDS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSongSingerChordsDraft(request.body, 'songSingerChords');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const songId = idIn(request);
    const singerId = singerIdIn(request);
    if (singerIdInvalid(singerId)) return reply.code(422).send(validationFailure(request.id, SINGER_ID_PROBLEM));
    if ((await store.current(call(request), songId)) === undefined) return reply.code(404).send(notFound(request));
    const answer = await settled(
      () => chordsStore.edit(songSingerChordsContext(provenSession(request).record.actor, correlationFor(SONG_PREFIX, request.id)), songId, singerId, parsed.value),
      isChordRefusal,
    );
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await noteChord(request, songId, singerId, 'allowed', 'edited');
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });
}
