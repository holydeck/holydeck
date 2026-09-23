import { describe, expect, it } from 'vitest';

import { libraryContext, libraryOn } from './library.js';
import { LIVE_EVENT_TYPES } from './live-events.js';
import {
  MID_SERVICE_INDEXES,
  MID_SERVICE_PERMISSIONS,
  MidServiceError,
  midServiceContext,
  midServiceOn,
} from './mid-service-additions.js';
import { RECORDS } from './records.js';
import { revisionsOn } from './revisions.js';
import { PRESENTATION_CONTROL } from './roles.js';
import { runEventContext, runEventsOn } from './run-events.js';
import { runsOn } from './runs.js';
import { serviceContext, servicesOn } from './services.js';
import { preparationContext, preparationOn } from './snapshots.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { RevisionBody } from '@holydeck/contracts/revisions';
import type { ServiceDraft, ServiceSection } from '@holydeck/contracts/services';
import type { SnapshotPin } from '@holydeck/contracts/snapshots';

import type { MidServiceOutcome, MidServiceStore } from './mid-service-additions.js';
import type { Document } from './repositories.js';
import type { RunEventStore } from './run-events.js';
import type { RunStore } from './runs.js';
import type { OperatorSession, PreparationInputs } from './snapshots.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-20T09:30:00.000Z');
const ADDED_AT = '2026-09-20T09:47:00.000Z';
const OPERATOR = `account:${'D'.repeat(22)}`;
const CORRELATION = 'req-mid-service-1';
const CONTENT_ID = 'mid-service-content-1';

const EDITOR = serviceContext(OPERATOR, CORRELATION);
const PREPARER = preparationContext(OPERATOR, CORRELATION);
const READER = midServiceContext(OPERATOR, CORRELATION);
const LIBRARIAN = libraryContext(OPERATOR, CORRELATION);

const SESSION: OperatorSession = { actor: OPERATOR, permissions: [PRESENTATION_CONTROL], correlationId: CORRELATION };
const UNAUTHORIZED: OperatorSession = { actor: OPERATOR, permissions: [], correlationId: CORRELATION };

const LIBRARY = RECORDS.contentLibrary.collection;
const ADDITIONS = RECORDS.midServiceAdditions.collection;
const SNAPSHOTS = RECORDS.preparedSnapshots.collection;

const SECTIONS: readonly ServiceSection[] = [
  {
    id: 'section-1',
    name: 'Worship',
    items: [{ id: 'item-1', kind: 'custom-slide', title: 'Welcome', enabled: true, content: undefined }],
  },
];
const DRAFT: ServiceDraft = { title: 'Sunday Morning', date: '2026-09-20', site: 'Main Hall', sections: SECTIONS };

// The same shape `runs.test.ts` prepares from, observed at the revision it pins so the run starts Ready.
const INPUTS: PreparationInputs = {
  slideLayout: { id: 'layout-1', revision: 3 },
  serviceTemplate: 'template-1@2',
  settings: 'settings@41',
  media: 'media@2026-09-19',
  corpus: 'corpus@2026-08-01',
  aspectRatio: '16:9',
};

const READING: RevisionBody = { text: 'The Lord is my shepherd; I shall not want' };
const SONG: RevisionBody = { lines: ['Amazing grace, how sweet the sound'] };

interface Live {
  readonly db: FakeDb;
  readonly store: MidServiceStore;
  readonly runs: RunStore;
  readonly runEvents: RunEventStore;
  readonly runId: string;
  readonly serviceId: string;
  readonly pins: Readonly<Record<SnapshotPin, string>>;
  readonly end: () => Promise<void>;
}

/** A run that is on, started the one way `runs.ts` starts one: a Service, a manifest, and Go Live. */
const live = async (): Promise<Live> => {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  const now = (): string => new Date(START + (tick += 1) * 1000).toISOString();
  const service = await servicesOn(db, { now, newId: () => 'service-1' }).create(EDITOR, DRAFT);
  const record = await preparationOn(db, { now }).prepare(PREPARER, service.stamp.id, INPUTS);
  // One counter for the run and for every trail entry `runs.ts` files beside it, the way `runs.test.ts`
  // does: a run and an audit entry minted under one fixed identifier would collide on the second write.
  const runs = runsOn(db, { now, newId: () => `run-${(serial += 1)}`, observe: () => ({ slideLayoutRevision: 3, checks: [] }) });
  const runEvents = runEventsOn(db, { now: () => ADDED_AT });
  const run = await runs.start(SESSION, { serviceId: service.stamp.id, mode: 'live' });
  return {
    db,
    store: midServiceOn(db, { now: () => ADDED_AT, newId: () => CONTENT_ID, runs, runEvents }),
    runs,
    runEvents,
    runId: run.runId,
    serviceId: service.stamp.id,
    pins: record!.snapshot.pins,
    end: async () => {
      await runs.end(SESSION, run.runId);
    },
  };
};

const rows = (db: FakeDb, collection: string): Document[] => db.rows.get(collection) ?? [];

const refused = async (call: Promise<unknown>): Promise<MidServiceError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof MidServiceError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('content added while a run is on', () => {
  it('joins the run and appends an item-added run event', async () => {
    const { db, store, runId, pins } = await live();

    const outcome = await store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING });

    expect(outcome.event).toMatchObject({
      runId,
      sequence: 1,
      kind: LIVE_EVENT_TYPES.itemAdded,
      actor: OPERATOR,
      pinnedRevisions: pins,
    });
    const log = await runEventsOn(db, { now: () => ADDED_AT }).log(runEventContext(OPERATOR, CORRELATION), runId);
    expect(log).toEqual([outcome.event]);
  });

  it('claims nothing shown: adding is not showing, and LIVE-13 reviews only what reached the room', async () => {
    const { store, runId } = await live();

    const outcome = await store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING });

    // The row keeps the title a person gave it and the revision its body was saved as, so the run deck
    // can name and build the item; the run log says it was shown only once the engine puts it up.
    expect(outcome.event.shown).toBeUndefined();
    expect(outcome.addition).toMatchObject({ title: 'Psalm 23', revision: outcome.revision.revision });
  });

  it('carries the run’s own standing pins through unchanged, content pin included', async () => {
    const { db, store, runId, pins } = await live();

    const outcome = await store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING });

    // A run is past preparation, and preparation writes one manifest and never rewrites it: the content
    // pin the run event carries is the one the manifest froze, not one recomputed over the addition.
    expect(outcome.event.pinnedRevisions).toEqual(pins);
    expect(outcome.event.pinnedRevisions.content).toBe(pins.content);
    expect(rows(db, SNAPSHOTS)).toHaveLength(1);
    expect(rows(db, SNAPSHOTS)[0]?.['pins']).toEqual(pins);
  });

  it('pins the manifest its own run replays from, not whichever one the Service last prepared', async () => {
    const { db, store, runId, serviceId, pins } = await live();
    // The Service is edited and prepared again while the run is on — a second, different manifest, which
    // ADR 0006 leaves standing beside the first rather than rewriting it. A run replays from the one it
    // went live on, so nothing the Service does afterwards may move what its run events pin.
    await servicesOn(db, { now: () => '2026-09-20T09:44:00.000Z' }).addItem(EDITOR, serviceId, 'section-1', {
      id: 'item-2',
      kind: 'custom-slide',
      title: 'Announcements',
      enabled: true,
      content: undefined,
    });
    const newer = await preparationOn(db, { now: () => '2026-09-20T09:45:00.000Z' }).prepare(PREPARER, serviceId, INPUTS);
    expect(rows(db, SNAPSHOTS)).toHaveLength(2);
    expect(newer!.snapshot.pins.content).not.toBe(pins.content);

    const outcome = await store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING });

    expect(outcome.event.pinnedRevisions).toEqual(pins);
    expect(outcome.event.pinnedRevisions.content).toBe(pins.content);
    expect(outcome.event.pinnedRevisions.service).toBe(pins.service);
  });

  it('saves the body under the identifier it minted, as the explicit save a person made', async () => {
    const { db, store, runId } = await live();

    const outcome = await store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING });

    const revision = await revisionsOn(db, { now: () => ADDED_AT }).current(READER, outcome.addition.contentId);
    expect(outcome.addition.contentId).toBe(CONTENT_ID);
    expect(revision).toMatchObject({ contentId: CONTENT_ID, revision: 1, origin: 'manual-checkpoint', body: READING });
  });

  it('records the addition through the injected run-events store, not one it builds itself', async () => {
    const { db, runId, runs } = await live();
    const recorded: unknown[] = [];
    const spyEvents: RunEventStore = {
      record: async (session, input) => {
        recorded.push({ session, input });
        return runEventsOn(db, { now: () => ADDED_AT }).record(session, input);
      },
      log: async (context, id) => runEventsOn(db, { now: () => ADDED_AT }).log(context, id),
    };
    const store = midServiceOn(db, { now: () => ADDED_AT, newId: () => CONTENT_ID, runs, runEvents: spyEvents });

    await store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING });

    expect(recorded).toHaveLength(1);
  });
});

describe('the provenance a mid-service addition leaves', () => {
  it('records the content, the run it joined, who added it and when', async () => {
    const { db, store, runId } = await live();

    const outcome = await store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING });

    expect(outcome.addition).toEqual({ contentId: CONTENT_ID, runId, title: 'Psalm 23', revision: 1, actor: OPERATOR, at: ADDED_AT });
    // A row of its own is the whole of what says "added mid-service": one per addition, and nothing on
    // the revision or the run is asked to carry the fact instead.
    expect(rows(db, ADDITIONS)).toEqual([
      { _id: CONTENT_ID, contentId: CONTENT_ID, runId, title: 'Psalm 23', revision: 1, actor: OPERATOR, at: ADDED_AT, correlationId: CORRELATION },
    ]);
  });

  it('is durable: a fresh store over the same database answers exactly the same', async () => {
    const { db, store, runId, runs, runEvents } = await live();
    const outcome = await store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING });

    const restarted = midServiceOn(db, { now: () => ADDED_AT, runs, runEvents });

    expect(await restarted.additions(READER, runId)).toEqual([outcome.addition]);
  });

  it('reads a run’s additions oldest first, however the rows came back', async () => {
    const { db, store, runId, runs, runEvents } = await live();
    const first = await store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING });
    const second = await midServiceOn(db, {
      now: () => '2026-09-20T09:52:00.000Z',
      newId: () => 'mid-service-content-2',
      runs,
      runEvents,
    }).add(
      SESSION,
      { runId, kind: 'song', title: 'Amazing Grace', body: SONG },
    );
    db.rows.set(ADDITIONS, [...rows(db, ADDITIONS)].reverse());

    const found = await store.additions(READER, runId);

    expect(found).toEqual([first.addition, second.addition]);
  });

  it('answers nothing for a run nothing was added to', async () => {
    const { store } = await live();

    expect(await store.additions(READER, 'run-nobody-ran')).toEqual([]);
  });

  it('refuses a stored row this code cannot read rather than answering a guess', async () => {
    const { db, store, runId } = await live();
    await store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING });
    db.rows.set(ADDITIONS, [{ ...rows(db, ADDITIONS)[0]!, at: 47 }]);

    expect((await refused(store.additions(READER, runId))).kind).toBe('corrupt');
  });
});

describe('the reusable content library', () => {
  it('is untouched by an addition nobody decided to keep', async () => {
    const { db, store, runId } = await live();

    const outcome = await store.add(SESSION, { runId, kind: 'song', title: 'Amazing Grace', body: SONG });

    expect(rows(db, LIBRARY)).toHaveLength(0);
    expect(await libraryOn(db, { now: () => ADDED_AT }).list(LIBRARIAN)).toEqual([]);
    expect(outcome.addition.libraryId).toBeUndefined();
    // The body is still there under the identifier this module minted: not kept is not the same as not saved.
    expect(await revisionsOn(db, { now: () => ADDED_AT }).count(READER, outcome.addition.contentId)).toBe(1);
  });

  it('gets exactly the one item an explicit save decision asked for, and nothing more', async () => {
    const { db, store, runId } = await live();

    const outcome = await store.add(SESSION, {
      runId,
      kind: 'song',
      title: 'Amazing Grace',
      body: SONG,
      saveToLibrary: true,
    });

    const items = await libraryOn(db, { now: () => ADDED_AT }).list(LIBRARIAN);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Amazing Grace' });
    expect(items[0]?.stamp.kind).toBe('song');
    expect(outcome.addition.libraryId).toBe(items[0]?.stamp.id);
    // The library mints the identifier it is discoverable by; the body stays under the one minted here.
    expect(outcome.addition.libraryId).not.toBe(outcome.addition.contentId);
  });

  it('is left alone when the addition is refused, whatever the save decision was', async () => {
    const { db, store } = await live();

    const error = await refused(
      store.add(SESSION, { runId: 'run-nobody-started', kind: 'song', title: 'Amazing Grace', body: SONG, saveToLibrary: true }),
    );

    expect(error.kind).toBe('state');
    expect(rows(db, LIBRARY)).toHaveLength(0);
    expect(rows(db, ADDITIONS)).toHaveLength(0);
    expect(rows(db, RECORDS.contentRevisions.collection)).toHaveLength(0);
    expect(rows(db, RECORDS.runEvents.collection)).toHaveLength(0);
  });
});

describe('what a mid-service addition is refused for', () => {
  // THR-11: refused by this server, not by a client declining to draw the control.
  it('refuses a session without Control presentation, before anything is read or written', async () => {
    const { db, store, runId } = await live();

    const error = await refused(store.add(UNAUTHORIZED, { runId, kind: 'reading', title: 'Psalm 23', body: READING }));

    expect(error.kind).toBe('permission');
    expect(error.message).toContain(PRESENTATION_CONTROL);
    expect(rows(db, ADDITIONS)).toHaveLength(0);
    expect(rows(db, RECORDS.contentRevisions.collection)).toHaveLength(0);
  });

  it('refuses content that is not one of the kinds the library names, or is called nothing', async () => {
    const { db, store, runId } = await live();

    const unnamed = await refused(store.add(SESSION, { runId, kind: 'song', title: '', body: SONG }));
    const unknown = await refused(store.add(SESSION, { runId, kind: 'anthem' as never, title: 'Amazing Grace', body: SONG }));

    expect(unnamed.kind).toBe('schema');
    expect(unknown.kind).toBe('schema');
    expect(rows(db, ADDITIONS)).toHaveLength(0);
    expect(rows(db, RECORDS.contentRevisions.collection)).toHaveLength(0);
  });

  it('refuses a run that has ended, since content joins a run that is on', async () => {
    const { store, runId, end } = await live();
    await end();

    const error = await refused(store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING }));

    expect(error.kind).toBe('state');
  });

  it('refuses a manifest whose pins this code cannot read, rather than pinning a guess', async () => {
    const { db, store, runId } = await live();
    const [snapshot] = rows(db, SNAPSHOTS);
    db.rows.set(SNAPSHOTS, [{ ...snapshot!, pins: { ...(snapshot!['pins'] as Record<string, string>), media: '' } }]);

    expect((await refused(store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING }))).kind).toBe(
      'corrupt',
    );
  });

  it('refuses when the manifest the run replays from is gone, newer one standing or not', async () => {
    const { db, store, runId, serviceId } = await live();
    await servicesOn(db, { now: () => '2026-09-20T09:44:00.000Z' }).addItem(EDITOR, serviceId, 'section-1', {
      id: 'item-2',
      kind: 'custom-slide',
      title: 'Announcements',
      enabled: true,
      content: undefined,
    });
    await preparationOn(db, { now: () => '2026-09-20T09:45:00.000Z' }).prepare(PREPARER, serviceId, INPUTS);
    // Only the run's own manifest is dropped. A newer one for the same Service is still there, and is not
    // an answer to what this run is pinned to: a refusal is right where a substitute would be a lie.
    db.rows.set(SNAPSHOTS, rows(db, SNAPSHOTS).slice(1));

    expect((await refused(store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING }))).kind).toBe(
      'state',
    );
  });

  it('refuses when no manifest is left at all', async () => {
    const { db, store, runId } = await live();
    db.rows.set(SNAPSHOTS, []);

    expect((await refused(store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING }))).kind).toBe(
      'state',
    );
  });

  it('refuses a second addition claiming an identifier a row already holds, and writes nothing new', async () => {
    const { db, store, runId } = await live();
    await store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING });

    // The same pinned `newId`, so the second addition claims the identifier the first one was written under.
    const error = await refused(store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 24', body: SONG }));

    expect(error.kind).toBe('conflict');
    expect(rows(db, ADDITIONS)).toHaveLength(1);
    expect(rows(db, RECORDS.contentRevisions.collection)).toHaveLength(1);
  });

  it('refuses one of two Operators adding to the same run at the same moment, under its own name', async () => {
    const { db, runId, runs, runEvents } = await live();
    let minted = 0;
    const store = midServiceOn(db, { now: () => ADDED_AT, newId: () => `${CONTENT_ID}-${(minted += 1)}`, runs, runEvents });

    const outcomes = await Promise.allSettled([
      store.add(SESSION, { runId, kind: 'reading', title: 'Psalm 23', body: READING }),
      store.add(SESSION, { runId, kind: 'song', title: 'Amazing Grace', body: SONG }),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(MidServiceError);
    if (rejected?.status === 'rejected') expect((rejected.reason as MidServiceError).kind).toBe('conflict');
    expect(rows(db, RECORDS.runEvents.collection)).toHaveLength(1);
    // The loser leaves no provenance: a row saying an addition joined this run would be saying something
    // that never happened, and no record class here can be taken back. What it does leave is the body it
    // saved under the identifier it minted — a body nothing points at, which claims nothing.
    expect(rows(db, ADDITIONS)).toHaveLength(1);
    expect(rows(db, RECORDS.contentRevisions.collection)).toHaveLength(2);
    const winner = fulfilled[0] as PromiseFulfilledResult<MidServiceOutcome>;
    expect(await store.additions(READER, runId)).toEqual([winner.value.addition]);
  });
});

describe('what this store declares', () => {
  it('is named after the record class it owns, and the one index a run’s additions are read by', () => {
    expect(MID_SERVICE_PERMISSIONS).toEqual({ read: 'midServiceAdditions.read', append: 'midServiceAdditions.append' });
    expect(MID_SERVICE_INDEXES.map((index) => index.name)).toEqual(['mid_service_addition_run']);
  });
});
