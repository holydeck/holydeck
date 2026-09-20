import { slideGroupAudioAction } from '@holydeck/contracts/live-media';
import { prepareRenderModel } from '@holydeck/renderer/render-model';
import { frameBytes, renderPrepared, serializeFrame } from '@holydeck/renderer/renderer';
import { describe, expect, it } from 'vitest';

import { RECORDS } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';
import { guardRemoval, sweep } from './retention.js';
import {
  RUN_EVENT_PERMISSIONS,
  RunEventError,
  runEventContext,
  runEventsOn,
} from './run-events.js';
import { OVERRIDE_ACTION, RUN_EVENT_RECORD } from './snapshots.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { RenderModelInput } from '@holydeck/renderer/render-model';
import type { TextMeasurer } from '@holydeck/renderer/measure';
import type { RetentionCandidate } from './retention.js';
import type { RunEventInput, RunEventStore } from './run-events.js';
import type { OperatorSession } from './snapshots.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-19T10:00:00.000Z');
const OPERATOR = `account:${'D'.repeat(22)}`;
const CORRELATION = 'req-run-events-1';
const RUN_ID = 'run-1';

const SESSION: OperatorSession = { actor: OPERATOR, permissions: ['presentation.control'], correlationId: CORRELATION };
const UNAUTHORIZED: OperatorSession = { actor: 'account:viewer', permissions: [], correlationId: 'req-viewer-1' };
const READ_CONTEXT = runEventContext(OPERATOR, CORRELATION);

const PINS_ONE = Object.freeze({
  service: 'service@1',
  content: 'content@1',
  slideLayout: 'layout@1',
  serviceTemplate: 'template@1',
  settings: 'settings@1',
  media: 'media@1',
  corpus: 'corpus@1',
});

const PINS_TWO = Object.freeze({ ...PINS_ONE, content: 'content@2' });

interface Harness {
  readonly db: FakeDb;
  readonly store: RunEventStore;
}

const harness = (): Harness => {
  const db = fakeDb();
  let tick = 0;
  const now = (): string => new Date(START + (tick += 1) * 1000).toISOString();
  return { db, store: runEventsOn(db, { now }) };
};

const refused = async (call: Promise<unknown>): Promise<RunEventError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof RunEventError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

// A trivial stand-in for the headless-Chrome measurer: fixed advance width per character, so a suite about
// storing and replaying pins never depends on a real font. `measure.ts`'s own suite drives real measurement.
const flatMeasurer: TextMeasurer = {
  measure: (requests) =>
    Promise.resolve(requests.map((request) => ({ widthPx: request.text.length * request.fontSizePx * 0.5, heightPx: request.fontSizePx * request.lineHeight, lineCount: 1 }))),
  close: () => Promise.resolve(),
};

const modelOf = (text: string): RenderModelInput => ({
  id: 'set-1',
  outputType: 'main',
  slides: [
    {
      id: 'slide-1',
      boxes: [
        {
          id: 'lyric',
          kind: 'text',
          text,
          frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
          font: { family: 'Inter', weight: 600, sizeRatio: 0.09, lineHeight: 1.2 },
          importance: 'required',
        },
      ],
    },
  ],
});

// What this run actually showed, keyed by the pins each event carried — the test's stand-in for a real
// content-addressed store, which always answers the same bytes for the same address (ADR 0001).
const MODELS_BY_CONTENT_PIN: Readonly<Record<string, RenderModelInput>> = {
  'content@1': modelOf('In the beginning'),
  'content@2': modelOf('God created the heavens and the earth'),
};

describe('recording a run event', () => {
  it('appends an immutable event with actor, time and the pinned revision shown', async () => {
    const { store } = harness();
    const input: RunEventInput = { runId: RUN_ID, kind: 'current-slide-changed', pinnedRevisions: PINS_ONE };

    const event = await store.record(SESSION, input);

    expect(event).toMatchObject({ runId: RUN_ID, sequence: 1, kind: 'current-slide-changed', actor: OPERATOR, pinnedRevisions: PINS_ONE });
    expect(event.at).toBe(new Date(START + 1000).toISOString());
  });

  it('appends every one of the four operator state change classes', async () => {
    const { store } = harness();
    const kinds: readonly RunEventInput['kind'][] = ['current-slide-changed', 'standby-changed', 'theme-changed', 'run-state-changed'];

    for (const kind of kinds) {
      const event = await store.record(SESSION, { runId: RUN_ID, kind, pinnedRevisions: PINS_ONE });
      expect(event.kind).toBe(kind);
    }

    const log = await store.log(READ_CONTEXT, RUN_ID);
    expect(log.map((event) => event.kind)).toEqual(kinds);
    expect(log.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  });

  it('refuses a session without Control presentation, before anything is read or written', async () => {
    const { store, db } = harness();

    const error = await refused(store.record(UNAUTHORIZED, { runId: RUN_ID, kind: 'current-slide-changed', pinnedRevisions: PINS_ONE }));

    expect(error.kind).toBe('permission');
    expect(db.rows.get(RECORDS.runEvents.collection) ?? []).toHaveLength(0);
  });

  it('refuses an event missing one of the seven pinned revisions', async () => {
    const { store } = harness();
    const incomplete = { ...PINS_ONE, media: '' };

    const error = await refused(store.record(SESSION, { runId: RUN_ID, kind: 'current-slide-changed', pinnedRevisions: incomplete }));

    expect(error.kind).toBe('schema');
  });

  it('refuses a kind that is not one of live-events.ts’s four change classes', async () => {
    const { store } = harness();

    const error = await refused(
      store.record(SESSION, { runId: RUN_ID, kind: 'not-a-real-kind' as never, pinnedRevisions: PINS_ONE }),
    );

    expect(error.kind).toBe('schema');
  });

  it('refuses two operators racing the same run, the way two concurrent writers would', async () => {
    const { store } = harness();

    const [first, second] = await Promise.allSettled([
      store.record(SESSION, { runId: RUN_ID, kind: 'current-slide-changed', pinnedRevisions: PINS_ONE }),
      store.record(SESSION, { runId: RUN_ID, kind: 'current-slide-changed', pinnedRevisions: PINS_TWO }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(RunEventError);
      expect((rejected.reason as RunEventError).kind).toBe('conflict');
    }
  });
});

// ADR 0002's invariant: no mutation of delivery history once a service is Completed, and ADR 0007's
// invariant: mutation and deletion of a run event are rejected at the storage layer
// (adrs/0002-service-lifecycle-and-delivery-immutability.md, adrs/0007-immutable-run-event-log.md;
// adrs/index.json lists T79 under both ADR 0002's and ADR 0007's enforcedBy).
describe('a mutation or delete attempt on a run event', () => {
  it('has no verb to rewrite one: the repository this module writes through offers only append and read', async () => {
    const { store, db } = harness();
    await store.record(SESSION, { runId: RUN_ID, kind: 'current-slide-changed', pinnedRevisions: PINS_ONE });
    const collection = db.collection(RECORDS.runEvents.collection) as unknown as Record<string, unknown>;

    expect(Object.keys(collection).sort()).toEqual(['countDocuments', 'createIndex', 'dropIndex', 'find', 'insertOne'].sort());
  });

  it('refuses a second write claiming a sequence a row already holds — an overwrite attempt in fact', async () => {
    const { store, db } = harness();
    await store.record(SESSION, { runId: RUN_ID, kind: 'current-slide-changed', pinnedRevisions: PINS_ONE });
    const runEvents = repositoriesOn(db)[RUN_EVENT_RECORD];
    const context = runEventContext(OPERATOR, CORRELATION);

    const rewrite = runEvents.append(context, {
      _id: `${RUN_ID}#1`,
      runId: RUN_ID,
      sequence: 1,
      at: new Date(START + 9000).toISOString(),
      kind: 'standby-changed',
      pinnedRevisions: PINS_TWO,
      actor: OPERATOR,
      correlationId: CORRELATION,
    });

    await expect(rewrite).rejects.toThrow(RepositoryError);
    const stored = await runEvents.read(context, { runId: RUN_ID });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: 'current-slide-changed', pinnedRevisions: PINS_ONE });
  });
});

// ADR 0007's invariant: the run is exactly reconstructable from its pinned revisions plus its log,
// and reconstruction equals what was recorded (adrs/0007-immutable-run-event-log.md; adrs/index.json
// lists T79 under ADR 0007's enforcedBy).
describe('reconstructing a run', () => {
  it('is exactly the pinned revisions plus the log, replayed in order through the real renderer', async () => {
    const { store } = harness();
    // Two slides shown in order, and one operator override between them — the log holds all three kinds,
    // and reconstruction has to replay every one of them, not only the ones this module itself wrote.
    await store.record(SESSION, { runId: RUN_ID, kind: 'current-slide-changed', pinnedRevisions: PINS_ONE });
    await store.record(SESSION, { runId: RUN_ID, kind: 'current-slide-changed', pinnedRevisions: PINS_TWO });

    // The renders a live surface would have produced at the moment each event was recorded.
    const originalFrames = await Promise.all(
      [PINS_ONE, PINS_TWO].map(async (pins) =>
        frameBytes(renderPrepared(await prepareRenderModel({ model: MODELS_BY_CONTENT_PIN[pins.content]!, measurer: flatMeasurer }))),
      ),
    );

    const log = await store.log(READ_CONTEXT, RUN_ID);
    expect(log).toHaveLength(2);

    const replayedFrames = await Promise.all(
      log.map(async (event) =>
        frameBytes(
          renderPrepared(
            await prepareRenderModel({ model: MODELS_BY_CONTENT_PIN[event.pinnedRevisions.content]!, measurer: flatMeasurer }),
          ),
        ),
      ),
    );

    expect(replayedFrames.map((frame) => Buffer.from(frame))).toEqual(originalFrames.map((frame) => Buffer.from(frame)));
    // The two slides shown were different, so a reconstruction that could not tell them apart would still
    // pass a same-length check; comparing the serialized bytes against each other rules that out.
    const replayedText = await Promise.all(
      log.map(async (event) =>
        serializeFrame(renderPrepared(await prepareRenderModel({ model: MODELS_BY_CONTENT_PIN[event.pinnedRevisions.content]!, measurer: flatMeasurer }))),
      ),
    );
    expect(replayedText[0]).not.toBe(replayedText[1]);
  });

  it('reads a run’s log in server order however the log grows, override rows included', async () => {
    const { store, db } = harness();
    await store.record(SESSION, { runId: RUN_ID, kind: 'current-slide-changed', pinnedRevisions: PINS_ONE });
    // The one existing writer into this same table, exactly as `snapshots.ts`'s override appends it —
    // proving `log` reconstructs the whole run, not only the events this module itself wrote.
    db.rows.set(RECORDS.runEvents.collection, [
      ...(db.rows.get(RECORDS.runEvents.collection) ?? []),
      {
        _id: `${RUN_ID}#2`,
        runId: RUN_ID,
        sequence: 2,
        at: new Date(START + 5000).toISOString(),
        kind: OVERRIDE_ACTION,
        pinnedRevisions: PINS_ONE,
        actor: OPERATOR,
        correlationId: CORRELATION,
      },
    ]);

    const log = await store.log(READ_CONTEXT, RUN_ID);

    expect(log.map((event) => event.kind)).toEqual(['current-slide-changed', OVERRIDE_ACTION]);
  });

  it('refuses to serve a stored row this code cannot read rather than reconstruct from a guess', async () => {
    const { store, db } = harness();
    db.rows.set(RECORDS.runEvents.collection, [
      { _id: `${RUN_ID}#1`, runId: RUN_ID, sequence: 1, at: new Date(START).toISOString(), kind: 'current-slide-changed', pinnedRevisions: PINS_ONE, correlationId: CORRELATION },
    ]);

    const error = await refused(store.log(READ_CONTEXT, RUN_ID));

    expect(error.kind).toBe('corrupt');
  });
});

describe('Invariant 13', () => {
  it('never lets retention of another class delete a protected run event', async () => {
    const { store } = harness();
    const event = await store.record(SESSION, { runId: RUN_ID, kind: 'current-slide-changed', pinnedRevisions: PINS_ONE });

    const protectedEvent: RetentionCandidate = {
      id: `${event.runId}#${event.sequence}`,
      class: 'run-event',
      ageDays: 10_000,
      protectedBy: [],
    };
    const expiredAuditEntry: RetentionCandidate = {
      id: 'audit-1',
      class: 'audit-entry',
      ageDays: 500,
      protectedBy: [],
    };

    expect(() => guardRemoval(protectedEvent)).toThrow('run-event is never removed');

    const outcome = sweep([protectedEvent, expiredAuditEntry]);
    expect(outcome.removable).toEqual(['audit-1']);
    expect(outcome.retained).toEqual([{ id: `${RUN_ID}#1`, reason: 'protected-class', message: expect.any(String) }]);
  });
});

// LIVE-20 (T114): a slide group's own backing track reuses the run event log a single slide's media
// already writes through — `slideGroupAudioAction`'s decision names nothing about storage, and this is
// the proof the two compose without either one being taught about the other.
describe("a slide group's backing track starting, as a run event (LIVE-20)", () => {
  it('reaches the run log with actor, time, and the pinned revisions LIVE-12 requires', async () => {
    const { store } = harness();
    const action = slideGroupAudioAction(undefined, { slideGroupId: 'group-1', audioTrackId: 'hymn-1' }, {});
    expect(action.kind).toBe('start');

    const event = await store.record(SESSION, { runId: RUN_ID, kind: 'current-slide-changed', pinnedRevisions: PINS_ONE });

    expect(event).toMatchObject({
      runId: RUN_ID,
      kind: 'current-slide-changed',
      actor: OPERATOR,
      pinnedRevisions: PINS_ONE,
    });
    expect(event.at).toBe(new Date(START + 1000).toISOString());
    const log = await store.log(READ_CONTEXT, RUN_ID);
    expect(log).toEqual([event]);
  });
});

describe('RUN_EVENT_PERMISSIONS', () => {
  it('is named after the runEvents record class `snapshots.ts` already declares', () => {
    expect(RUN_EVENT_PERMISSIONS).toEqual({ read: 'runEvents.read', append: 'runEvents.append' });
  });
});
