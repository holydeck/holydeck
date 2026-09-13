import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';

import {
  ACCOUNT_ATTEMPT_LIMIT,
  ADDRESS_ATTEMPT_LIMIT,
  ATTEMPTS_COLLECTION,
  ATTEMPT_ACTIONS,
  ATTEMPT_INDEXES,
  ATTEMPT_PERMISSIONS,
  ATTEMPT_RETENTION_HOURS,
  AttemptError,
  LOCK_MINUTES,
  accountScope,
  addressScope,
  attemptContext,
  attemptDb,
  attemptPrivileges,
  attemptsOn,
  createAttemptIndexOn,
  dropAttemptIndexOn,
} from './attempts.js';
import { ContextError, requestContext } from './context.js';
import { memoryAttempts } from '../test/helpers/attempts.js';

import type { Db } from 'mongodb';

import type { AttemptGate } from './attempts.js';
import type { Document } from './repositories.js';

const START = Date.parse('2026-09-13T09:30:00.000Z');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const GATE = attemptContext('req-0f9c2a41');

const HANDLE = accountScope('andru');

// RFC 5737 keeps a range aside for documentation: a suite that names a real address names somebody's router.
const CALLER = addressScope('203.0.113.7');

let gate: AttemptGate;
let store: ReturnType<typeof memoryAttempts>;
let clock: number;

const at = (milliseconds: number): string => new Date(START + milliseconds).toISOString();

const stored = (scope: string): Document => store.rows.get(scope) ?? {};

/** Answers with what the last of those failures answered, which is whether it was the one that locked. */
const failing = async (scope: string, times: number): Promise<boolean> => {
  let locked = false;
  for (let count = 0; count < times; count += 1) locked = await gate.failed(GATE, scope);
  return locked;
};

beforeEach(() => {
  store = memoryAttempts();
  clock = START;
  gate = attemptsOn(store.db, { now: () => new Date(clock).toISOString() });
});

describe('what the gate is', () => {
  test('names the collection it owns, the permissions it is reached through, and the actions it needs', () => {
    expect(ATTEMPTS_COLLECTION).toBe('sign_in_attempts');
    expect(ATTEMPT_PERMISSIONS).toEqual({ read: 'attempts.read', write: 'attempts.write' });
    // A count is raised, reset and forgiven, so the gate says out loud that it changes and removes what it
    // writes, rather than leaving a deployment to grant a durable record class more than it uses.
    expect(ATTEMPT_ACTIONS).toEqual(['createIndex', 'dropIndex', 'find', 'insert', 'listIndexes', 'remove', 'update']);
    expect(attemptPrivileges()).toEqual({ collection: ATTEMPTS_COLLECTION, actions: ATTEMPT_ACTIONS });
  });

  test('is reached under a context that is the product acting as itself, with both attempt permissions', () => {
    expect(GATE.actor).toBe('system');
    expect([...GATE.permissions].sort()).toEqual([...Object.values(ATTEMPT_PERMISSIONS)].sort());
    expect(() => attemptContext('no')).toThrow(ContextError);
  });

  test('allows an address far more failures than an account, because a household shares one', () => {
    expect(ACCOUNT_ATTEMPT_LIMIT).toBe(10);
    expect(ADDRESS_ATTEMPT_LIMIT).toBe(50);
    expect(ADDRESS_ATTEMPT_LIMIT).toBeGreaterThan(ACCOUNT_ATTEMPT_LIMIT);
  });
});

describe('the scope a failure is counted under', () => {
  test('names an account by the handle that was asked for, not by an account that exists', () => {
    expect(accountScope('andru')).toBe('account:andru');
    expect(accountScope('nobody-holds-this')).toBe('account:nobody-holds-this');
  });

  test('locks a handle nobody holds exactly as it locks one somebody does', async () => {
    // Otherwise the lock is the answer to "does this account exist?", which is the question the sign-in
    // route exists to refuse: an attacker would learn a handle is real by guessing at it until it locked.
    expect(await failing(accountScope('nobody-holds-this'), ACCOUNT_ATTEMPT_LIMIT)).toBe(true);
    expect(await gate.locked(GATE, accountScope('nobody-holds-this'))).toBe(true);
  });

  test('names an address by a digest of it, so a copy of the collection is no log of where anyone was', () => {
    expect(CALLER).toBe(`address:${createHash('sha256').update('203.0.113.7').digest('hex')}`);
    expect(CALLER).not.toContain('203.0.113.7');
    expect(addressScope('203.0.113.9')).not.toBe(CALLER);
  });
});

describe('counting failures towards a lock', () => {
  test('says a scope nothing has ever been counted for is not locked', async () => {
    expect(await gate.locked(GATE, HANDLE)).toBe(false);
    expect(store.names).toEqual([ATTEMPTS_COLLECTION]);
  });

  test('answers no to every failure below the account limit, and yes to the one that reaches it', async () => {
    expect(await failing(HANDLE, ACCOUNT_ATTEMPT_LIMIT - 1)).toBe(false);
    expect(await gate.locked(GATE, HANDLE)).toBe(false);
    expect(await gate.failed(GATE, HANDLE)).toBe(true);
    expect(await gate.locked(GATE, HANDLE)).toBe(true);
  });

  test('holds an address to its own far larger limit, chosen from the scope rather than from the caller', async () => {
    expect(await failing(CALLER, ACCOUNT_ATTEMPT_LIMIT)).toBe(false);
    expect(await gate.locked(GATE, CALLER)).toBe(false);
    expect(await failing(CALLER, ADDRESS_ATTEMPT_LIMIT - ACCOUNT_ATTEMPT_LIMIT)).toBe(true);
    expect(await gate.locked(GATE, CALLER)).toBe(true);
  });

  test('counts one scope without counting another, so one account cannot lock the rest', async () => {
    await failing(HANDLE, ACCOUNT_ATTEMPT_LIMIT);
    expect(await gate.locked(GATE, accountScope('someone-else'))).toBe(false);
    expect(await gate.locked(GATE, CALLER)).toBe(false);
  });

  test('starts the count again at zero once a scope locks, so the next window is freshly earned', async () => {
    await failing(HANDLE, ACCOUNT_ATTEMPT_LIMIT);
    expect(stored(HANDLE)).toMatchObject({ failures: 0, locks: 1 });
  });

  test('keeps a scope for a day past its last failure, and pushes that day out on every one', async () => {
    await gate.failed(GATE, HANDLE);
    expect(stored(HANDLE)['expiresAt']).toEqual(new Date(START + ATTEMPT_RETENTION_HOURS * HOUR));
    clock = START + HOUR;
    await gate.failed(GATE, HANDLE);
    expect(stored(HANDLE)['expiresAt']).toEqual(new Date(START + HOUR + ATTEMPT_RETENTION_HOURS * HOUR));
  });
});

describe('how long a locked scope stays locked', () => {
  test('refuses the scope for the whole window and lets it through the moment the window has passed', async () => {
    await failing(HANDLE, ACCOUNT_ATTEMPT_LIMIT);
    clock = START + LOCK_MINUTES[0]! * MINUTE - 1;
    expect(await gate.locked(GATE, HANDLE)).toBe(true);
    clock = START + LOCK_MINUTES[0]! * MINUTE;
    expect(await gate.locked(GATE, HANDLE)).toBe(false);
  });

  test('releases the scope by the clock, not by the document having been cleaned up', async () => {
    // The expiry index is housekeeping that mongod gets to when it gets to it, so a lock that has passed
    // has to read as passed while its document is still sitting there — which here it still is.
    await failing(HANDLE, ACCOUNT_ATTEMPT_LIMIT);
    clock = START + HOUR;
    expect(await gate.locked(GATE, HANDLE)).toBe(false);
    expect(store.rows.has(HANDLE)).toBe(true);
  });

  test('waits longer each time the same scope locks again: a minute, then five, fifteen and an hour', async () => {
    const windows: number[] = [];
    for (const minutes of LOCK_MINUTES) {
      await failing(HANDLE, ACCOUNT_ATTEMPT_LIMIT);
      windows.push((Date.parse(String(stored(HANDLE)['lockedUntil'])) - clock) / MINUTE);
      clock += minutes * MINUTE;
    }
    expect(windows).toEqual([...LOCK_MINUTES]);
  });

  test('waits no longer than the last window however many times the scope locks again after that', async () => {
    const longest = LOCK_MINUTES[LOCK_MINUTES.length - 1]!;
    for (const minutes of LOCK_MINUTES) {
      await failing(HANDLE, ACCOUNT_ATTEMPT_LIMIT);
      clock += minutes * MINUTE;
    }
    for (let again = 0; again < 2; again += 1) {
      await failing(HANDLE, ACCOUNT_ATTEMPT_LIMIT);
      expect(Date.parse(String(stored(HANDLE)['lockedUntil'])) - clock).toBe(longest * MINUTE);
      clock += longest * MINUTE;
    }
    expect(stored(HANDLE)['locks']).toBe(LOCK_MINUTES.length + 2);
  });
});

describe('forgiving a scope', () => {
  test('lets a scope that was locked through again, and forgets the backoff with it', async () => {
    await failing(HANDLE, ACCOUNT_ATTEMPT_LIMIT);
    await gate.forgiven(GATE, HANDLE);
    expect(store.rows.has(HANDLE)).toBe(false);
    expect(await gate.locked(GATE, HANDLE)).toBe(false);
    // The next lock is the first one again: a day of honest sign-ins is not paid for by an hour's wait.
    await failing(HANDLE, ACCOUNT_ATTEMPT_LIMIT);
    expect(Date.parse(String(stored(HANDLE)['lockedUntil'])) - clock).toBe(LOCK_MINUTES[0]! * MINUTE);
  });

  test('clears failures that had not yet reached the limit, so a success starts the count over', async () => {
    await failing(HANDLE, ACCOUNT_ATTEMPT_LIMIT - 1);
    await gate.forgiven(GATE, HANDLE);
    expect(await failing(HANDLE, ACCOUNT_ATTEMPT_LIMIT - 1)).toBe(false);
  });

  test('says nothing about a scope nothing was ever counted for', async () => {
    await expect(gate.forgiven(GATE, HANDLE)).resolves.toBeUndefined();
  });
});

describe('what the gate refuses whoever asks', () => {
  test('a call carrying no context at all, rather than acting as nobody', async () => {
    await expect(gate.locked(undefined, HANDLE)).rejects.toMatchObject({ kind: 'context' });
    await expect(gate.failed(undefined, HANDLE)).rejects.toMatchObject({ kind: 'context' });
    await expect(gate.forgiven(undefined, HANDLE)).rejects.toMatchObject({ kind: 'context' });
    expect(store.rows.size).toBe(0);
  });

  test('a call by an actor the permission it needs was never granted to', async () => {
    const reader = requestContext({
      actor: 'system',
      permissions: [ATTEMPT_PERMISSIONS.read],
      correlationId: 'req-0f9c2a41',
    });
    const writer = requestContext({
      actor: 'system',
      permissions: [ATTEMPT_PERMISSIONS.write],
      correlationId: 'req-0f9c2a41',
    });
    await expect(gate.failed(reader, HANDLE)).rejects.toMatchObject({ kind: 'permission' });
    await expect(gate.forgiven(reader, HANDLE)).rejects.toMatchObject({ kind: 'permission' });
    await expect(gate.locked(writer, HANDLE)).rejects.toMatchObject({ kind: 'permission' });
  });

  test('a scope of a kind it does not recognise, whichever verb was asked', async () => {
    const nonsense = 'session:7f3a';
    await expect(gate.locked(GATE, nonsense)).rejects.toBeInstanceOf(AttemptError);
    // Answering "not locked" for a scope it cannot put a limit on would be the one failure that fails open.
    await expect(gate.locked(GATE, nonsense)).rejects.toMatchObject({ kind: 'schema' });
    await expect(gate.failed(GATE, nonsense)).rejects.toMatchObject({ kind: 'schema' });
    await expect(gate.forgiven(GATE, nonsense)).rejects.toMatchObject({ kind: 'schema' });
    expect(store.rows.size).toBe(0);
  });
});

describe('what the collection is read and written through', () => {
  test('declares the one index it needs, which is the one that removes a scope nobody is using', () => {
    expect(ATTEMPT_INDEXES.map((index) => index.name)).toEqual(['attempt_expiry']);
    expect(ATTEMPT_INDEXES.map((index) => index.keys)).toEqual([{ expiresAt: 1 }]);
    expect(ATTEMPT_INDEXES.map((index) => index.options)).toEqual([{ expireAfterSeconds: 0 }]);
  });

  test('declares the database privileges the collection needs, including removing a forgiven scope', () => {
    expect(attemptPrivileges().collection).toBe(ATTEMPTS_COLLECTION);
    expect(attemptPrivileges().actions).toContain('remove');
    expect(attemptPrivileges().actions).toContain('update');
  });

  test('builds an index it declares, and refuses one it does not', async () => {
    const memory = memoryAttempts();
    await expect(createAttemptIndexOn(memory.db, ATTEMPT_INDEXES[0]!)).resolves.toBe('created');
    await expect(
      createAttemptIndexOn(memory.db, { name: 'attempt_address', keys: { expiresAt: 1 }, options: {} }),
    ).rejects.toMatchObject({ kind: 'schema' });
    await expect(
      createAttemptIndexOn(memory.db, { name: 'attempt_expiry', keys: { address: 1 }, options: {} }),
    ).rejects.toMatchObject({ kind: 'schema' });
  });

  test('drops an index it declares, and refuses to drop one it does not', async () => {
    const memory = memoryAttempts();
    await expect(dropAttemptIndexOn(memory.db, 'attempt_expiry')).resolves.toBeUndefined();
    await expect(dropAttemptIndexOn(memory.db, 'attempt_address')).rejects.toMatchObject({ kind: 'schema' });
  });

  test('reaches the collection it owns in whatever database it is handed', async () => {
    const asked: string[] = [];
    const driver = {
      collection: (name: string) => {
        asked.push(name);
        return memoryAttempts().db.collection(name);
      },
    } as unknown as Db;
    await attemptsOn(attemptDb(driver), { now: () => at(0) }).forgiven(GATE, HANDLE);
    expect(asked).toEqual([ATTEMPTS_COLLECTION]);
  });
});
