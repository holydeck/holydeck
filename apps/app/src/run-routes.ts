// A presentation run's own surface (spec RUN-01, RUN-05 through RUN-09; LIVE-01, LIVE-09, LIVE-12,
// LIVE-13; BIBL-04's server half): starting and ending a run, reading its state, reading the deck it
// drives, changing its theme, adding content mid-service, and reviewing or exporting what it showed.
//
// The deck route is the one route here a session does not have to prove: an output window or a Guest
// holds a capability instead (D-4), never a session, so it is served `{kind:'public'}` and does its own,
// narrower authorization after resolving which run the URL names — a session if one is sent, an
// `X-Holydeck-Live-Ticket` if not, and 403 when neither authorizes the view asked for.

import { createHash } from 'node:crypto';

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { DEFAULT_THEMES, meetsThemeContrast } from '@holydeck/contracts/live-theme';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { FIELD_CODES, parseObject } from '@holydeck/contracts/problems';
import { parseRunAdditionBody, parseRunStartBody, parseRunThemeBody } from '@holydeck/contracts/runs';
import { SESSION_COOKIE, cookieIn } from '@holydeck/contracts/sessions';

import { auditContext } from './audit.js';
import { CapabilityError, capabilityContext } from './capabilities.js';
import { correlationFor } from './context.js';
import { FORBIDDEN, provenSession, sessionCallFor } from './csrf.js';
import { notFound } from './failures.js';
import { MidServiceError } from './mid-service-additions.js';
import { projectDeck } from './run-deck.js';
import { RunEventError } from './run-events.js';
import { runReviewContext } from './run-review.js';
import { RUN_PHASES, RunError, runContext } from './runs.js';
import { PRESENTATION_CONTROL, PRESENTATION_VIEW, SERVICE_READ } from './roles.js';

import type { LibraryKind } from '@holydeck/contracts/library';
import type { LiveState } from '@holydeck/contracts/live-state';
import type { Parsed } from '@holydeck/contracts/problems';
import type { RouteNeed } from './authorization.js';
import type { AuditAction } from './audit.js';
import type { CapabilityStore } from './capabilities.js';
import type { ThemeStore } from './live-theme.js';
import type { MidServiceStore } from './mid-service-additions.js';
import type { Identity } from './onboarding.js';
import type { DeckView, RunDeck } from './run-deck.js';
import type { RunEngine } from './run-engine.js';
import type { RunEventRefusal } from './run-events.js';
import type { RunReviewStore } from './run-review.js';
import type { MidServiceRefusal } from './mid-service-additions.js';
import type { RunMode, RunPhase, RunRecord, RunRefusal, RunStore } from './runs.js';
import type { OperatorSession } from './snapshots.js';
import type { SessionStore } from './sessions.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const RUN_PATH = '/api/v1/runs';
export const RUN_END_PATH = '/api/v1/runs/:runId/end';
export const RUN_ID_PATH = '/api/v1/runs/:runId';
export const RUN_DECK_PATH = '/api/v1/runs/:runId/deck';
export const RUN_THEME_PATH = '/api/v1/runs/:runId/theme';
export const RUN_ADDITIONS_PATH = '/api/v1/runs/:runId/additions';
export const RUN_REVIEW_PATH = '/api/v1/runs/:runId/review';
export const RUN_RECAP_PATH = '/api/v1/runs/:runId/recap';

/** D-4's header: never a cookie, never a session. Carried by an output window or a Guest link alone. */
export const LIVE_TICKET_HEADER = 'x-holydeck-live-ticket';

const CONTROL_PERMISSION: RouteNeed = { kind: 'permission', need: PRESENTATION_CONTROL };
const VIEW_OR_CONTROL: RouteNeed = { kind: 'any-permission', needs: [PRESENTATION_CONTROL, PRESENTATION_VIEW] };
const RECAP_NEED: RouteNeed = { kind: 'any-permission', needs: [PRESENTATION_CONTROL, SERVICE_READ] };
const PUBLIC: RouteNeed = { kind: 'public' };

/** Every route this module serves, in the order it registers them. */
const ROUTES = [
  ['POST', RUN_PATH, CONTROL_PERMISSION],
  ['GET', RUN_PATH, VIEW_OR_CONTROL],
  ['POST', RUN_END_PATH, CONTROL_PERMISSION],
  ['GET', RUN_ID_PATH, VIEW_OR_CONTROL],
  ['GET', RUN_DECK_PATH, PUBLIC],
  ['POST', RUN_THEME_PATH, CONTROL_PERMISSION],
  ['POST', RUN_ADDITIONS_PATH, CONTROL_PERMISSION],
  ['GET', RUN_REVIEW_PATH, CONTROL_PERMISSION],
  ['GET', RUN_RECAP_PATH, RECAP_NEED],
] as const;

/** A run, the way this surface answers it: the record plus the one fact no single row carries alone —
 *  when it started — derived from `RunStore.history` rather than stored a second time (spec Design §4). */
export interface RunView {
  readonly runId: string;
  readonly serviceId: string;
  readonly snapshotId: string;
  readonly phase: RunPhase;
  readonly mode: RunMode;
  readonly live: LiveState;
  readonly stateRevision: number;
  readonly startedAt: string;
  readonly endedAt?: string;
}

const toRunView = async (context: unknown, runs: RunStore, record: RunRecord): Promise<RunView> => {
  const rows = await runs.history(context, record.runId);
  return {
    runId: record.runId,
    serviceId: record.serviceId,
    snapshotId: record.snapshotId,
    phase: record.phase,
    mode: record.mode,
    live: record.live,
    stateRevision: record.stateRevision,
    startedAt: rows[0]?.at ?? record.at,
    ...(record.phase === 'ended' ? { endedAt: record.at } : {}),
  };
};

const isDeckView = (value: string): value is DeckView =>
  value === 'audience' || value === 'stage' || value === 'singer' || value === 'control';

interface RunListQuery {
  readonly serviceId?: string;
  readonly phase?: RunPhase;
}

const parseRunListQuery = (query: unknown): Parsed<RunListQuery> =>
  parseObject(query, 'query', (reader) => {
    const serviceId = reader.optionalText('serviceId');
    const phase = reader.names.includes('phase') ? reader.choice('phase', RUN_PHASES) : undefined;
    return { ...(serviceId === undefined ? {} : { serviceId }), ...(phase === undefined ? {} : { phase }) };
  });

const runIdIn = (request: FastifyRequest): string => (request.params as { readonly runId: string }).runId;

const subjectFor = (runId: string): string => `run:${runId}`;

const operatorSession = (request: FastifyRequest, prefix: string): OperatorSession => ({
  actor: provenSession(request).record.actor,
  permissions: provenSession(request).record.permissions,
  correlationId: correlationFor(prefix, request.id),
});

type Answer<T, K extends string> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly kind: K; readonly message: string };

async function settledRun<T>(work: () => Promise<T>): Promise<Answer<T, RunRefusal>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof RunError && error.kind !== 'corrupt') return { ok: false, kind: error.kind, message: error.message };
    throw error;
  }
}

const refusedStart = (request: FastifyRequest, reply: FastifyReply, answer: Extract<Answer<never, RunRefusal>, { ok: false }>): FastifyReply => {
  if (answer.kind === 'active') return reply.code(409).send(errorEnvelope('run.already_active', answer.message, request.id));
  if (answer.kind === 'outdated') return reply.code(409).send(errorEnvelope('run.snapshot_outdated', answer.message, request.id));
  if (answer.kind === 'state') return reply.code(409).send(errorEnvelope('run.not_ready', answer.message, request.id));
  if (answer.kind === 'permission') return reply.code(403).send(errorEnvelope(FORBIDDEN, answer.message, request.id));
  return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
};

const refusedEnd = (request: FastifyRequest, reply: FastifyReply, answer: Extract<Answer<never, RunRefusal>, { ok: false }>): FastifyReply => {
  if (answer.kind === 'state') return reply.code(409).send(errorEnvelope('run.ended', answer.message, request.id));
  if (answer.kind === 'permission') return reply.code(403).send(errorEnvelope(FORBIDDEN, answer.message, request.id));
  return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
};

const refusedEvent = (request: FastifyRequest, reply: FastifyReply, answer: Extract<Answer<never, RunEventRefusal>, { ok: false }>): FastifyReply => {
  if (answer.kind === 'permission') return reply.code(403).send(errorEnvelope(FORBIDDEN, answer.message, request.id));
  if (answer.kind === 'schema') return reply.code(422).send(validationFailure(request.id, [{ path: '', code: 'invalid', message: answer.message }]));
  return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
};

async function settledMidService<T>(work: () => Promise<T>): Promise<Answer<T, MidServiceRefusal>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof MidServiceError && error.kind !== 'corrupt') return { ok: false, kind: error.kind, message: error.message };
    throw error;
  }
}

const refusedMidService = (
  request: FastifyRequest,
  reply: FastifyReply,
  answer: Extract<Answer<never, MidServiceRefusal>, { ok: false }>,
): FastifyReply => {
  if (answer.kind === 'permission') return reply.code(403).send(errorEnvelope(FORBIDDEN, answer.message, request.id));
  if (answer.kind === 'schema') return reply.code(422).send(validationFailure(request.id, [{ path: '', code: 'invalid', message: answer.message }]));
  return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
};

export interface RunRoutesOptions {
  readonly runs: RunStore | undefined;
  readonly runEngine: RunEngine | undefined;
  readonly runReview: RunReviewStore | undefined;
  readonly themes: ThemeStore | undefined;
  readonly midService: MidServiceStore | undefined;
  readonly capabilities: CapabilityStore | undefined;
  /** Absent in a deployment that keeps no sessions: the deck route still serves capability-ticket
   *  viewers, and every other route needs a proven session regardless, so nothing here depends on it. */
  readonly sessions: SessionStore | undefined;
  /** Absent in a deployment that keeps no accounts, which then has nowhere to write `run.theme`,
   *  `run.addition`, or `run.recap.export` — the routes still work, and simply go unaudited (D-1). */
  readonly identity: Identity | undefined;
  /** Derives a run's deck without exposing raw stores to this module, the same seam `run-engine.ts` uses. */
  readonly deck: ((context: unknown, run: RunRecord) => Promise<RunDeck>) | undefined;
}

export function serveRunRoutes(
  app: FastifyInstance,
  { runs, runEngine, runReview, themes, midService, capabilities, sessions, identity, deck }: RunRoutesOptions,
): void {
  // A deployment with nowhere to keep a run has nothing here to start, drive, or review. Every path is
  // still served, at the need it would otherwise be gated by, so the guard's table is the same shape in
  // every deployment.
  if (runs === undefined || runEngine === undefined || runReview === undefined || themes === undefined ||
      midService === undefined || capabilities === undefined || deck === undefined) {
    for (const [method, url, need] of ROUTES) {
      app.route({
        method,
        url,
        config: { need },
        handler: (request, reply) => reply.code(404).send(notFound(request)),
      });
    }
    return;
  }

  /** Written after the change, and logged rather than answered when the trail refuses it: a change this
   *  server made holds that, whether or not it managed to write it down (mirrors `accounts-routes.ts`). */
  const note = async (request: FastifyRequest, action: AuditAction, actor: string, subject: string, detail: string): Promise<void> => {
    if (identity === undefined) return;
    try {
      await identity.audit.record(auditContext(actor, correlationFor('run:audit:', request.id)), { action, subject, outcome: 'allowed', detail });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the run trail refused an entry');
    }
  };

  app.post(RUN_PATH, { config: { need: CONTROL_PERMISSION } }, async (request, reply) => {
    const parsed = parseRunStartBody(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const session = operatorSession(request, 'run:start:');
    const answer = await settledRun(() => runEngine.start(session, parsed.value));
    if (!answer.ok) return refusedStart(request, reply, answer);
    const context = runContext(session.actor, session.correlationId);
    const view = await toRunView(context, runs, answer.value);
    return reply.code(201).send(successEnvelope(view, request.id, CLIENT_WINDOW.current));
  });

  app.get(RUN_PATH, { config: { need: VIEW_OR_CONTROL } }, async (request, reply) => {
    const parsed = parseRunListQuery(request.query);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const context = runContext(provenSession(request).record.actor, correlationFor('run:list:', request.id));
    const records = await runs.list(context, parsed.value);
    const views = await Promise.all(records.map((record) => toRunView(context, runs, record)));
    return reply.send(successEnvelope(views, request.id, CLIENT_WINDOW.current));
  });

  app.post(RUN_END_PATH, { config: { need: CONTROL_PERMISSION } }, async (request, reply) => {
    const session = operatorSession(request, 'run:end:');
    const answer = await settledRun(() => runEngine.end(session, runIdIn(request)));
    if (!answer.ok) return refusedEnd(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    const context = runContext(session.actor, session.correlationId);
    const view = await toRunView(context, runs, answer.value);
    return reply.send(successEnvelope(view, request.id, CLIENT_WINDOW.current));
  });

  app.get(RUN_ID_PATH, { config: { need: VIEW_OR_CONTROL } }, async (request, reply) => {
    const context = runContext(provenSession(request).record.actor, correlationFor('run:get:', request.id));
    const record = await runs.resume(context, runIdIn(request));
    if (record === undefined) return reply.code(404).send(notFound(request));
    const view = await toRunView(context, runs, record);
    return reply.send(successEnvelope(view, request.id, CLIENT_WINDOW.current));
  });

  // Public: an output window or a Guest holds a capability, never a session (D-4). A session is checked
  // first and needs no run; the run is resolved next — from a neutral, server-asserted context, the same
  // way `run-engine.ts`'s own `restore()` reads — so the ticket path has a `serviceId` to check the
  // ticket against before it is spent. Only a proven session is ever told a run does not exist: every
  // other caller gets the same 403 for an unknown run as for a refused one.
  app.get(RUN_DECK_PATH, { config: { need: PUBLIC } }, async (request, reply) => {
    const runId = runIdIn(request);
    const correlationId = correlationFor('run:deck:', request.id);
    const forbidden = () =>
      reply.code(403).send(errorEnvelope(FORBIDDEN, 'no session or live ticket authorizes this deck view', request.id));

    const rawView = (request.query as Record<string, unknown>).view;
    const view: DeckView = typeof rawView === 'string' && isDeckView(rawView) ? rawView : 'audience';

    let actor: string | undefined;
    if (sessions !== undefined) {
      const token = cookieIn(request.headers.cookie, SESSION_COOKIE);
      if (token !== undefined) {
        try {
          const proven = await sessions.read(sessionCallFor(request), token);
          const authorized = view === 'control'
            ? proven.permissions.includes(PRESENTATION_CONTROL)
            : proven.permissions.includes(PRESENTATION_CONTROL) || proven.permissions.includes(PRESENTATION_VIEW);
          if (authorized) actor = proven.actor;
        } catch {
          // No usable session; falls through to a ticket, or to the 403 below.
        }
      }
    }

    // A ticket authorizes a guest or output view only — never `'control'`, which `CapabilityView`
    // structurally excludes, and only once a session has already failed to authorize this request.
    const header = request.headers[LIVE_TICKET_HEADER];
    const ticket = actor === undefined && view !== 'control' && typeof header === 'string' && header !== '' ? header : undefined;
    if (actor === undefined && ticket === undefined) return forbidden();

    const record = await runs.resume(runContext('system', correlationId), runId);
    if (record === undefined) return actor === undefined ? forbidden() : reply.code(404).send(notFound(request));

    if (ticket !== undefined && view !== 'control') {
      try {
        await capabilities.redeem(capabilityContext(correlationId), ticket, { service: record.serviceId, view });
        actor = 'live-ticket';
      } catch (error: unknown) {
        if (!(error instanceof CapabilityError)) throw error;
        // The ticket did not authorize this view; falls through to the 403 below.
      }
    }

    if (actor === undefined) return forbidden();

    const context = runContext(actor, correlationId);
    const runDeck = await deck(context, record);
    const projected = projectDeck(runDeck, view, record.live);
    const etag = `"${createHash('sha256').update(JSON.stringify(projected)).digest('hex')}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, max-age=0, must-revalidate');
    // A revalidating client that already holds this exact projection is told so without the body.
    const held = request.headers['if-none-match'];
    if (typeof held === 'string' && held.split(',').some((tag) => tag.trim() === etag)) return reply.code(304).send();
    return reply.send(successEnvelope(projected, request.id, CLIENT_WINDOW.current));
  });

  app.post(RUN_THEME_PATH, { config: { need: CONTROL_PERMISSION } }, async (request, reply) => {
    const parsed = parseRunThemeBody(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const runId = runIdIn(request);
    const session = operatorSession(request, 'run:theme:');
    const context = runContext(session.actor, session.correlationId);
    const record = await runs.resume(context, runId);
    if (record === undefined) return reply.code(404).send(notFound(request));

    const theme = Object.values(DEFAULT_THEMES).find((candidate) => candidate.id === parsed.value.theme);
    if (theme === undefined) {
      return reply.code(422).send(
        validationFailure(request.id, [{ path: 'run.theme', code: FIELD_CODES.notAllowed, message: `${parsed.value.theme} is not a known theme` }]),
      );
    }
    if (!meetsThemeContrast(theme)) {
      return reply.code(422).send(errorEnvelope('theme.contrast', `${theme.id} does not meet the contrast this surface requires`, request.id));
    }

    let changed;
    try {
      changed = await runEngine.changeTheme(session, runId, parsed.value.surface, theme);
    } catch (error) {
      if (error instanceof RunError && error.kind !== 'corrupt') return refusedEnd(request, reply, { ok: false, kind: error.kind, message: error.message });
      if (error instanceof RunEventError && error.kind !== 'corrupt') return refusedEvent(request, reply, { ok: false, kind: error.kind, message: error.message });
      throw error;
    }
    await note(request, 'run.theme', session.actor, subjectFor(runId), `Changed the ${parsed.value.surface} theme to ${theme.id}`);
    return reply.send(successEnvelope(changed, request.id, CLIENT_WINDOW.current));
  });

  app.post(RUN_ADDITIONS_PATH, { config: { need: CONTROL_PERMISSION } }, async (request, reply) => {
    const parsed = parseRunAdditionBody(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const runId = runIdIn(request);
    const session = operatorSession(request, 'run:additions:');
    let answer;
    try {
      answer = await settledMidService(() => runEngine.add(session, {
        runId,
        kind: parsed.value.kind as LibraryKind,
        title: parsed.value.title,
        body: { text: parsed.value.body },
        ...(parsed.value.saveToLibrary === undefined ? {} : { saveToLibrary: parsed.value.saveToLibrary }),
      }));
    } catch (error) {
      // Only the additions-revision bump refuses this way, and only by losing a race: the run ended, or
      // kept moving, between the addition landing and the views being told.
      if (error instanceof RunError && error.kind !== 'corrupt') return refusedEnd(request, reply, { ok: false, kind: error.kind, message: error.message });
      throw error;
    }
    if (!answer.ok) return refusedMidService(request, reply, answer);
    await note(request, 'run.addition', session.actor, subjectFor(runId), `Added a ${parsed.value.kind} mid-service`);
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(RUN_REVIEW_PATH, { config: { need: CONTROL_PERMISSION } }, async (request, reply) => {
    const runId = runIdIn(request);
    const actor = provenSession(request).record.actor;
    const correlationId = correlationFor('run:review:', request.id);
    const record = await runs.resume(runContext(actor, correlationId), runId);
    if (record === undefined) return reply.code(404).send(notFound(request));
    const references = await runReview.review(runReviewContext(actor, correlationId), runId);
    return reply.send(successEnvelope(references, request.id, CLIENT_WINDOW.current));
  });

  app.get(RUN_RECAP_PATH, { config: { need: RECAP_NEED } }, async (request, reply) => {
    const runId = runIdIn(request);
    const actor = provenSession(request).record.actor;
    const correlationId = correlationFor('run:recap:', request.id);
    const record = await runs.resume(runContext(actor, correlationId), runId);
    if (record === undefined) return reply.code(404).send(notFound(request));
    const includeRehearsal = (request.query as Record<string, unknown>).includeRehearsal === 'true';
    const recap = await runReview.recap(runReviewContext(actor, correlationId), runId, { mode: record.mode, includeRehearsal });
    await note(request, 'run.recap.export', actor, subjectFor(runId), 'Exported a run recap');
    return reply.type('text/markdown; charset=utf-8').send(recap.lines.join('\n'));
  });
}
