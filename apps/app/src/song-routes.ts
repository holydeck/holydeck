import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import {
  SONG_PATH,
  SONGS_PATH,
  parseSongDraft,
  parseSongEdit,
  parseSongGeneration,
  parseSongImportRequest,
} from '@holydeck/contracts/songs';
import { FIELD_CODES } from '@holydeck/contracts/problems';

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { settled, staleRevision } from './refusals.js';
import { CONTENT_EDIT } from './roles.js';
import { SongError, songContext, subjectFor } from './songs.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { SongRefusal, SongStore } from './songs.js';
import type { LocatedProblem } from './song-yaml.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const SONG_PREFIX = 'song:';

export const SONG_ID_PATH = `${SONGS_PATH}/:id`;
const SONG_RAW_PATH = `${SONG_ID_PATH}/raw`;
const SONG_EXPORT_PATH = `${SONG_ID_PATH}/export`;
const SONG_HISTORY_PATH = `${SONG_ID_PATH}/history`;
const SONG_SLIDES_PATH = `${SONG_ID_PATH}/slides`;
const SONG_IMPORT_PATH = `${SONGS_PATH}/import`;

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
] as const;

const ORDINAL = /^[1-9][0-9]*$/u;
const ordinalIn = (value: unknown): number | undefined =>
  typeof value === 'string' && ORDINAL.test(value) ? Number(value) : undefined;
const NOT_AN_ORDINAL = [
  { path: 'revision', code: FIELD_CODES.notANumber, message: 'must be an ordinal counting from one' },
];

const idIn = (request: FastifyRequest): string => (request.params as { readonly id: string }).id;

const isRefusal = (error: unknown): error is SongError & { kind: 'state' | 'conflict' } =>
  error instanceof SongError && (error.kind === 'state' || error.kind === 'conflict');

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
  readonly identity: Identity | undefined;
}

export function serveSongRoutes(app: FastifyInstance, { songs, identity }: SongRoutesOptions): void {
  if (identity === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({ method, url, config: { need: PERMISSION }, handler: (request, reply) => reply.code(404).send(notFound(request)) });
    }
    return;
  }

  const store = songs as SongStore;
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
    const context = call(request);
    const current = await store.current(context, id);
    if (current === undefined) return reply.code(404).send(notFound(request));
    const stale = staleRevision(id, parsed.value.expectedRevision, current.revision);
    if (stale !== undefined) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, stale, request.id));
    const answer = await settled(() => store.edit(context, id, parsed.value.body), isRefusal);
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
        ? reply.code(422).send(validationFailure(request.id, answer.problems))
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
    return reply.header('content-disposition', `attachment; filename="${id}.json"`).type('application/json').send(text);
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
}
