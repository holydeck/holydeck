// The one test in this package that proves `resume()` survives more than a fresh JS closure over a
// shared fake: a genuine reconnect. runs.ts's own header explains why resume() reports the same thing
// after a restart — nothing about a run is held outside the repository — and runs.test.ts proves that at
// the unit level over one `fakeDb` never actually reopened. This is the deployment-relevant half (T108,
// DEPL-03): a run started over one real MongoClient resumes correctly through a second MongoClient opened
// fresh against the same database, the same reconnect a restarted application process makes.

import { LIVE_CONTROL_CHANNEL } from '@holydeck/contracts/live';
import { SNAPSHOT_PINS } from '@holydeck/contracts/snapshots';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { grantFor, liveHub } from './live-protocol.js';
import { runEngineOn } from './run-engine.js';
import { runEventsOn } from './run-events.js';

import { PRESENTATION_CONTROL, permissionsFor } from './roles.js';
import { repositoryDb } from './repositories.js';
import { runContext, runsOn } from './runs.js';
import { serviceContext, servicesOn } from './services.js';
import { preparationContext, preparationOn } from './snapshots.js';
import { DATABASE, startTestMongo } from '../test/helpers/mongo.js';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import type { SnapshotPin } from '@holydeck/contracts/snapshots';
import type { ServiceDraft, ServiceSection } from '@holydeck/contracts/services';
import type { LiveMember, LiveTransport } from './live-protocol.js';
import type { RunDeck } from './run-deck.js';
import type { RepositoryDb } from './repositories.js';
import type { OperatorSession, PreparationInputs, ReadinessObservation } from './snapshots.js';
import type { TestMongo } from '../test/helpers/mongo.js';

const START = Date.parse('2026-09-20T09:30:00.000Z');
const OPERATOR = `account:${'E'.repeat(22)}`;
const CORRELATION = 'req-3c9f10ba';
const EDITOR = serviceContext(OPERATOR, CORRELATION);
const PREPARE_CONTEXT = preparationContext(OPERATOR, CORRELATION);
const READ_CONTEXT = runContext(OPERATOR, CORRELATION);

const SECTIONS: readonly ServiceSection[] = [
  { id: 'section-1', name: 'Worship', items: [{ id: 'item-1', kind: 'custom-slide', title: 'Welcome', enabled: true, content: undefined }] },
];
const DRAFT: ServiceDraft = { title: 'Sunday Morning', date: '2026-09-20', site: 'Main Hall', sections: SECTIONS };

const INPUTS: PreparationInputs = {
  slideLayout: { id: 'layout-1', revision: 1 },
  serviceTemplate: 'template-1@1',
  settings: 'settings@1',
  media: 'media@2026-09-12',
  corpus: 'corpus@2026-08-01',
  aspectRatio: '16:9',
};

const READY: ReadinessObservation = { slideLayoutRevision: 1, checks: [] };

const account: AccountRecord = {
  id: 'A'.repeat(22),
  name: 'lucia',
  displayName: 'Lucia Brandt',
  role: 'member',
  createdAt: '2026-09-20T09:30:00.000Z',
  controlPresentation: true,
  disabled: false,
};

const OPERATOR_SESSION: OperatorSession = {
  actor: OPERATOR,
  permissions: permissionsFor(account),
  correlationId: CORRELATION,
};

let mongo: TestMongo;

beforeAll(async () => {
  mongo = await startTestMongo();
});

afterAll(async () => {
  await mongo.stop();
});

describe('resuming a run after a real restart', () => {
  it('reports the same run through a freshly opened connection, the way a restarted process reconnects', async () => {
    expect(OPERATOR_SESSION.permissions).toContain(PRESENTATION_CONTROL);

    const db = repositoryDb(mongo.db);
    let tick = 0;
    const now = (): string => new Date(START + (tick += 1) * 1000 - 1000).toISOString();
    const services = servicesOn(db, { now, newId: () => 'service-1' });
    const service = await services.create(EDITOR, DRAFT);
    await preparationOn(db, { now: () => new Date(START).toISOString() }).prepare(PREPARE_CONTEXT, service.stamp.id, INPUTS);

    const runs = runsOn(db, { now, newId: () => 'run-1', observe: () => READY });
    const started = await runs.start(OPERATOR_SESSION, { serviceId: service.stamp.id, mode: 'live' });

    // A brand new MongoClient, opened against the same connection string, that never saw `start()`
    // called — exactly what a restarted process holds instead of the closure the first store was
    // built over.
    const restarted = new MongoClient(mongo.uri, { ignoreUndefined: true });
    await restarted.connect();
    try {
      const restartedRuns = runsOn(repositoryDb(restarted.db(DATABASE)), { now });
      const resumed = await restartedRuns.resume(READ_CONTEXT, started.runId);

      expect(resumed?.runId).toBe(started.runId);
      expect(resumed?.mode).toBe(started.mode);
      expect(resumed?.phase).toBe('active');
      expect(resumed?.position).toBe(started.position);
    } finally {
      await restarted.close();
    }
  });

  it('resumes with the same LiveState and a stateRevision that never goes backward after a restart', async () => {
    const db = repositoryDb(mongo.db);
    let tick = 0;
    const now = (): string => new Date(START + (tick += 1) * 1000 - 1000).toISOString();
    const services = servicesOn(db, { now, newId: () => 'service-2' });
    const service = await services.create(EDITOR, DRAFT);
    await preparationOn(db, { now: () => new Date(START).toISOString() }).prepare(PREPARE_CONTEXT, service.stamp.id, INPUTS);

    const runs = runsOn(db, { now, newId: () => 'run-2', observe: () => READY });
    const started = await runs.start(OPERATOR_SESSION, { serviceId: service.stamp.id, mode: 'live' });

    // Three real advances over a real MongoClient — the same CAS pipeline `run-engine.ts` drives a
    // live run through, not a synthetic row written directly.
    let revision = started.stateRevision;
    let live = started.live;
    for (let slideIndex = 1; slideIndex <= 3; slideIndex += 1) {
      const next = { ...live, selected: { ...live.selected, slideIndex } };
      const advanced = await runs.advance(READ_CONTEXT, started.runId, revision, next);
      if (advanced === 'stale' || advanced === undefined) throw new Error(`advance ${slideIndex} was unexpectedly refused`);
      revision = advanced.stateRevision;
      live = advanced.live;
    }
    expect(revision).toBe(3);

    // A brand new MongoClient again, exactly as above — resume() must report the last-written `live`
    // and `stateRevision` from the repository, never a value held in the first store's own closure.
    const restarted = new MongoClient(mongo.uri, { ignoreUndefined: true });
    await restarted.connect();
    try {
      const restartedRuns = runsOn(repositoryDb(restarted.db(DATABASE)), { now });
      const resumed = await restartedRuns.resume(READ_CONTEXT, started.runId);

      expect(resumed?.stateRevision).toBe(3);
      expect(resumed?.live).toEqual(live);
    } finally {
      await restarted.close();
    }
  });

  it('hands the first snapshot after a restart the revision, position and state last sent, never an older one', async () => {
    let tick = 0;
    const now = (): string => new Date(START + (tick += 1) * 1000).toISOString();
    const pins = Object.fromEntries(SNAPSHOT_PINS.map((pin) => [pin, `${pin}@1`])) as Record<SnapshotPin, string>;
    const deck = async (): Promise<RunDeck> => ({
      snapshotId: 'snapshot', pinnedRevisions: pins, aspectRatio: '16:9',
      safeAreaMargins: { top: 0, right: 0, bottom: 0, left: 0, unit: 'percent' },
      items: [{ itemId: 'item-1', title: 'Welcome', kind: 'custom-slide', slides: [0, 1, 2, 3].map((n) => ({ slideId: `slide-${n}`, boxes: [] })) }],
    });
    const engineOver = (db: RepositoryDb, hub: ReturnType<typeof liveHub>) => runEngineOn({
      hub,
      runs: runsOn(db, { now, newId: () => 'run-3', observe: () => READY }),
      runEvents: runEventsOn(db, { now }),
      themes: { changeTheme: vi.fn(), themesFor: vi.fn() },
      midService: { add: vi.fn(), additions: vi.fn(async () => []) },
      deck,
      clock: now,
    });
    const peer = (): { transport: LiveTransport; frames: Record<string, unknown>[] } => {
      const frames: Record<string, unknown>[] = [];
      return { frames, transport: { send: (text) => { frames.push(JSON.parse(text) as Record<string, unknown>); }, close: () => {}, buffered: () => 0 } };
    };

    const db = repositoryDb(mongo.db);
    const service = await servicesOn(db, { now, newId: () => 'service-3' }).create(EDITOR, DRAFT);
    await preparationOn(db, { now: () => new Date(START).toISOString() }).prepare(PREPARE_CONTEXT, service.stamp.id, INPUTS);
    const hub = liveHub({ clock: now });
    const engine = engineOver(db, hub);
    hub.useCommands((member, frame) => engine.command(member, frame));
    await engine.start(OPERATOR_SESSION, { serviceId: service.stamp.id, mode: 'live' });
    const watcher = peer();
    const member: LiveMember = { channel: LIVE_CONTROL_CHANNEL, grant: grantFor(OPERATOR_SESSION.permissions), identity: OPERATOR };
    for (let slideIndex = 1; slideIndex <= 3; slideIndex += 1) {
      const outcome = await engine.command(member, {
        kind: 'command', channel: LIVE_CONTROL_CHANNEL, id: `c-${slideIndex}`, idempotencyKey: `k-${slideIndex}`,
        clientStateRevision: hub.stateRevision(), type: 'go-to', args: { itemId: 'item-1', slideIndex },
      });
      expect(outcome).toEqual({ outcome: 'applied' });
    }
    hub.join(watcher.transport, 'audience', grantFor([]));
    const lastSent = hub.stateRevision();
    expect(watcher.frames[0]).toMatchObject({ kind: 'snapshot', stateRevision: lastSent, state: { frame: { slideIndex: 3 } } });

    const restarted = new MongoClient(mongo.uri, { ignoreUndefined: true });
    await restarted.connect();
    try {
      const freshHub = liveHub({ clock: now });
      await engineOver(repositoryDb(restarted.db(DATABASE)), freshHub).restore();
      const audience = peer();
      freshHub.join(audience.transport, 'audience', grantFor([]));
      expect(audience.frames[0]).toMatchObject({ kind: 'snapshot', state: { view: 'audience', frame: { itemId: 'item-1', slideIndex: 3 } } });
      expect(audience.frames[0]?.['stateRevision']).toBeGreaterThanOrEqual(lastSent);
    } finally {
      await restarted.close();
    }
  });
});
