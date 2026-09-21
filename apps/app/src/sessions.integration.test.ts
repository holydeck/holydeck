// The session store against a real MongoDB, because the promises it makes are the database's: one ticket
// opens one socket however many sockets ask at once, a session that is over is forgotten by the database
// rather than by this process, and an identifier this store was given is nowhere in what the database keeps.

import { SESSION_IDLE_MINUTES, isOpaqueToken } from '@holydeck/contracts/sessions';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import {
  SESSION_INDEXES,
  SESSIONS_COLLECTION,
  SessionError,
  createSessionIndexOn,
  sessionContext,
  sessionDb,
  sessionsOn,
  tokenDigest,
} from './sessions.js';
import { startTestMongo } from '../test/helpers/mongo.js';

import type { Db } from 'mongodb';
import type { SessionDb, SessionStore } from './sessions.js';
import type { TestMongo } from '../test/helpers/mongo.js';

const START = Date.parse('2026-09-13T09:30:00.000Z');
const ACTOR = 'account:7f3a';
const MINUTE = 60_000;

const GATEKEEPER = sessionContext('req-0f9c2a41');

interface StoredSlot {
  slotId: string;
  actor: string;
  csrf: string;
}

interface StoredSession {
  _id: string;
  active?: string;
  slots?: readonly StoredSlot[];
  expiresOn?: Date;
  tickets?: readonly { hash: string; expiresAt: string; slotId: string }[];
}

let mongo: TestMongo;
let live: Db;
let db: SessionDb;
let store: SessionStore;
let clock: number;

const sessions = () => live.collection<StoredSession>(SESSIONS_COLLECTION);

beforeAll(async () => {
  mongo = await startTestMongo();
  live = mongo.db;
  db = sessionDb(live);
}, 120_000);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await live.dropDatabase();
  clock = START;
  store = sessionsOn(db, { now: () => new Date(clock).toISOString() });
});

describe('a session in a real database', () => {
  test('is started, read, rotated and ended, and is only ever addressed by a digest', async () => {
    const first = await store.start(GATEKEEPER, { actor: ACTOR, permissions: ['services.read'] });
    expect(isOpaqueToken(first.token)).toBe(true);

    const stored = await sessions().findOne({ _id: tokenDigest(first.token) });
    expect(stored?.slots?.[0]?.actor).toBe(ACTOR);
    // Everything the database holds, as text: the identifier is not in it, and the digest is.
    expect(JSON.stringify(stored)).not.toContain(first.token);
    expect(stored?.expiresOn).toBeInstanceOf(Date);

    clock = START + MINUTE;
    await expect(store.read(GATEKEEPER, first.token)).resolves.toMatchObject({ lastSeenAt: '2026-09-13T09:31:00.000Z' });

    const second = await store.rotate(GATEKEEPER, first.token, { rotation: 'privilege-change', permissions: [] });
    expect(await sessions().countDocuments({})).toBe(1);
    await expect(store.read(GATEKEEPER, first.token)).rejects.toThrow(SessionError);
    await expect(store.read(GATEKEEPER, second.token)).resolves.toMatchObject({ rotation: 'privilege-change' });

    await expect(store.revoke(GATEKEEPER, second.token)).resolves.toBe(true);
    expect(await sessions().countDocuments({})).toBe(0);
  });

  test('a session that is over is removed by the read that found it over', async () => {
    const session = await store.start(GATEKEEPER, { actor: ACTOR, permissions: ['services.read'] });
    clock = START + (SESSION_IDLE_MINUTES + 1) * MINUTE;
    await expect(store.read(GATEKEEPER, session.token)).rejects.toThrow(/is over/u);
    expect(await sessions().countDocuments({})).toBe(0);
  });

  test('recovering a credential ends every container that actor holds a slot in, in one query the index serves', async () => {
    await createSessionIndexOn(db, SESSION_INDEXES[0] as (typeof SESSION_INDEXES)[number]);
    await store.start(GATEKEEPER, { actor: ACTOR, permissions: ['services.read'] });
    await store.start(GATEKEEPER, { actor: ACTOR, permissions: ['services.read'] });
    const other = await store.start(GATEKEEPER, { actor: 'account:9b12', permissions: ['services.read'] });

    await expect(store.revokeAllFor(GATEKEEPER, ACTOR)).resolves.toBe(2);
    const left = await sessions().find({}).toArray();
    expect(left.map((row) => row.slots?.[0]?.actor)).toEqual(['account:9b12']);
    await expect(store.read(GATEKEEPER, other.token)).resolves.toMatchObject({ actor: 'account:9b12' });
  });

  test('recovering a credential pulls only that actor’s own slot, leaving a sibling in the same container', async () => {
    await createSessionIndexOn(db, SESSION_INDEXES[0] as (typeof SESSION_INDEXES)[number]);
    const first = await store.start(GATEKEEPER, { actor: ACTOR, permissions: ['services.read'] });
    const joined = await store.start(GATEKEEPER, { actor: 'account:9b12', permissions: ['services.read'] }, first.token);
    expect(joined.token).not.toBe(first.token);
    await expect(store.read(GATEKEEPER, first.token)).rejects.toMatchObject({ kind: 'unknown' });

    await expect(store.revokeAllFor(GATEKEEPER, ACTOR)).resolves.toBe(1);
    const left = await sessions().find({}).toArray();
    expect(left).toHaveLength(1);
    expect(left[0]?.slots?.map((slot) => slot.actor)).toEqual(['account:9b12']);
    await expect(store.read(GATEKEEPER, joined.token)).resolves.toMatchObject({ actor: 'account:9b12' });
  });

  // The point of the ticket: a browser cannot put a header on a handshake, so what proves the handshake is
  // a value that is worth nothing the second time it is used. Nothing above the database can promise that.
  test('one ticket opens one socket, however many handshakes arrive at once', async () => {
    const session = await store.start(GATEKEEPER, { actor: ACTOR, permissions: ['services.read'] });
    const ticket = await store.issueTicket(GATEKEEPER, session.token);

    const attempts = await Promise.all(
      Array.from({ length: 8 }, async () =>
        store.redeemTicket(GATEKEEPER, session.token, ticket).then(
          () => 'opened',
          () => 'refused',
        ),
      ),
    );
    expect(attempts.filter((outcome) => outcome === 'opened')).toHaveLength(1);

    const [stored] = await sessions().find({}).toArray();
    expect(stored?.tickets).toEqual([]);
  });

  test('the database is what forgets an expired session, on an index it accepts as declared', async () => {
    const expiry = SESSION_INDEXES.find((index) => index.name === 'session_expiry');
    await createSessionIndexOn(db, expiry as (typeof SESSION_INDEXES)[number]);
    const built = await sessions().listIndexes().toArray();
    expect(built.find((index) => index.name === 'session_expiry')).toMatchObject({
      key: { expiresOn: 1 },
      expireAfterSeconds: 0,
    });
  });
});
