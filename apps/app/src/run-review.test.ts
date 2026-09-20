import { describe, expect, it } from 'vitest';

import { requestContext } from './context.js';
import { midServiceOn } from './mid-service-additions.js';
import { RECORDS } from './records.js';
import { RepositoryError } from './repositories.js';
import { PRESENTATION_CONTROL } from './roles.js';
import { RunEventError, runEventContext, runEventsOn } from './run-events.js';
import { runReviewContext, runReviewOn } from './run-review.js';
import { runsOn } from './runs.js';
import { serviceContext, servicesOn } from './services.js';
import { OVERRIDE_ACTION, preparationContext, preparationOn } from './snapshots.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { ServiceDraft, ServiceSection } from '@holydeck/contracts/services';
import type { SnapshotPin } from '@holydeck/contracts/snapshots';

import type { Document } from './repositories.js';
import type { RunEventStore } from './run-events.js';
import type { RunReviewStore } from './run-review.js';
import type { RunPhase } from './runs.js';
import type { OperatorSession, PreparationInputs } from './snapshots.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-21T09:30:00.000Z');
const ADDED_AT = '2026-09-21T09:47:00.000Z';
const OPERATOR = `account:${'D'.repeat(22)}`;
const CORRELATION = 'req-run-review-1';
const CONTENT_ID = 'mid-service-content-1';

const EDITOR = serviceContext(OPERATOR, CORRELATION);
const PREPARER = preparationContext(OPERATOR, CORRELATION);
const READER = runReviewContext(OPERATOR, CORRELATION);
const STRANGER = requestContext({ actor: 'account:visitor', permissions: [], correlationId: 'req-visitor-1' });

const SESSION: OperatorSession = { actor: OPERATOR, permissions: [PRESENTATION_CONTROL], correlationId: CORRELATION };
const UNAUTHORIZED: OperatorSession = { actor: OPERATOR, permissions: [], correlationId: CORRELATION };

const RUN_EVENTS = RECORDS.runEvents.collection;

// Three items planned, and the review is never allowed to read any of them: what a run showed is the log's
// answer, and the plan is only what somebody meant to show.
const SECTIONS: readonly ServiceSection[] = [
  {
    id: 'section-1',
    name: 'Gathering',
    items: [
      { id: 'item-1', kind: 'custom-slide', title: 'Welcome', enabled: true, content: undefined },
      { id: 'item-2', kind: 'custom-slide', title: 'Psalm 23', enabled: true, content: undefined },
      { id: 'item-3', kind: 'custom-slide', title: 'Doxology', enabled: true, content: undefined },
    ],
  },
];
const DRAFT: ServiceDraft = { title: 'Sunday Morning', date: '2026-09-21', site: 'Main Hall', sections: SECTIONS };

const INPUTS: PreparationInputs = {
  slideLayout: { id: 'layout-1', revision: 3 },
  serviceTemplate: 'template-1@2',
  settings: 'settings@41',
  media: 'media@2026-09-19',
  corpus: 'corpus@2026-08-01',
  aspectRatio: '16:9',
};

interface Live {
  readonly db: FakeDb;
  readonly events: RunEventStore;
  readonly review: RunReviewStore;
  readonly runId: string;
  readonly pins: Readonly<Record<SnapshotPin, string>>;
  /** Puts content in front of the room the way `mid-service-additions.ts` does — never in the plan. */
  readonly addMidService: (title: string) => Promise<string>;
  /** A second run of the same Service, in the same database, so one run's log is told from another's. */
  readonly startAnother: () => Promise<string>;
  /** Ends the run and answers the phase it ended in, so a test proves the run really is over. */
  readonly end: () => Promise<RunPhase>;
}

/** A run that is on, started the one way `runs.ts` starts one: a Service, a manifest, and Go Live. */
const live = async (): Promise<Live> => {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  const now = (): string => new Date(START + (tick += 1) * 1000).toISOString();
  const service = await servicesOn(db, { now, newId: () => 'service-1' }).create(EDITOR, DRAFT);
  const record = await preparationOn(db, { now }).prepare(PREPARER, service.stamp.id, INPUTS);
  const runs = runsOn(db, { now, newId: () => `run-${(serial += 1)}`, observe: () => ({ slideLayoutRevision: 3, checks: [] }) });
  const run = await runs.start(SESSION, { serviceId: service.stamp.id, mode: 'live' });
  const events = runEventsOn(db, { now });
  const additions = midServiceOn(db, { now: () => ADDED_AT, newId: () => CONTENT_ID });
  return {
    db,
    events,
    review: runReviewOn(events),
    runId: run.runId,
    pins: record!.snapshot.pins,
    addMidService: async (title) => {
      const outcome = await additions.add(SESSION, { runId: run.runId, kind: 'reading', title, body: { text: title } });
      return outcome.addition.contentId;
    },
    startAnother: async () => (await runs.start(SESSION, { serviceId: service.stamp.id, mode: 'live' })).runId,
    end: async () => (await runs.end(SESSION, run.runId))!.phase,
  };
};

const rows = (db: FakeDb, collection: string): Document[] => db.rows.get(collection) ?? [];

const refusedEvent = async (call: Promise<unknown>): Promise<RunEventError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof RunEventError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

const refusedRead = async (call: Promise<unknown>): Promise<RepositoryError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof RepositoryError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('the references a run showed', () => {
  it('is derived from the run log, in the order the run showed them', async () => {
    const { review, runId, pins } = await live();

    // Shown out of the order the Service plans them, and one planned item is never shown at all.
    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });
    await review.show(SESSION, { runId, itemId: 'item-1', reference: 'Welcome', pinnedRevisions: pins });

    const shown = await review.review(READER, runId);

    expect(shown.map((entry) => entry.reference)).toEqual(['Psalm 23:1-6', 'Welcome']);
    expect(shown.map((entry) => entry.itemId)).toEqual(['item-2', 'item-1']);
    // The plan's own order is Welcome, Psalm 23, Doxology — so a review read off the Service definition
    // would answer all three, in that order, which is exactly what this rules out.
    expect(shown.map((entry) => entry.reference)).not.toContain('Doxology');
  });

  it('carries the log’s own sequence, instant and actor on every entry', async () => {
    const { events, review, runId, pins } = await live();

    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });
    await review.show(SESSION, { runId, itemId: 'item-3', reference: 'Doxology', pinnedRevisions: pins });

    const shown = await review.review(READER, runId);
    const log = await events.log(runEventContext(OPERATOR, CORRELATION), runId);

    expect(shown).toEqual(
      log.map((event) => ({
        sequence: event.sequence,
        at: event.at,
        actor: event.actor,
        itemId: event.shown!.itemId,
        reference: event.shown!.reference,
      })),
    );
  });

  it('holds the same reference twice when the run showed it twice', async () => {
    const { review, runId, pins } = await live();

    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });
    await review.show(SESSION, { runId, itemId: 'item-1', reference: 'Welcome', pinnedRevisions: pins });
    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });

    const shown = await review.review(READER, runId);

    expect(shown.map((entry) => entry.reference)).toEqual(['Psalm 23:1-6', 'Welcome', 'Psalm 23:1-6']);
    expect(shown.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
  });

  it('includes content added mid-service, which the Service definition never held', async () => {
    const { review, runId, pins, addMidService } = await live();

    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });
    const contentId = await addMidService('Psalm 121');

    const shown = await review.review(READER, runId);

    expect(shown.map((entry) => entry.reference)).toEqual(['Psalm 23:1-6', 'Psalm 121']);
    expect(shown[1]).toMatchObject({ itemId: contentId, reference: 'Psalm 121', sequence: 2 });
  });

  it('leaves out every event that put nothing in front of the room', async () => {
    const { db, events, review, runId, pins } = await live();

    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });
    // The three change classes that move no content into view, and the override row `snapshots.ts`
    // writes into this same table — all four are in the log, and none of them is a reference shown.
    await events.record(SESSION, { runId, kind: 'theme-changed', pinnedRevisions: pins });
    await events.record(SESSION, { runId, kind: 'standby-changed', pinnedRevisions: pins });
    await events.record(SESSION, { runId, kind: 'run-state-changed', pinnedRevisions: pins });
    db.rows.set(RUN_EVENTS, [
      ...rows(db, RUN_EVENTS),
      {
        _id: `${runId}#5`,
        runId,
        sequence: 5,
        at: new Date(START + 60_000).toISOString(),
        kind: OVERRIDE_ACTION,
        pinnedRevisions: pins,
        actor: OPERATOR,
        correlationId: CORRELATION,
      },
    ]);

    const shown = await review.review(READER, runId);

    expect(await events.log(READER, runId)).toHaveLength(5);
    expect(shown.map((entry) => entry.reference)).toEqual(['Psalm 23:1-6']);
  });

  it('is empty for a run that has shown nothing yet', async () => {
    const { review, runId } = await live();

    expect(await review.review(READER, runId)).toEqual([]);
    expect(await review.recap(READER, runId)).toEqual({ runId, lines: [] });
  });

  it('is one run’s own references, never another run’s', async () => {
    const { review, runId, pins, startAnother } = await live();
    // The same Service, run twice — one log, one database, and two runs whose references are not each
    // other's. A second Sunday is what the plan's own list could never tell apart.
    const second = await startAnother();

    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });
    await review.show(SESSION, { runId: second, itemId: 'item-1', reference: 'Welcome', pinnedRevisions: pins });

    expect((await review.review(READER, runId)).map((entry) => entry.reference)).toEqual(['Psalm 23:1-6']);
    expect((await review.review(READER, second)).map((entry) => entry.reference)).toEqual(['Welcome']);
    expect(await review.recap(READER, second)).toEqual({ runId: second, lines: ['1. Welcome'] });
  });
});

describe('showing a reference', () => {
  it('refuses a session without Control presentation, and the log keeps nothing', async () => {
    const { db, review, runId, pins } = await live();

    const error = await refusedEvent(
      review.show(UNAUTHORIZED, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins }),
    );

    expect(error.kind).toBe('permission');
    expect(rows(db, RUN_EVENTS)).toHaveLength(0);
  });

  it('refuses a reference nobody could read back, rather than logging a blank one', async () => {
    const { review, runId, pins } = await live();

    const blank = await refusedEvent(review.show(SESSION, { runId, itemId: 'item-2', reference: '  ', pinnedRevisions: pins }));
    const nameless = await refusedEvent(review.show(SESSION, { runId, itemId: '', reference: 'Psalm 23:1-6', pinnedRevisions: pins }));

    expect(blank.kind).toBe('schema');
    expect(nameless.kind).toBe('schema');
  });

  it('appends one `current-slide-changed` carrying what was shown', async () => {
    const { events, review, runId, pins } = await live();

    const event = await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });

    expect(event).toMatchObject({
      runId,
      sequence: 1,
      kind: 'current-slide-changed',
      actor: OPERATOR,
      pinnedRevisions: pins,
      shown: { itemId: 'item-2', reference: 'Psalm 23:1-6' },
    });
    expect(await events.log(READER, runId)).toEqual([event]);
  });
});

describe('a recap of the run', () => {
  it('renders one numbered line per reference shown, in the log’s own order', async () => {
    const { review, runId, pins } = await live();

    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });
    await review.show(SESSION, { runId, itemId: 'item-1', reference: 'Welcome', pinnedRevisions: pins });

    expect(await review.recap(READER, runId)).toEqual({ runId, lines: ['1. Psalm 23:1-6', '2. Welcome'] });
  });

  it('says exactly what the log says, derived independently from the log itself', async () => {
    const { events, review, runId, pins } = await live();

    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });
    await events.record(SESSION, { runId, kind: 'theme-changed', pinnedRevisions: pins });
    await review.show(SESSION, { runId, itemId: 'item-3', reference: 'Doxology', pinnedRevisions: pins });

    const recap = await review.recap(READER, runId);
    const fromLog = (await events.log(runEventContext(OPERATOR, CORRELATION), runId))
      .filter((event) => event.shown !== undefined)
      .map((event, index) => `${index + 1}. ${event.shown!.reference}`);

    expect(recap.lines).toEqual(fromLog);
  });

  it('follows the log: a recap that no longer matches it is a recap this test rejects', async () => {
    const { review, runId, pins } = await live();

    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });
    const before = await review.recap(READER, runId);
    await review.show(SESSION, { runId, itemId: 'item-1', reference: 'Welcome', pinnedRevisions: pins });
    const after = await review.recap(READER, runId);

    // The stale recap is exactly a recap that diverges from the log: it is missing what the run went on
    // to show. Nothing kept it up to date, because nothing keeps a recap at all.
    expect(before.lines).not.toEqual(after.lines);
    expect(after.lines).toEqual(['1. Psalm 23:1-6', '2. Welcome']);
    expect(await review.recap(READER, runId)).toEqual(after);
  });

  it('is stored nowhere: rendering one writes not a single row', async () => {
    const { db, review, runId, pins } = await live();

    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });
    const before = [...db.rows].map(([collection, stored]) => [collection, stored.length] as const);

    await review.recap(READER, runId);
    await review.review(READER, runId);

    expect([...db.rows].map(([collection, stored]) => [collection, stored.length] as const)).toEqual(before);
  });
});

describe('reviewing during and after the run', () => {
  it('answers the same after the run ended as it did while it was on', async () => {
    const { review, runId, pins, end } = await live();

    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });
    await review.show(SESSION, { runId, itemId: 'item-1', reference: 'Welcome', pinnedRevisions: pins });
    const during = await review.review(READER, runId);
    const duringRecap = await review.recap(READER, runId);

    expect(await end()).toBe('ended');

    expect(await review.review(READER, runId)).toEqual(during);
    expect(await review.recap(READER, runId)).toEqual(duringRecap);
    expect(during.map((entry) => entry.reference)).toEqual(['Psalm 23:1-6', 'Welcome']);
  });

  it('reflects the immutable log after the run, including what was shown mid-service', async () => {
    const { review, runId, pins, addMidService, end } = await live();

    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });
    const contentId = await addMidService('Psalm 121');
    await end();

    const shown = await review.review(READER, runId);

    expect(shown.map((entry) => entry.reference)).toEqual(['Psalm 23:1-6', 'Psalm 121']);
    expect(shown[1]).toMatchObject({ itemId: contentId, actor: OPERATOR });
    expect(await review.recap(READER, runId)).toEqual({ runId, lines: ['1. Psalm 23:1-6', '2. Psalm 121'] });
  });

  it('is durable: a fresh store over the same database answers exactly the same', async () => {
    const { db, review, runId, pins, end } = await live();
    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });
    await end();
    const shown = await review.review(READER, runId);

    // Nothing about a review is held between calls, so a restarted process reviews the same run the same
    // way — the log is the whole of what either store reads.
    const restarted = runReviewOn(runEventsOn(db, { now: () => ADDED_AT }));

    expect(await restarted.review(READER, runId)).toEqual(shown);
    expect(await restarted.recap(READER, runId)).toEqual({ runId, lines: ['1. Psalm 23:1-6'] });
  });
});

describe('reading the review', () => {
  it('needs only the log’s own read permission, never Control presentation', async () => {
    const { review, runId, pins } = await live();
    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });

    // A context carrying `runEvents.read` and nothing else — no `presentation.control`, no append.
    const inspector = runReviewContext('account:inspector', 'req-inspector-1');
    expect(inspector.permissions).toEqual(['runEvents.read']);

    expect((await review.review(inspector, runId)).map((entry) => entry.reference)).toEqual(['Psalm 23:1-6']);
  });

  it('refuses a context that may not read the run log at all', async () => {
    const { review, runId, pins } = await live();
    await review.show(SESSION, { runId, itemId: 'item-2', reference: 'Psalm 23:1-6', pinnedRevisions: pins });

    expect((await refusedRead(review.review(STRANGER, runId))).kind).toBe('permission');
    expect((await refusedRead(review.recap(STRANGER, runId))).kind).toBe('permission');
  });
});
