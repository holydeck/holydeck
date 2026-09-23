import { describe, expect, it } from 'vitest';

import { RECORDS } from './records.js';
import { PRESENTATION_CONTROL, permissionsFor } from './roles.js';
import { RUN_MODES, RUN_PHASES, RunError, runContext, runsOn } from './runs.js';
import { preparationContext, preparationOn } from './snapshots.js';
import { serviceContext, servicesOn } from './services.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import type { ServiceDraft, ServiceSection } from '@holydeck/contracts/services';

import type { Document } from './repositories.js';
import type { RunStore } from './runs.js';
import type { OperatorSession, PreparationInputs, ReadinessObservation } from './snapshots.js';
import type { ServiceStore } from './services.js';
import type { FakeDb } from '../test/helpers/fake-db.js';

const START = Date.parse('2026-09-13T09:30:00.000Z');
const OPERATOR = `account:${'D'.repeat(22)}`;
const CORRELATION = 'req-7b21c0ae';
const CONTEXT = preparationContext(OPERATOR, CORRELATION);
const EDITOR = serviceContext(OPERATOR, CORRELATION);
const RUNS = RECORDS.presentationRuns.collection;
const AUDIT = RECORDS.auditEvents.collection;
const RUN_EVENTS = RECORDS.runEvents.collection;

const SECTIONS: readonly ServiceSection[] = [
  { id: 'section-1', name: 'Worship', items: [{ id: 'item-1', kind: 'custom-slide', title: 'Welcome', enabled: true, content: undefined }] },
];
const DRAFT: ServiceDraft = { title: 'Sunday Morning', date: '2026-09-13', site: 'Main Hall', sections: SECTIONS };

// The Slide Layout pinned at revision 3 — the same Outdated INPUTS pins in `snapshots.test.ts`, reused
// here so `prepared({ slideLayoutRevision: 4 })` reports Outdated exactly the way it does there.
const INPUTS: PreparationInputs = {
  slideLayout: { id: 'layout-1', revision: 3 },
  serviceTemplate: 'template-1@2',
  settings: 'settings@41',
  media: 'media@2026-09-12',
  corpus: 'corpus@2026-08-01',
  aspectRatio: '16:9',
};

const accountOf = (role: AccountRecord['role'], granted: Partial<AccountRecord> = {}): AccountRecord => ({
  id: 'A'.repeat(22),
  name: 'lucia',
  displayName: 'Lucia Brandt',
  role,
  createdAt: '2026-09-13T09:30:00.000Z',
  controlPresentation: false,
  disabled: false,
  ...granted,
});

const sessionOf = (account: AccountRecord): OperatorSession => ({
  actor: OPERATOR,
  permissions: permissionsFor(account),
  correlationId: CORRELATION,
});

const OPERATOR_SESSION = sessionOf(accountOf('member', { controlPresentation: true }));
const READ_CONTEXT = runContext(OPERATOR, CORRELATION);

interface Harness {
  readonly db: FakeDb;
  readonly services: ServiceStore;
  readonly runs: RunStore;
}

const harness = (observed: ReadinessObservation): Harness => {
  const db = fakeDb();
  let tick = 0;
  let serial = 0;
  const now = (): string => new Date(START + (tick += 1) * 1000 - 1000).toISOString();
  return {
    db,
    services: servicesOn(db, { now, newId: () => `service-${(serial += 1)}` }),
    runs: runsOn(db, { now, newId: () => `run-${(serial += 1)}`, observe: () => observed }),
  };
};

// Ready by default: the pinned Slide Layout observed at the same revision INPUTS pins it at, and nothing
// blocking. A caller narrows either field to drive readiness Outdated or Blocked instead.
const prepared = async (
  observed?: Partial<ReadinessObservation>,
): Promise<Harness & { readonly serviceId: string }> => {
  const built = harness({ slideLayoutRevision: 3, checks: [], ...observed });
  const service = await built.services.create(EDITOR, DRAFT);
  await preparationOn(built.db, { now: () => new Date(START).toISOString() }).prepare(CONTEXT, service.stamp.id, INPUTS);
  return { ...built, serviceId: service.stamp.id };
};

const rows = (db: FakeDb, collection: string): Document[] => db.rows.get(collection) ?? [];
const auditActions = (db: FakeDb): unknown[] => rows(db, AUDIT).map((row) => row['action']);
const runEventKinds = (db: FakeDb, runId: string): unknown[] =>
  rows(db, RUN_EVENTS)
    .filter((row) => row['runId'] === runId)
    .map((row) => row['kind']);

const refused = async (call: Promise<unknown>): Promise<RunError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof RunError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('starting a run', () => {
  it('starts only from a Ready prepared snapshot', async () => {
    const { runs, serviceId } = await prepared();

    const record = await runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' });

    expect(record.phase).toBe('active');
    expect(record.mode).toBe('live');
    expect(record.position).toBe(0);
    expect(RUN_MODES).toContain(record.mode);
    expect(RUN_PHASES).toContain(record.phase);
  });

  it('rejects starting from an Outdated snapshot with a named error', async () => {
    // slideLayoutRevision 4 against the manifest's pinned revision 3 — the same Outdated INPUTS pins in
    // `snapshots.test.ts`, reused here through the shared fixture.
    const { db, runs, serviceId } = await prepared({ slideLayoutRevision: 4 });

    const error = await refused(runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' }));

    expect(error.kind).toBe('outdated');
    expect(error.message).toContain('outdated');
    expect(rows(db, RUNS)).toHaveLength(0);
  });

  it('rejects starting when nothing is prepared yet', async () => {
    const db = fakeDb();
    const services = servicesOn(db, { now: () => new Date(START).toISOString(), newId: () => 'service-1' });
    const runs = runsOn(db, { now: () => new Date(START).toISOString(), newId: () => 'run-1' });
    const service = await services.create(EDITOR, DRAFT);

    const error = await refused(runs.start(OPERATOR_SESSION, { serviceId: service.stamp.id, mode: 'live' }));

    expect(error.kind).toBe('state');
  });

  it('refuses starting under an id another run already claimed, and writes nothing new', async () => {
    const db = fakeDb();
    let serviceSerial = 0;
    const services = servicesOn(db, { now: () => new Date(START).toISOString(), newId: () => `service-${(serviceSerial += 1)}` });
    const service = await services.create(EDITOR, DRAFT);
    await preparationOn(db, { now: () => new Date(START).toISOString() }).prepare(CONTEXT, service.stamp.id, INPUTS);
    const runs = runsOn(db, {
      now: () => new Date(START).toISOString(),
      newId: () => 'run-1',
      observe: () => ({ slideLayoutRevision: 3, checks: [] }),
    });
    await runs.start(OPERATOR_SESSION, { serviceId: service.stamp.id, mode: 'live' });

    // A different service, still active, so the service-level "already active" refusal never intercepts
    // this before the runId collision this test means to exercise gets a chance to fire — the fixed
    // `newId` above claims the same runId regardless of which service asks for one.
    const serviceB = await services.create(EDITOR, DRAFT);
    await preparationOn(db, { now: () => new Date(START).toISOString() }).prepare(CONTEXT, serviceB.stamp.id, INPUTS);
    const error = await refused(runs.start(OPERATOR_SESSION, { serviceId: serviceB.stamp.id, mode: 'live' }));

    expect(error.kind).toBe('conflict');
    expect(rows(db, RUNS)).toHaveLength(1);
  });

  it('rejects a blocked snapshot the same way, with the state named', async () => {
    const { runs, serviceId } = await prepared({ checks: [{ name: 'Media: missing', group: 'Media', severity: 'blocker', cause: 'missing file' }] });

    const error = await refused(runs.start(OPERATOR_SESSION, { serviceId, mode: 'rehearsal' }));

    expect(error.kind).toBe('state');
    expect(error.message).toContain('blocked');
  });

  // THR-11: refused by the server, not by a client declining to draw the control.
  it('refuses every session without Control presentation', async () => {
    const { runs, serviceId } = await prepared();
    const sessions: readonly OperatorSession[] = [
      sessionOf(accountOf('admin')),
      sessionOf(accountOf('editor')),
      sessionOf(accountOf('member')),
      { actor: 'guest:invited', permissions: [], correlationId: CORRELATION },
    ];

    for (const session of sessions) {
      const error = await refused(runs.start(session, { serviceId, mode: 'live' }));
      expect(error.kind).toBe('permission');
      expect(error.message).toContain(PRESENTATION_CONTROL);
    }
  });

  it('writes one audit entry naming the mode, under the run.start action', async () => {
    const { db, runs, serviceId } = await prepared();

    await runs.start(OPERATOR_SESSION, { serviceId, mode: 'rehearsal' });

    const [entry] = rows(db, AUDIT).filter((row) => row['action'] === 'run.start');
    expect(entry?.['actor']).toBe(OPERATOR);
    expect(entry?.['subject']).toBe(`service:${serviceId}`);
    expect(entry?.['outcome']).toBe('allowed');
    expect(String(entry?.['detail'])).toContain('rehearsal');
  });
});

describe('going live over an open blocker', () => {
  const BLOCKED: Partial<ReadinessObservation> = {
    checks: [{ name: 'Content', group: 'Content', severity: 'blocker', cause: 'nothing enabled' }],
  };

  it('refuses a live start with a blocked checklist and no override, unchanged', async () => {
    const { runs, serviceId } = await prepared(BLOCKED);

    const error = await refused(runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' }));

    expect(error.kind).toBe('state');
  });

  it('refuses an override on a rehearsal start even when blocked', async () => {
    const { runs, serviceId } = await prepared(BLOCKED);

    const error = await refused(runs.start(OPERATOR_SESSION, { serviceId, mode: 'rehearsal', override: { reason: 'x' } }));

    expect(error.kind).toBe('state');
  });

  it('starts live over a blocked checklist when a valid override reason is given, and records the override under the minted runId', async () => {
    const { runs, db, serviceId } = await prepared(BLOCKED);

    const started = await runs.start(OPERATOR_SESSION, {
      serviceId,
      mode: 'live',
      override: { reason: 'Choir already assembled' },
    });

    expect(started.runId).toBeDefined();
    expect(runEventKinds(db, started.runId)).toContain('readiness.override');
  });

  it('refuses an override when the checklist is outdated, even with a reason', async () => {
    const { runs, serviceId } = await prepared({ slideLayoutRevision: 4 });

    const error = await refused(runs.start(OPERATOR_SESSION, { serviceId, mode: 'live', override: { reason: 'x' } }));

    expect(error.kind).toBe('outdated');
  });

  it('refuses an override offered when nothing is blocked', async () => {
    const { runs, serviceId } = await prepared();

    const error = await refused(runs.start(OPERATOR_SESSION, { serviceId, mode: 'live', override: { reason: 'unneeded' } }));

    expect(error.kind).toBe('state');
    expect(error.message).toContain('none is');
  });

  it('writes the run row only after the override resolves, auditing both under the Service', async () => {
    const { runs, db, serviceId } = await prepared(BLOCKED);

    await runs.start(OPERATOR_SESSION, { serviceId, mode: 'live', override: { reason: 'Choir already assembled' } });

    expect(auditActions(db)).toEqual(expect.arrayContaining(['readiness.override', 'run.start']));
  });

  it('refuses every session without Control presentation, before the override is even attempted', async () => {
    const { runs, db, serviceId } = await prepared(BLOCKED);

    const error = await refused(
      runs.start(sessionOf(accountOf('editor')), { serviceId, mode: 'live', override: { reason: 'x' } }),
    );

    expect(error.kind).toBe('permission');
    expect(rows(db, RUN_EVENTS)).toHaveLength(0);
  });
});

describe('authoritative live state', () => {
  it('seeds a fresh run with an initial LiveState and stateRevision 0', async () => {
    const { runs, serviceId } = await prepared();

    const started = await runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' });

    expect(started.stateRevision).toBe(0);
    expect(started.live.mode).toBe('live');
  });

  it('advances the state and increments the revision on a matching expected revision', async () => {
    const { runs, serviceId } = await prepared();
    const started = await runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' });

    const next = { ...started.live, selected: { itemId: 'item-2', slideIndex: 0 } };
    const advanced = await runs.advance(READ_CONTEXT, started.runId, 0, next);

    expect(advanced).not.toBe('stale');
    if (advanced !== 'stale' && advanced !== undefined) expect(advanced.stateRevision).toBe(1);
  });

  it('reports stale on a revision that has already moved', async () => {
    const { runs, serviceId } = await prepared();
    const started = await runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' });

    await runs.advance(READ_CONTEXT, started.runId, 0, started.live);
    const result = await runs.advance(READ_CONTEXT, started.runId, 0, started.live);

    expect(result).toBe('stale');
  });

  it('audits run.start and run.end, not the retired presentation.run action', async () => {
    const { runs, db, serviceId } = await prepared();

    const started = await runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' });
    await runs.end(OPERATOR_SESSION, started.runId);

    expect(auditActions(db)).toEqual(expect.arrayContaining(['run.start', 'run.end']));
    expect(auditActions(db)).not.toContain('presentation.run');
  });

  it('answers nothing from advance for a run this code has never heard of', async () => {
    const { runs } = await prepared();

    expect(await runs.advance(READ_CONTEXT, 'run-missing', 0, {
      runId: 'run-missing',
      snapshotId: 'snap',
      mode: 'live',
      public: { itemId: 'item-1', slideIndex: 0 },
      selected: { itemId: 'item-1', slideIndex: 0 },
      themes: { audience: 'a', stage: 's', singer: 'g', operator: 'o' },
      additionsRevision: 0,
    })).toBeUndefined();
  });

  it('derives position and a default live state for a run row written before this field existed', async () => {
    const db = fakeDb();
    const runs = runsOn(db, { now: () => new Date(START).toISOString() });
    db.rows.set(RUNS, [{
      _id: 'run-legacy#1',
      runId: 'run-legacy',
      sequence: 1,
      at: new Date(START).toISOString(),
      actor: OPERATOR,
      correlationId: CORRELATION,
      serviceId: 's',
      snapshotId: 'snap',
      phase: 'active',
      mode: 'live',
      position: 3,
    }]);

    const resumed = await runs.resume(READ_CONTEXT, 'run-legacy');

    expect(resumed?.position).toBe(3);
    expect(resumed?.stateRevision).toBe(0);
    expect(resumed?.live.mode).toBe('live');
    expect(resumed?.live.public).toEqual({ itemId: '', slideIndex: 3 });
  });
});

describe('resuming a run', () => {
  it('survives an application restart: a fresh store instance over the same database reports the same position and mode', async () => {
    const { db, runs, serviceId } = await prepared();
    const started = await runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' });

    // A fresh `runsOn` closure stands in for a freshly booted process: nothing here was carried over in
    // memory, only what was written to `db` — the same database double, standing in for Mongo.
    const restarted = runsOn(db, { now: () => new Date(START).toISOString() });
    const resumed = await restarted.resume(READ_CONTEXT, started.runId);

    expect(resumed?.mode).toBe(started.mode);
    expect(resumed?.position).toBe(started.position);
    expect(resumed?.phase).toBe('active');
  });

  it('answers nothing for a run this code has never heard of', async () => {
    const { runs } = await prepared();

    expect(await runs.resume(READ_CONTEXT, 'run-missing')).toBeUndefined();
  });
});

describe('ending a run', () => {
  it('is explicit, and leaves the run history intact', async () => {
    const { db, runs, serviceId } = await prepared();
    const started = await runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' });

    const ended = await runs.end(OPERATOR_SESSION, started.runId);

    expect(ended?.phase).toBe('ended');
    expect(rows(db, RUNS)).toHaveLength(2);
    // The started row is still exactly what it was — appended beside, never rewritten.
    expect(rows(db, RUNS)[0]).toMatchObject({ runId: started.runId, sequence: 1, phase: 'active' });
    expect(rows(db, RUNS)[1]).toMatchObject({ runId: started.runId, sequence: 2, phase: 'ended' });
  });

  it('refuses ending an already-ended run rather than ending it twice', async () => {
    const { runs, serviceId } = await prepared();
    const started = await runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' });
    await runs.end(OPERATOR_SESSION, started.runId);

    const error = await refused(runs.end(OPERATOR_SESSION, started.runId));

    expect(error.kind).toBe('state');
  });

  it('answers nothing for a run this code has never heard of', async () => {
    const { runs } = await prepared();

    expect(await runs.end(OPERATOR_SESSION, 'run-missing')).toBeUndefined();
  });

  it('refuses every session without Control presentation', async () => {
    const { runs, serviceId } = await prepared();
    const started = await runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' });

    const error = await refused(runs.end(sessionOf(accountOf('editor')), started.runId));

    expect(error.kind).toBe('permission');
  });
});

describe('notifying a live session that a run’s phase moved', () => {
  it('is told once a run starts, and not before — a session it never reached would answer for it', async () => {
    const { db, serviceId } = await prepared();
    let notified = 0;
    const runs = runsOn(db, {
      now: () => new Date(START).toISOString(),
      observe: () => ({ slideLayoutRevision: 3, checks: [] }),
      onRunStateChange: () => (notified += 1),
    });

    await runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' });

    expect(notified).toBe(1);
  });

  it('is not told when starting was refused, since the phase never moved', async () => {
    // The same Outdated fixture `starting a run` above refuses with — reconstructed over the same
    // database with the hook wired, rather than reaching into `harness()`'s fixed `runsOn` options.
    const { db, serviceId } = await prepared({ slideLayoutRevision: 4 });
    let notified = 0;
    const runs = runsOn(db, {
      now: () => new Date(START).toISOString(),
      observe: () => ({ slideLayoutRevision: 4, checks: [] }),
      onRunStateChange: () => (notified += 1),
    });

    await refused(runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' }));

    expect(notified).toBe(0);
  });

  it('is told again, separately, once a run ends', async () => {
    const { db, serviceId } = await prepared();
    let notified = 0;
    const watched = runsOn(db, { now: () => new Date(START).toISOString(), onRunStateChange: () => (notified += 1) });
    const started = await watched.start(OPERATOR_SESSION, { serviceId, mode: 'live' });
    expect(notified).toBe(1);

    await watched.end(OPERATOR_SESSION, started.runId);

    expect(notified).toBe(2);
  });

  it('defaults to telling no one, for the run store built without anything listening', async () => {
    const { runs, serviceId } = await prepared();
    // No `onRunStateChange` supplied — proves the hook is optional and a run still starts and ends.
    const started = await runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' });
    await expect(runs.end(OPERATOR_SESSION, started.runId)).resolves.toMatchObject({ phase: 'ended' });
  });
});

describe('a Mongo interruption mid-run', () => {
  it('lets a write that failed for any other reason through as what it was, and leaves nothing behind', async () => {
    const { db, runs, serviceId } = await prepared();
    const started = await runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' });

    db.failOn = (collection) => (collection === RUNS ? new Error('the connection dropped mid-write') : undefined);
    await expect(runs.end(OPERATOR_SESSION, started.runId)).rejects.toThrow('the connection dropped mid-write');
    expect(rows(db, RUNS)).toHaveLength(1);

    db.failOn = undefined;
    const ended = await runs.end(OPERATOR_SESSION, started.runId);
    expect(ended?.phase).toBe('ended');
    expect(rows(db, RUNS)).toHaveLength(2);
  });

  it('refuses a run row this code cannot read back, rather than pinning a guess', async () => {
    const db = fakeDb();
    const runs = runsOn(db, { now: () => new Date(START).toISOString() });
    db.rows.set(RUNS, [{ _id: 'run-9#1', runId: 'run-9', sequence: 'first', at: new Date(START).toISOString(), serviceId: 's', snapshotId: 'snap', phase: 'active', mode: 'live', position: 0 }]);

    expect((await refused(runs.resume(READ_CONTEXT, 'run-9'))).kind).toBe('corrupt');
  });
});

describe('active runs', () => {
  it('keeps only the latest row per run before filtering active phases', async () => {
    const { db, services, runs, serviceId } = await prepared();
    // A different service, so both runs are legitimately active at once: a service is never started
    // twice, but two different services running concurrently is exactly what `active` must reduce over.
    const serviceB = await services.create(EDITOR, DRAFT);
    await preparationOn(db, { now: () => new Date(START).toISOString() }).prepare(CONTEXT, serviceB.stamp.id, INPUTS);

    const first = await runs.start(OPERATOR_SESSION, { serviceId, mode: 'live' });
    const second = await runs.start(OPERATOR_SESSION, { serviceId: serviceB.stamp.id, mode: 'rehearsal' });
    await runs.advance(READ_CONTEXT, second.runId, 0, { ...second.live, mode: 'paused' });
    await runs.end(OPERATOR_SESSION, first.runId);
    const active = await runs.active(READ_CONTEXT);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ runId: second.runId, stateRevision: 1, live: { mode: 'paused' } });
  });

  it('returns no active runs from an empty store', async () => {
    expect(await harness({}).runs.active(READ_CONTEXT)).toEqual([]);
  });
});
