import { describe, expect, it } from 'vitest';

import { RECORDS } from './records.js';
import { PRESENTATION_CONTROL, permissionsFor } from './roles.js';
import { RUN_ACTION, RUN_MODES, RUN_PHASES, RunError, runContext, runsOn } from './runs.js';
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

    expect(error.kind).toBe('state');
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
    const services = servicesOn(db, { now: () => new Date(START).toISOString(), newId: () => 'service-1' });
    const service = await services.create(EDITOR, DRAFT);
    await preparationOn(db, { now: () => new Date(START).toISOString() }).prepare(CONTEXT, service.stamp.id, INPUTS);
    const runs = runsOn(db, {
      now: () => new Date(START).toISOString(),
      newId: () => 'run-1',
      observe: () => ({ slideLayoutRevision: 3, checks: [] }),
    });
    await runs.start(OPERATOR_SESSION, { serviceId: service.stamp.id, mode: 'live' });

    const error = await refused(runs.start(OPERATOR_SESSION, { serviceId: service.stamp.id, mode: 'live' }));

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

  it('writes one audit entry naming the mode, under the reserved presentation.run action', async () => {
    const { db, runs, serviceId } = await prepared();

    await runs.start(OPERATOR_SESSION, { serviceId, mode: 'rehearsal' });

    const [entry] = rows(db, AUDIT).filter((row) => row['action'] === RUN_ACTION);
    expect(entry?.['actor']).toBe(OPERATOR);
    expect(entry?.['subject']).toBe(`service:${serviceId}`);
    expect(entry?.['outcome']).toBe('allowed');
    expect(String(entry?.['detail'])).toContain('rehearsal');
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
