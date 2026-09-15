// The audit trail against a real MongoDB: append-only is the database's own rule here, not merely this
// layer's. Invariant 13 — retention cleanup of one record class never reaches another's protected records
// — rests on two facts proved elsewhere: no repository exposes update or delete (repositories.test.ts),
// and the privileges below are the only ones this product's database user ever holds on this collection.
// What this file proves is the second fact: those privileges cannot change, replace, remove or drop a
// record once it is written, whatever the code above them intends.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { auditContext, auditOn } from './audit.js';
import { requestContext } from './context.js';
import { RECORDS, permissionsFor, privilegesFor } from './records.js';
import { repositoriesOn, repositoryDb } from './repositories.js';
import { startRestrictedMongo, startTestMongo } from '../test/helpers/mongo.js';

import type { AuditTrail } from './audit.js';
import type { RepositoryDb } from './repositories.js';
import type { RestrictedMongo, TestMongo } from '../test/helpers/mongo.js';

const COLLECTION = RECORDS.auditEvents.collection;
const PRIVILEGES = privilegesFor('auditEvents');
const START = Date.parse('2026-09-13T09:30:00.000Z');
const CORRELATION = 'req-0f9c2a41';

interface StoredEntry {
  _id: string;
  actor?: string;
  correlationId?: string;
  at?: string;
  action?: string;
  subject?: string;
  outcome?: string;
  detail?: string;
}

const clock = (): (() => string) => {
  let tick = 0;
  return () => new Date(START + tick++ * 1000).toISOString();
};

const ids = (): (() => string) => {
  let tick = 0;
  return () => `audit-${tick++}`;
};

const READER = requestContext({
  actor: 'system',
  permissions: [permissionsFor('auditEvents').read],
  correlationId: CORRELATION,
});

let mongo: TestMongo;
let db: RepositoryDb;
let trail: AuditTrail;

beforeAll(async () => {
  mongo = await startTestMongo();
  db = repositoryDb(mongo.db);
  trail = auditOn(db, { now: clock(), newId: ids() });
});

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await mongo.db.collection(COLLECTION).deleteMany({});
});

describe('the trail in a real database', () => {
  it('appends entries and reads them back in the order they were written', async () => {
    await trail.record(auditContext('account:7f3a', CORRELATION), {
      action: 'session.signIn',
      subject: 'lucia',
      outcome: 'allowed',
    });
    await trail.record(auditContext('system', CORRELATION), {
      action: 'authorization.refuse',
      subject: 'PATCH /api/v1/admin-only',
      outcome: 'refused',
      detail: 'this session may not accounts.manage',
    });

    const read = await repositoriesOn(db).auditEvents.read(READER, {}, { sort: { at: 1 } });
    expect(read.map((entry) => entry['action'])).toEqual(['session.signIn', 'authorization.refuse']);
    expect(read[0]).toMatchObject({ actor: 'account:7f3a', subject: 'lucia', outcome: 'allowed' });
    expect(read[1]).toMatchObject({ detail: 'this session may not accounts.manage' });
  });
});

describe('what the database lets this product do to audit history', () => {
  let restricted: RestrictedMongo;
  let store: AuditTrail;
  let protectedId: string;

  beforeAll(async () => {
    restricted = await startRestrictedMongo(PRIVILEGES);
    const limited = repositoryDb(restricted.db);
    store = auditOn(limited, { now: clock(), newId: ids() });
    protectedId = await store.record(auditContext('account:7f3a', CORRELATION), {
      action: 'session.signIn',
      subject: 'lucia',
      outcome: 'allowed',
    });
  });

  afterAll(async () => {
    await restricted.stop();
  });

  it('appends with the privileges the record class declares, and needs no more', async () => {
    const id = await store.record(auditContext('account:7f3a', CORRELATION), {
      action: 'session.signIn',
      subject: 'lucia',
      outcome: 'refused',
    });
    expect(id).toBeTruthy();
  });

  it('cannot change, replace, remove or drop an entry, because the database refuses the product rather than the code', async () => {
    const collection = restricted.db.collection<StoredEntry>(COLLECTION);
    const filter = { _id: protectedId };
    const attempts = {
      update: () => collection.updateOne(filter, { $set: { outcome: 'refused' } }),
      replace: () => collection.replaceOne(filter, { action: 'session.signIn' }),
      remove: () => collection.deleteOne(filter),
      drop: () => collection.drop(),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      await expect(attempt(), name).rejects.toThrow(/not authorized/u);
    }
    const [stored] = await restricted.root.collection<StoredEntry>(COLLECTION).find(filter).toArray();
    expect(stored?.outcome).toBe('allowed');
  });
});
