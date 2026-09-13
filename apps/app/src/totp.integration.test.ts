// The second factor store against a real MongoDB, because what matters here is atomicity the in-memory
// fake cannot prove: the same conditional write MongoDB runs under a replayed code, the duplicate key a
// proved credential refuses a second enrolment with, and the $pull that spends a recovery code once.

import { RECOVERY_CODE_COUNT } from '@holydeck/contracts/totp';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { recoveryDigest } from './otp.js';
import { TOTP_COLLECTION, TOTP_INDEXES, createTotpIndexOn, totpContext, totpDb, totpsOn } from './totp.js';
import { authenticatorCode } from '../test/helpers/authenticator.js';
import { startTestMongo } from '../test/helpers/mongo.js';

import type { Db } from 'mongodb';
import type { TotpDb, TotpStore } from './totp.js';
import type { TestMongo } from '../test/helpers/mongo.js';

const START = Date.parse('2026-09-13T09:30:00.000Z');
const ACCOUNT = '7f3aQmVhdGl0dWRlc19hcmU';
const GATEKEEPER = totpContext('req-0f9c2a41');

interface StoredCredential {
  _id: string;
  status?: string;
  secret?: string;
  recovery?: readonly string[];
}

let mongo: TestMongo;
let live: Db;
let db: TotpDb;
let store: TotpStore;
let clock: number;

const credentials = () => live.collection<StoredCredential>(TOTP_COLLECTION);

const secretOf = async (): Promise<string> => String((await credentials().findOne({ _id: ACCOUNT }))?.secret);

const declareIndexes = async (): Promise<void> => {
  for (const index of TOTP_INDEXES) await createTotpIndexOn(db, index);
};

const enrolled = async (): Promise<readonly string[]> => {
  await store.enroll(GATEKEEPER, ACCOUNT);
  const codes = await store.verify(GATEKEEPER, ACCOUNT, authenticatorCode(await secretOf(), clock));
  if (codes === undefined) throw new Error('the enrolment was not proved');
  return codes;
};

beforeAll(async () => {
  mongo = await startTestMongo();
  live = mongo.db;
  db = totpDb(live);
}, 120_000);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await live.dropDatabase();
  clock = START;
  store = totpsOn(db, { now: () => new Date(clock).toISOString() });
});

describe('a second factor in a real database', () => {
  test('enrolling writes a pending row, and the declared expiry index builds and is listed', async () => {
    await declareIndexes();
    await store.enroll(GATEKEEPER, ACCOUNT);

    expect((await credentials().findOne({ _id: ACCOUNT }))?.status).toBe('pending');
    const built = await credentials().listIndexes().toArray();
    expect(built.find((index) => index.name === 'totp_pending_expiry')).toMatchObject({
      key: { pendingUntil: 1 },
      expireAfterSeconds: 0,
    });
  });

  test('a code from an independent authenticator proves the enrolment, and the row keeps digests, never codes', async () => {
    const codes = await enrolled();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);

    const stored = await credentials().findOne({ _id: ACCOUNT });
    expect(stored?.status).toBe('active');
    expect(stored?.recovery).toEqual(codes.map(recoveryDigest));
    for (const code of codes) expect(JSON.stringify(stored)).not.toContain(code);
  });

  test('refuses a code once it has already proved that step, which is the write mongod runs to spend one', async () => {
    await enrolled();
    clock += 30_000;
    const code = authenticatorCode(await secretOf(), clock);
    await expect(store.satisfied(GATEKEEPER, ACCOUNT, code)).resolves.toBe('accepted');
    await expect(store.satisfied(GATEKEEPER, ACCOUNT, code)).resolves.toBe('refused');
  });

  test('spends a recovery code exactly once, pulled from the set the real driver holds', async () => {
    const [first] = await enrolled();
    await expect(store.satisfied(GATEKEEPER, ACCOUNT, first ?? '')).resolves.toBe('accepted');
    expect((await credentials().findOne({ _id: ACCOUNT }))?.recovery).toHaveLength(RECOVERY_CODE_COUNT - 1);
    await expect(store.satisfied(GATEKEEPER, ACCOUNT, first ?? '')).resolves.toBe('refused');
  });

  test('refuses a second enrolment over a proved credential by the duplicate key, not a read of its own', async () => {
    await enrolled();
    const refused = await store.enroll(GATEKEEPER, ACCOUNT).catch((error: unknown) => error);
    expect(refused).toMatchObject({ name: 'TotpError', kind: 'duplicate' });
    expect(await credentials().countDocuments({})).toBe(1);
  });

  test('removes the credential when revoked, and answers false the second time', async () => {
    await enrolled();
    await expect(store.revoke(GATEKEEPER, ACCOUNT)).resolves.toBe(true);
    expect(await credentials().countDocuments({})).toBe(0);
    await expect(store.revoke(GATEKEEPER, ACCOUNT)).resolves.toBe(false);
  });
});
