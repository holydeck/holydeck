import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import { LIVE_CONTROL_CHANNEL } from '@holydeck/contracts/live';
import { DEFAULT_SAFE_AREA_MARGINS } from '@holydeck/contracts/snapshots';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildApp } from './app.js';
import { capabilitiesOn, capabilityContext } from './capabilities.js';
import { grantFor } from './live-protocol.js';
import { themesOn } from './live-theme.js';
import { midServiceOn } from './mid-service-additions.js';
import { PRESENTATION_CONTROL, PRESENTATION_VIEW, SERVICE_READ, SETTINGS_MANAGE } from './roles.js';
import { runEngineOn } from './run-engine.js';
import { runEventsOn } from './run-events.js';
import { runReviewOn } from './run-review.js';
import {
  LIVE_TICKET_HEADER,
  RUN_ADDITIONS_PATH,
  RUN_DECK_PATH,
  RUN_END_PATH,
  RUN_ID_PATH,
  RUN_PATH,
  RUN_RECAP_PATH,
  RUN_REVIEW_PATH,
  RUN_THEME_PATH,
} from './run-routes.js';
import { runsOn } from './runs.js';
import { serviceContext, servicesOn } from './services.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { loadSettings } from './settings.js';
import { preparationContext, preparationOn } from './snapshots.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryCapabilities } from '../test/helpers/capabilities.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { CommandFrame } from '@holydeck/contracts/live';
import type { ServiceDraft } from '@holydeck/contracts/services';
import type { CapabilityStore } from './capabilities.js';
import type { LiveChange, LiveMember } from './live-protocol.js';
import type { RunDeck } from './run-deck.js';
import type { RunEngine } from './run-engine.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { PreparationInputs } from './snapshots.js';
import type { FastifyInstance } from 'fastify';

const NOW = '2026-09-23T09:00:00.000Z';
const CORRELATION = 'req-0f9c2a41';
const OPERATOR = actorFor('C'.repeat(22));
const VIEWER = actorFor('D'.repeat(22));
const READER = actorFor('E'.repeat(22));
const BYSTANDER = actorFor('F'.repeat(22));

const DRAFT: ServiceDraft = {
  title: 'Sunday service', date: '2026-09-22', site: 'Main Hall', sections: [{
    id: 'section-1', name: 'Welcome', items: [
      { id: 'item-1', kind: 'custom-slide', title: 'Welcome', enabled: true, content: undefined },
    ],
  }],
};
const INPUTS: PreparationInputs = {
  slideLayout: { id: 'layout-1', revision: 3 },
  serviceTemplate: 'template-1@2',
  settings: 'settings@41',
  media: 'media@2026-09-21',
  corpus: 'corpus@2026-09-01',
  aspectRatio: '16:9',
};
const DECK: RunDeck = {
  snapshotId: 'snapshot-any',
  standbyScreens: [],
  pinnedRevisions: {
    service: 'r1', content: 'r1', slideLayout: 'r1', serviceTemplate: 'r1', settings: 'r1', media: 'r1', corpus: 'r1',
  },
  aspectRatio: '16:9',
  safeAreaMargins: DEFAULT_SAFE_AREA_MARGINS,
  items: [],
};
// What the deck holds follows what a test added mid-service, the way `main.ts`'s real deck does.
let deckItems: RunDeck['items'] = [];
const deckFor = (): Promise<RunDeck> => Promise.resolve({ ...DECK, items: deckItems });
let runEngine: RunEngine;
let changes: LiveChange[] = [];

let app: FastifyInstance;
let operator: StartedSession;
let viewer: StartedSession;
let reader: StartedSession;
let bystander: StartedSession;
let capabilities: CapabilityStore;
let sessions: SessionStore;
let preparedServiceId: string;

const building = async (): Promise<void> => {
  let serial = 0;
  const db = fakeDb();
  const now = (): string => NOW;
  const services = servicesOn(db, { now, newId: () => `service-${++serial}` });
  const runs = runsOn(db, { now, newId: () => `run-${++serial}` });
  const runEvents = runEventsOn(db, { now });
  const midService = midServiceOn(db, { now, newId: () => `addition-${++serial}`, runs, runEvents });
  const hub = {
    publish: (): { sequence: number; stateRevision: number } => ({ sequence: 1, stateRevision: 1 }),
    seedStateRevision: (): void => {},
    publishTo: (): { sequence: number; stateRevision: number } => ({ sequence: 1, stateRevision: 1 }),
    publishChange: (change: LiveChange): { sequence: number; stateRevision: number } => {
      changes.push(change);
      return { sequence: 1, stateRevision: 1 };
    },
    seedStates: (): void => {},
    stateRevision: (): number => 0,
    connectionCounts: () => ({ control: 0, audience: 0, stage: 0, singer: 0, guest: 0 }),
  };
  const themes = themesOn(runEvents);
  const runReview = runReviewOn(runEvents);
  deckItems = [];
  changes = [];
  runEngine = runEngineOn({ hub, runs, runEvents, themes, midService, deck: deckFor, clock: now });
  capabilities = capabilitiesOn(memoryCapabilities().db, { now });
  sessions = sessionsOn(memorySessions().db, { now });

  operator = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [PRESENTATION_CONTROL] });
  viewer = await sessions.start(sessionContext(CORRELATION), { actor: VIEWER, permissions: [PRESENTATION_VIEW] });
  reader = await sessions.start(sessionContext(CORRELATION), { actor: READER, permissions: [SERVICE_READ] });
  bystander = await sessions.start(sessionContext(CORRELATION), { actor: BYSTANDER, permissions: [SETTINGS_MANAGE] });

  preparedServiceId = (await services.create(serviceContext(OPERATOR, CORRELATION), DRAFT)).stamp.id;
  await preparationOn(db, { now }).prepare(preparationContext(OPERATOR, CORRELATION), preparedServiceId, INPUTS);

  app = buildApp({
    settings: loadSettings({ env: {} }),
    logger: false,
    fetching: () => Promise.reject(new Error('this route must not ask the corpus')),
    sessions,
    capabilities,
    runs,
    themes,
    runReview,
    midService,
    runEngine,
    deck: deckFor,
  });
  await app.ready();
};

const asking = (
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  held?: StartedSession,
  extraHeaders: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as never }),
    headers: {
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      host: 'holydeck.example.invalid',
      'x-forwarded-proto': 'https',
      origin: 'https://holydeck.example.invalid',
      ...(held === undefined ? {} : { cookie: sessionCookie(held.token, 60), [CSRF_HEADER]: held.record.csrf }),
      ...extraHeaders,
    },
  });

const runPath = (path: string, runId: string): string => path.replace(':runId', runId);

const startRun = async (serviceId = preparedServiceId): Promise<string> =>
  (await asking('POST', RUN_PATH, { serviceId, mode: 'live' }, operator)).json().data.runId as string;

beforeEach(async () => {
  await building();
});

afterEach(async () => {
  await app.close();
});

describe('starting and ending a run', () => {
  test('starts a run for a prepared service and returns its view', async () => {
    const response = await asking('POST', RUN_PATH, { serviceId: preparedServiceId, mode: 'live' }, operator);
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ serviceId: preparedServiceId, phase: 'active', mode: 'live' });
  });

  test('rejects a malformed start body before calling the engine', async () => {
    const response = await asking('POST', RUN_PATH, {}, operator);
    expect(response.statusCode).toBe(422);
  });

  test('refuses a second run for a service that already has one active', async () => {
    await startRun();
    const response = await asking('POST', RUN_PATH, { serviceId: preparedServiceId, mode: 'live' }, operator);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('run.already_active');
  });

  test('refuses to start a run for a service with no prepared manifest', async () => {
    const response = await asking('POST', RUN_PATH, { serviceId: 'service-unprepared', mode: 'live' }, operator);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('run.not_ready');
  });

  test('gates starting a run from a session without Control presentation', async () => {
    const response = await asking('POST', RUN_PATH, { serviceId: preparedServiceId, mode: 'live' }, viewer);
    expect(response.statusCode).toBe(403);
  });

  test('lists runs for a session that may only view', async () => {
    await startRun();
    const response = await asking('GET', RUN_PATH, undefined, viewer);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
  });

  test('ends an active run and returns its ended view', async () => {
    const runId = await startRun();
    const response = await asking('POST', runPath(RUN_END_PATH, runId), undefined, operator);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.phase).toBe('ended');
  });

  test('answers 404 when ending a run that does not exist', async () => {
    const response = await asking('POST', runPath(RUN_END_PATH, 'run-unknown'), undefined, operator);
    expect(response.statusCode).toBe(404);
  });

  test('refuses to end a run that has already ended', async () => {
    const runId = await startRun();
    await asking('POST', runPath(RUN_END_PATH, runId), undefined, operator);
    const response = await asking('POST', runPath(RUN_END_PATH, runId), undefined, operator);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('run.ended');
  });
});

describe('reading a single run', () => {
  test('returns a run by id', async () => {
    const runId = await startRun();
    const response = await asking('GET', runPath(RUN_ID_PATH, runId), undefined, viewer);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.runId).toBe(runId);
  });

  test('answers 404 for a run that does not exist', async () => {
    const response = await asking('GET', runPath(RUN_ID_PATH, 'run-unknown'), undefined, viewer);
    expect(response.statusCode).toBe(404);
  });
});

describe('reading a run deck', () => {
  test('serves the deck to a session holding Control presentation', async () => {
    const runId = await startRun();
    const response = await asking('GET', runPath(RUN_DECK_PATH, runId), undefined, operator);
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBeDefined();
  });

  test('serves the audience view to a session holding only View presentation', async () => {
    const runId = await startRun();
    const response = await asking('GET', runPath(RUN_DECK_PATH, runId), undefined, viewer);
    expect(response.statusCode).toBe(200);
  });

  test('refuses the control view to a session that may only view', async () => {
    const runId = await startRun();
    const response = await asking('GET', `${runPath(RUN_DECK_PATH, runId)}?view=control`, undefined, viewer);
    expect(response.statusCode).toBe(403);
  });

  test('serves the deck to a live ticket, with no session at all', async () => {
    const runId = await startRun();
    const { token } = await capabilities.issue(capabilityContext(CORRELATION), OPERATOR, {
      kind: 'guest', service: preparedServiceId, view: 'audience', expiresAt: '2026-09-23T12:00:00.000Z',
    });
    const response = await asking('GET', runPath(RUN_DECK_PATH, runId), undefined, undefined, { [LIVE_TICKET_HEADER]: token });
    expect(response.statusCode).toBe(200);
  });

  test('refuses the deck to neither a session nor a valid ticket', async () => {
    const runId = await startRun();
    const response = await asking('GET', runPath(RUN_DECK_PATH, runId), undefined, undefined);
    expect(response.statusCode).toBe(403);
  });

  test('answers 404 for a deck of a run that does not exist', async () => {
    const response = await asking('GET', runPath(RUN_DECK_PATH, 'run-unknown'), undefined, operator);
    expect(response.statusCode).toBe(404);
  });

  test.each([
    ['no session and no ticket', {}],
    ['only a ticket, which names no run the caller can prove', { [LIVE_TICKET_HEADER]: 'not-a-ticket' }],
  ])('answers 403, not 404, for an unknown run to a caller with %s', async (_label, headers) => {
    const response = await asking('GET', runPath(RUN_DECK_PATH, 'run-unknown'), undefined, undefined, headers);
    expect(response.statusCode).toBe(403);
  });

  test('answers 304 with no body when the client already holds the current deck', async () => {
    const runId = await startRun();
    const first = await asking('GET', runPath(RUN_DECK_PATH, runId), undefined, operator);
    const etag = String(first.headers.etag);
    const again = await asking('GET', runPath(RUN_DECK_PATH, runId), undefined, operator, { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers.etag).toBe(etag);
    const stale = await asking('GET', runPath(RUN_DECK_PATH, runId), undefined, operator, { 'if-none-match': '"other"' });
    expect(stale.statusCode).toBe(200);
  });
});

describe('changing a run theme', () => {
  test('changes a surface theme to a known theme id', async () => {
    const runId = await startRun();
    const response = await asking('POST', runPath(RUN_THEME_PATH, runId), { surface: 'audience', theme: 'audience-default' }, operator);
    expect(response.statusCode).toBe(200);
  });

  test('rejects a theme id this deployment does not know', async () => {
    const runId = await startRun();
    const response = await asking('POST', runPath(RUN_THEME_PATH, runId), { surface: 'audience', theme: 'not-a-real-theme' }, operator);
    expect(response.statusCode).toBe(422);
  });

  test('persists the theme into the run, so reading it back shows it', async () => {
    const runId = await startRun();
    await asking('POST', runPath(RUN_THEME_PATH, runId), { surface: 'stage', theme: 'audience-default' }, operator);
    const read = await asking('GET', runPath(RUN_ID_PATH, runId), undefined, operator);
    expect(read.json()).toMatchObject({ data: { live: { themes: { stage: 'audience-default' } } } });
  });

  test('refuses a theme change on a run that has ended', async () => {
    const runId = await startRun();
    await asking('POST', runPath(RUN_END_PATH, runId), undefined, operator);
    const response = await asking('POST', runPath(RUN_THEME_PATH, runId), { surface: 'audience', theme: 'audience-default' }, operator);
    expect(response.statusCode).toBe(409);
  });

  test('answers 404 when the run does not exist', async () => {
    const response = await asking('POST', runPath(RUN_THEME_PATH, 'run-unknown'), { surface: 'audience', theme: 'audience-default' }, operator);
    expect(response.statusCode).toBe(404);
  });
});

describe('adding content mid-service, reviewing and exporting a recap', () => {
  test('adds content to a run in flight, then reviews and recaps what it showed', async () => {
    const runId = await startRun();

    const added = await asking('POST', runPath(RUN_ADDITIONS_PATH, runId), {
      kind: 'reading', title: 'An added reading', body: 'The text of the reading',
    }, operator);
    expect(added.statusCode).toBe(201);
    const { contentId, title } = added.json().data.addition as { contentId: string; title: string };
    expect(title).toBe('An added reading');
    // RUN-08: every view hears of it, and a client keyed on additionsRevision refetches its deck.
    expect(changes.at(-1)).toMatchObject({ type: 'item-added', everyone: true });
    expect((await asking('GET', runPath(RUN_ID_PATH, runId), undefined, operator)).json().data.live.additionsRevision).toBe(1);

    // Added is not shown: LIVE-13 reviews only what reached the room, so the review is empty until the
    // operator puts the addition up.
    expect((await asking('GET', runPath(RUN_REVIEW_PATH, runId), undefined, operator)).json().data).toEqual([]);
    deckItems = [{ itemId: contentId, kind: 'mid-service', title, slides: [{ slideId: `${contentId}:0`, boxes: [] }] }];
    const member: LiveMember = { channel: LIVE_CONTROL_CHANNEL, grant: grantFor([PRESENTATION_CONTROL]), identity: OPERATOR };
    const command: CommandFrame = {
      kind: 'command', channel: LIVE_CONTROL_CHANNEL, id: 'show-addition', idempotencyKey: 'show-addition',
      type: 'go-to', args: { itemId: contentId, slideIndex: 0 }, clientStateRevision: 0,
    };
    expect(await runEngine.command(member, command)).toEqual({ outcome: 'applied' });

    const reviewed = await asking('GET', runPath(RUN_REVIEW_PATH, runId), undefined, operator);
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().data).toEqual([expect.objectContaining({ reference: 'An added reading' })]);

    // Proves RECAP_NEED's any-permission gate: a session holding only Service read, never Control
    // presentation, still reaches the recap.
    const recapped = await asking('GET', runPath(RUN_RECAP_PATH, runId), undefined, reader);
    expect(recapped.statusCode).toBe(200);
    expect(recapped.headers['content-type']).toMatch(/text\/markdown/u);
    expect(recapped.body).toBe('1. An added reading');
  });

  test('leaves a rehearsal out of its recap unless asked to include it (RUN-06)', async () => {
    const runId = (await asking('POST', RUN_PATH, { serviceId: preparedServiceId, mode: 'rehearsal' }, operator)).json().data.runId as string;
    deckItems = [{ itemId: 'item-1', kind: 'song', title: 'Practised song', slides: [{ slideId: 'slide-1', boxes: [] }] }];
    const member: LiveMember = { channel: LIVE_CONTROL_CHANNEL, grant: grantFor([PRESENTATION_CONTROL]), identity: OPERATOR };
    await runEngine.command(member, {
      kind: 'command', channel: LIVE_CONTROL_CHANNEL, id: 'practise', idempotencyKey: 'practise',
      type: 'go-to', args: { itemId: 'item-1', slideIndex: 0 }, clientStateRevision: 0,
    });

    expect((await asking('GET', runPath(RUN_RECAP_PATH, runId), undefined, operator)).body).toBe('');
    expect((await asking('GET', `${runPath(RUN_RECAP_PATH, runId)}?includeRehearsal=true`, undefined, operator)).body).toBe('1. Practised song');
  });

  test('gates an addition from a session without Control presentation', async () => {
    const runId = await startRun();
    const response = await asking('POST', runPath(RUN_ADDITIONS_PATH, runId), {
      kind: 'reading', title: 'An added reading', body: 'The text of the reading',
    }, viewer);
    expect(response.statusCode).toBe(403);
  });

  test('gates the recap from a session holding neither Control nor Service read', async () => {
    const runId = await startRun();
    const response = await asking('GET', runPath(RUN_RECAP_PATH, runId), undefined, bystander);
    expect(response.statusCode).toBe(403);
  });
});

describe('a deployment with none of this surface\'s stores wired', () => {
  test.each([
    ['POST', RUN_PATH],
    ['GET', RUN_PATH],
    ['GET', RUN_DECK_PATH.replace(':runId', 'run-1')],
    ['GET', RUN_RECAP_PATH.replace(':runId', 'run-1')],
  ] as const)('serves a gated 404 fallback for %s %s', async (method, path) => {
    await app.close();
    app = buildApp({
      settings: loadSettings({ env: {} }),
      logger: false,
      fetching: () => Promise.reject(new Error('unused')),
      sessions,
    });
    await app.ready();
    const response = await asking(method, path, undefined, operator);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('resource.not_found');
  });
});
