import { RECOVERY_CODE_COUNT, TOTP_PERIOD_SECONDS } from '@holydeck/contracts/totp';
import { beforeEach, describe, expect, test } from 'vitest';

import { requestContext } from './context.js';
import { codeAt, recoveryDigest, stepAt } from './otp.js';
import {
  ENROLMENT_MINUTES,
  TOTP_ACTIONS,
  TOTP_COLLECTION,
  TOTP_INDEXES,
  TOTP_PERMISSIONS,
  TotpError,
  createTotpIndexOn,
  dropTotpIndexOn,
  totpContext,
  totpDb,
  totpPrivileges,
  totpsOn,
} from './totp.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Db } from 'mongodb';

import type { TotpStore } from './totp.js';

const ACCOUNT = '7f3aQmVhdGl0dWRlc19hcmU';
const CORRELATION = 'req-0f9c2a41';

let clock = Date.parse('2026-09-13T09:30:00.000Z');
let rows: Map<string, Record<string, unknown>>;
let names: string[];
let store: TotpStore;
let memory: ReturnType<typeof memoryTotp>;

const now = (): string => new Date(clock).toISOString();

const context = (): unknown => totpContext(CORRELATION);

const secretOf = (id = ACCOUNT): string => String(rows.get(id)?.['secret']);

const currentCode = (id = ACCOUNT): string => codeAt(secretOf(id), stepAt(now()));

const enrolled = async (): Promise<readonly string[]> => {
  await store.enroll(context(), ACCOUNT);
  const codes = await store.verify(context(), ACCOUNT, currentCode());
  if (codes === undefined) throw new Error('the enrolment was not proved');
  return codes;
};

beforeEach(() => {
  clock = Date.parse('2026-09-13T09:30:00.000Z');
  memory = memoryTotp();
  rows = memory.rows;
  names = memory.names;
  store = totpsOn(memory.db, { now });
});

describe('what the second factor store owns', () => {
  test('names the collection it owns, the permissions it is reached through, and the actions it needs', () => {
    expect(TOTP_COLLECTION).toBe('totp_credentials');
    expect(TOTP_PERMISSIONS).toEqual({ read: 'totp.read', write: 'totp.write' });
    expect(totpPrivileges()).toEqual({ collection: TOTP_COLLECTION, actions: TOTP_ACTIONS });
    expect(TOTP_ACTIONS).not.toContain('listCollections');
  });

  test('is reached under a context that is the product acting as itself, and under nothing else', async () => {
    await expect(store.enroll({}, ACCOUNT)).rejects.toMatchObject({ kind: 'context' });
    const readOnly = requestContext({
      actor: 'system',
      permissions: [TOTP_PERMISSIONS.read],
      correlationId: CORRELATION,
    });
    const refused = await store.enroll(readOnly, ACCOUNT).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TotpError);
    expect(refused).toMatchObject({ kind: 'permission' });
    expect(String(refused)).toContain(TOTP_PERMISSIONS.write);
  });

  test('is asked for one account, and an identifier no account has is refused before any write', async () => {
    await expect(store.enroll(context(), 'not an identifier')).rejects.toMatchObject({ kind: 'schema' });
    expect(rows.size).toBe(0);
  });

  test('touches its own collection and no other, so revoking cannot reach an account’s password', async () => {
    await enrolled();
    await store.revoke(context(), ACCOUNT);
    expect(new Set(names)).toEqual(new Set([TOTP_COLLECTION]));
  });
});

describe('enrolling a second factor', () => {
  test('draws a secret nobody chose, and keeps it pending until a code has proved it', async () => {
    const { secret } = await store.enroll(context(), ACCOUNT);
    expect(secret).toBe(secretOf());
    expect(rows.get(ACCOUNT)).toMatchObject({ status: 'pending' });
    expect(rows.get(ACCOUNT)?.['pendingUntil']).toEqual(new Date(clock + ENROLMENT_MINUTES * 60_000));
  });

  test('draws a different secret for every enrolment, and replaces one nothing depends on yet', async () => {
    const first = await store.enroll(context(), ACCOUNT);
    const second = await store.enroll(context(), ACCOUNT);
    expect(second.secret).not.toBe(first.secret);
    expect(rows.size).toBe(1);
  });

  test('is refused over a second factor that is already proved, and the database is what refuses it', async () => {
    await enrolled();
    const refused = await store.enroll(context(), ACCOUNT).catch((error: unknown) => error);
    expect(refused).toMatchObject({ kind: 'duplicate' });
    expect(rows.get(ACCOUNT)).toMatchObject({ status: 'active' });
  });

  test('is a defect when the database refused for any other reason, which is not a second factor’s answer', async () => {
    memory.beforeWrite = () => {
      throw new TypeError('the driver fell over');
    };
    await expect(store.enroll(context(), ACCOUNT)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('proving an enrolment', () => {
  test('makes it the account’s second factor, and answers with the codes that get the account back', async () => {
    const codes = await enrolled();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    const row = rows.get(ACCOUNT);
    expect(row).toMatchObject({ status: 'active' });
    expect(row?.['pendingUntil']).toBeUndefined();
    expect(row?.['recovery']).toEqual(codes.map(recoveryDigest));
    for (const code of codes) expect(JSON.stringify(row)).not.toContain(code);
  });

  test('answers with nothing for a code that is not the one, and leaves the enrolment pending', async () => {
    await store.enroll(context(), ACCOUNT);
    await expect(store.verify(context(), ACCOUNT, '000000')).resolves.toBeUndefined();
    expect(rows.get(ACCOUNT)).toMatchObject({ status: 'pending' });
  });

  test('is refused as a state when there is no enrolment to prove, which is not a wrong code', async () => {
    await expect(store.verify(context(), ACCOUNT, '000000')).rejects.toMatchObject({ kind: 'state' });
    await enrolled();
    await expect(store.verify(context(), ACCOUNT, currentCode())).rejects.toMatchObject({ kind: 'state' });
  });

  test('is refused once the enrolment is older than the window it was given, however long mongod waits', async () => {
    await store.enroll(context(), ACCOUNT);
    clock += (ENROLMENT_MINUTES + 1) * 60_000;
    await expect(store.verify(context(), ACCOUNT, currentCode())).rejects.toMatchObject({ kind: 'state' });
  });

  test('is refused when the enrolment went away between the code being read and being written', async () => {
    await store.enroll(context(), ACCOUNT);
    const code = currentCode();
    memory.beforeWrite = () => {
      rows.delete(ACCOUNT);
      memory.beforeWrite = undefined;
    };
    await expect(store.verify(context(), ACCOUNT, code)).rejects.toMatchObject({ kind: 'state' });
  });
});

describe('signing in with a second factor', () => {
  test('asks nothing of an account that enrolled none, and nothing of one that has not proved one', async () => {
    await expect(store.satisfied(context(), ACCOUNT, '')).resolves.toBe('none');
    await store.enroll(context(), ACCOUNT);
    await expect(store.satisfied(context(), ACCOUNT, '')).resolves.toBe('none');
  });

  test('is satisfied by the code for the step the account is at', async () => {
    await enrolled();
    clock += TOTP_PERIOD_SECONDS * 1000;
    await expect(store.satisfied(context(), ACCOUNT, currentCode())).resolves.toBe('accepted');
  });

  test('refuses the same code twice, which is the code somebody else read over a shoulder', async () => {
    await enrolled();
    clock += TOTP_PERIOD_SECONDS * 1000;
    const code = currentCode();
    await expect(store.satisfied(context(), ACCOUNT, code)).resolves.toBe('accepted');
    await expect(store.satisfied(context(), ACCOUNT, code)).resolves.toBe('refused');
  });

  test('refuses a code for a step already behind the one it last accepted', async () => {
    await enrolled();
    clock += 2 * TOTP_PERIOD_SECONDS * 1000;
    const kept = codeAt(secretOf(), stepAt(now()) - 1);
    await expect(store.satisfied(context(), ACCOUNT, currentCode())).resolves.toBe('accepted');
    await expect(store.satisfied(context(), ACCOUNT, kept)).resolves.toBe('refused');
  });

  test('refuses a code that is nobody’s, and says the same thing it says to a code that was used', async () => {
    await enrolled();
    await expect(store.satisfied(context(), ACCOUNT, '000000')).resolves.toBe('refused');
    await expect(store.satisfied(context(), ACCOUNT, 'NOTACODE00')).resolves.toBe('refused');
  });

  test('is satisfied by a recovery code exactly once, and the set is one shorter afterwards', async () => {
    const codes = await enrolled();
    const [first] = codes;
    await expect(store.satisfied(context(), ACCOUNT, first ?? '')).resolves.toBe('accepted');
    expect(rows.get(ACCOUNT)?.['recovery']).toHaveLength(RECOVERY_CODE_COUNT - 1);
    await expect(store.satisfied(context(), ACCOUNT, first ?? '')).resolves.toBe('refused');
  });

  test('is satisfied by a recovery code typed the way it was shown, spacing and case included', async () => {
    const codes = await enrolled();
    const shown = `${(codes[0] ?? '').slice(0, 5)}-${(codes[0] ?? '').slice(5)}`.toLowerCase();
    await expect(store.satisfied(context(), ACCOUNT, shown)).resolves.toBe('accepted');
  });
});

describe('replacing and revoking a second factor', () => {
  test('replaces the recovery codes with a set that is new, and every code of the old set stops working', async () => {
    const old = await enrolled();
    const replaced = await store.regenerate(context(), ACCOUNT);
    expect(replaced).toHaveLength(RECOVERY_CODE_COUNT);
    expect(replaced).not.toEqual(old);
    await expect(store.satisfied(context(), ACCOUNT, old[0] ?? '')).resolves.toBe('refused');
    await expect(store.satisfied(context(), ACCOUNT, replaced[0] ?? '')).resolves.toBe('accepted');
  });

  test('refuses to replace the codes of a second factor that is not there or not proved yet', async () => {
    await expect(store.regenerate(context(), ACCOUNT)).rejects.toMatchObject({ kind: 'state' });
    await store.enroll(context(), ACCOUNT);
    await expect(store.regenerate(context(), ACCOUNT)).rejects.toMatchObject({ kind: 'state' });
  });

  test('removes the credential when it is revoked, and says so only the time it removed one', async () => {
    await enrolled();
    await expect(store.revoke(context(), ACCOUNT)).resolves.toBe(true);
    expect(rows.size).toBe(0);
    await expect(store.revoke(context(), ACCOUNT)).resolves.toBe(false);
  });

  test('removes an enrolment that was never proved, because that is a second factor nobody has', async () => {
    await store.enroll(context(), ACCOUNT);
    await expect(store.revoke(context(), ACCOUNT)).resolves.toBe(true);
  });
});

describe('the index a second factor is found by', () => {
  test('declares the expiry that finishes an enrolment nobody proved, and no index beyond it', () => {
    expect(TOTP_INDEXES).toEqual([
      { name: 'totp_pending_expiry', keys: { pendingUntil: 1 }, options: { expireAfterSeconds: 0 } },
    ]);
  });

  test('builds the index it declares under the name it declares, and drops exactly that one again', async () => {
    const index = TOTP_INDEXES[0]!;
    await expect(createTotpIndexOn(memory.db, index)).resolves.toBe('created');
    await expect(dropTotpIndexOn(memory.db, index.name)).resolves.toBeUndefined();
  });

  test('reaches the collection it owns in whatever database it is handed', async () => {
    const asked: string[] = [];
    const driver = {
      collection: (name: string) => {
        asked.push(name);
        return memoryTotp().db.collection(name);
      },
    } as unknown as Db;
    await expect(totpsOn(totpDb(driver), { now }).revoke(context(), ACCOUNT)).resolves.toBe(false);
    expect(asked).toEqual([TOTP_COLLECTION]);
  });

  test('refuses an index it does not declare, and one over a field a credential does not carry', async () => {
    const undeclared = { name: 'totp_everything', keys: { secret: 1 }, options: {} } as const;
    await expect(createTotpIndexOn(memory.db, undeclared)).rejects.toMatchObject({ kind: 'schema' });
    await expect(dropTotpIndexOn(memory.db, 'totp_everything')).rejects.toMatchObject({ kind: 'schema' });
    const wrongField = { name: 'totp_pending_expiry', keys: { whenever: 1 }, options: {} } as const;
    await expect(createTotpIndexOn(memory.db, wrongField)).rejects.toMatchObject({ kind: 'schema' });
  });
});
