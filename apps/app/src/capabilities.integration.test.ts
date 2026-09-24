// The capability store against a real MongoDB, because the promises it makes are the database's: an
// identifier this store was given is nowhere in what the database keeps, a capability is gone the moment
// it is revoked, and it shares no row with a session even though both live in the same database.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import {
  CAPABILITIES_COLLECTION,
  CAPABILITY_INDEXES,
  capabilitiesOn,
  capabilityContext,
  capabilityDb,
  createCapabilityIndexOn,
  tokenDigest,
} from './capabilities.js';
import { SESSIONS_COLLECTION, sessionContext, sessionDb, sessionsOn } from './sessions.js';
import { startTestMongo } from '../test/helpers/mongo.js';

import type { Db } from 'mongodb';
import type { CapabilityDb, CapabilityStore } from './capabilities.js';
import type { TestMongo } from '../test/helpers/mongo.js';

const START = Date.parse('2026-09-13T09:30:00.000Z');
const OPERATOR = 'account:7f3a';
const SERVICE = 'service:9b12';

const GATEKEEPER = capabilityContext('req-0f9c2a41');

interface StoredCapability {
  _id: string;
  kind: string;
  service: string;
  view: string;
  expiresAt: string;
  expiresOn?: Date;
  issuedBy: string;
}

let mongo: TestMongo;
let live: Db;
let db: CapabilityDb;
let store: CapabilityStore;
let clock: number;

const soon = (): string => new Date(clock + 60_000).toISOString();

const capabilities = () => live.collection<StoredCapability>(CAPABILITIES_COLLECTION);

beforeAll(async () => {
  mongo = await startTestMongo();
  live = mongo.db;
  db = capabilityDb(live);
}, 120_000);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await live.dropDatabase();
  clock = START;
  store = capabilitiesOn(db, { now: () => new Date(clock).toISOString() });
});

describe('a capability in a real database', () => {
  test('is issued, redeemed and revoked, and is only ever addressed by a digest', async () => {
    const expiresAt = soon();
    const issued = await store.issue(GATEKEEPER, OPERATOR, {
      kind: 'guest',
      service: SERVICE,
      view: 'audience',
      expiresAt,
    });

    const stored = await capabilities().findOne({ _id: issued.capabilityId });
    expect(stored?._id).toBe(tokenDigest(issued.token));
    // Everything the database holds, as text: the token itself is not in it.
    expect(JSON.stringify(stored)).not.toContain(issued.token);
    expect(stored?.expiresOn).toBeInstanceOf(Date);

    await expect(store.redeem(GATEKEEPER, issued.token, { service: SERVICE, view: 'audience' })).resolves.toEqual({
      kind: 'guest',
      service: SERVICE,
      view: 'audience',
      expiresAt,
    });

    await store.revoke(GATEKEEPER, issued.capabilityId);
    expect(await capabilities().countDocuments({})).toBe(0);
    await expect(store.redeem(GATEKEEPER, issued.token, { service: SERVICE, view: 'audience' })).rejects.toMatchObject({
      kind: 'unknown',
    });
  });

  test('the database is what forgets an expired capability, on an index it accepts as declared', async () => {
    await createCapabilityIndexOn(db, CAPABILITY_INDEXES[0] as (typeof CAPABILITY_INDEXES)[number]);
    const built = await capabilities().listIndexes().toArray();
    expect(built.find((index) => index.name === 'capability_expiry')).toMatchObject({
      key: { expiresOn: 1 },
      expireAfterSeconds: 0,
    });
  });

  test('shares no row with a session, even for a token that happens to collide as text', async () => {
    const sessions = sessionsOn(sessionDb(live), { now: () => new Date(clock).toISOString() });
    const session = await sessions.start(sessionContext('req-shared'), { actor: OPERATOR, permissions: [] });

    // The session's own token, presented to the capability store as though it were a capability's: found
    // in neither collection under the other's name, because `redeem` never looks anywhere but its own.
    await expect(
      store.redeem(GATEKEEPER, session.token, { service: SERVICE, view: 'audience' }),
    ).rejects.toMatchObject({ kind: 'unknown' });

    const namesInUse = await live.listCollections().toArray();
    expect(namesInUse.map((entry) => entry.name)).toEqual(expect.arrayContaining([SESSIONS_COLLECTION]));
    expect(await capabilities().countDocuments({})).toBe(0);
  });
});
