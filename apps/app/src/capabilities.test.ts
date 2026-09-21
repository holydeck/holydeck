import { beforeEach, describe, expect, test } from 'vitest';

import {
  CAPABILITIES_COLLECTION,
  CAPABILITY_ACTIONS,
  CAPABILITY_INDEXES,
  CAPABILITY_PERMISSIONS,
  CapabilityError,
  capabilitiesOn,
  capabilityContext,
  capabilityDb,
  capabilityPrivileges,
  createCapabilityIndexOn,
  dropCapabilityIndexOn,
  tokenDigest,
} from './capabilities.js';
import { requestContext } from './context.js';
import { SessionError, sessionContext, sessionsOn } from './sessions.js';
import { memoryCapabilities } from '../test/helpers/capabilities.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { Db } from 'mongodb';
import type { CapabilityStore } from './capabilities.js';

const CORRELATION = 'req-0f9c2a41';
const OPERATOR = 'account:7f3a';
const SERVICE = 'service:9b12';

let clock = Date.parse('2026-09-13T09:30:00.000Z');
let rows: Map<string, Record<string, unknown>>;
let names: string[];
let store: CapabilityStore;
let memory: ReturnType<typeof memoryCapabilities>;

const now = (): string => new Date(clock).toISOString();

const context = (): unknown => capabilityContext(CORRELATION);

const soon = (): string => new Date(clock + 60_000).toISOString();

beforeEach(() => {
  clock = Date.parse('2026-09-13T09:30:00.000Z');
  memory = memoryCapabilities();
  rows = memory.rows;
  names = memory.names;
  store = capabilitiesOn(memory.db, { now });
});

describe('what the capability store owns', () => {
  test('names the collection it owns, the permissions it is reached through, and the actions it needs', () => {
    expect(CAPABILITIES_COLLECTION).toBe('capabilities');
    expect(CAPABILITY_PERMISSIONS).toEqual({
      issue: 'capabilities.issue',
      redeem: 'capabilities.redeem',
      revoke: 'capabilities.revoke',
    });
    expect(capabilityPrivileges()).toEqual({ collection: CAPABILITIES_COLLECTION, actions: CAPABILITY_ACTIONS });
    expect(CAPABILITY_ACTIONS).not.toContain('update');
  });

  test('is reached under a context that is the product acting as itself, and under nothing else', async () => {
    await expect(
      store.issue({}, OPERATOR, { kind: 'guest', service: SERVICE, view: 'audience', expiresAt: soon() }),
    ).rejects.toMatchObject({ kind: 'context' });

    const redeemOnly = requestContext({
      actor: 'system',
      permissions: [CAPABILITY_PERMISSIONS.redeem],
      correlationId: CORRELATION,
    });
    const refused = await store
      .issue(redeemOnly, OPERATOR, { kind: 'guest', service: SERVICE, view: 'audience', expiresAt: soon() })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CapabilityError);
    expect(refused).toMatchObject({ kind: 'permission' });
    expect(String(refused)).toContain(CAPABILITY_PERMISSIONS.issue);
  });

  test('touches its own collection and no other', async () => {
    const issued = await store.issue(context(), OPERATOR, {
      kind: 'guest',
      service: SERVICE,
      view: 'audience',
      expiresAt: soon(),
    });
    await store.redeem(context(), issued.token, { service: SERVICE, view: 'audience' });
    await store.revoke(context(), issued.capabilityId);
    expect(new Set(names)).toEqual(new Set([CAPABILITIES_COLLECTION]));
  });
});

describe('issuing a capability', () => {
  test('mints a token nobody could guess, and an identifier that is the digest of it', async () => {
    const issued = await store.issue(context(), OPERATOR, {
      kind: 'guest',
      service: SERVICE,
      view: 'audience',
      expiresAt: soon(),
    });
    expect(issued.capabilityId).toBe(tokenDigest(issued.token));
    expect(JSON.stringify([...rows.values()])).not.toContain(issued.token);
  });

  test('mints a different token for every capability, even the same service asked for twice', async () => {
    const first = await store.issue(context(), OPERATOR, {
      kind: 'guest',
      service: SERVICE,
      view: 'audience',
      expiresAt: soon(),
    });
    const second = await store.issue(context(), OPERATOR, {
      kind: 'guest',
      service: SERVICE,
      view: 'audience',
      expiresAt: soon(),
    });
    expect(second.token).not.toBe(first.token);
    expect(rows.size).toBe(2);
  });

  test('is refused for a capability that is not scoped to one service', async () => {
    await expect(
      store.issue(context(), OPERATOR, { kind: 'guest', service: '', view: 'audience', expiresAt: soon() }),
    ).rejects.toMatchObject({ kind: 'schema' });
    expect(rows.size).toBe(0);
  });

  test('is refused for a capability with no expiry, or one that has already passed', async () => {
    await expect(
      store.issue(context(), OPERATOR, { kind: 'guest', service: SERVICE, view: 'audience', expiresAt: '' }),
    ).rejects.toMatchObject({ kind: 'schema' });
    await expect(
      store.issue(context(), OPERATOR, { kind: 'guest', service: SERVICE, view: 'audience', expiresAt: now() }),
    ).rejects.toMatchObject({ kind: 'schema' });
    expect(rows.size).toBe(0);
  });

  test('is refused for a guest capability asked to grant anything but the audience view', async () => {
    await expect(
      store.issue(context(), OPERATOR, { kind: 'guest', service: SERVICE, view: 'stage', expiresAt: soon() }),
    ).rejects.toMatchObject({ kind: 'schema' });
    expect(rows.size).toBe(0);
  });

  test('issues an output capability granting the stage view, when that is what is asked for', async () => {
    const issued = await store.issue(context(), OPERATOR, {
      kind: 'output',
      service: SERVICE,
      view: 'stage',
      expiresAt: soon(),
    });
    expect(rows.get(issued.capabilityId)).toMatchObject({ kind: 'output', view: 'stage' });
  });

  test('issues an output capability granting the singer view, alongside audience and stage', async () => {
    const issued = await store.issue(context(), OPERATOR, {
      kind: 'output',
      service: SERVICE,
      view: 'singer',
      expiresAt: soon(),
    });
    expect(rows.get(issued.capabilityId)).toMatchObject({ kind: 'output', view: 'singer' });
  });
});

describe('redeeming a capability', () => {
  test('is refused for a token nothing was issued under', async () => {
    await expect(store.redeem(context(), 'not-a-token', { service: SERVICE, view: 'audience' })).rejects.toMatchObject({
      kind: 'unknown',
    });
  });

  test('is refused once the deadline has passed, and forgets the capability at that read', async () => {
    const issued = await store.issue(context(), OPERATOR, {
      kind: 'guest',
      service: SERVICE,
      view: 'audience',
      expiresAt: soon(),
    });
    clock += 120_000;
    await expect(store.redeem(context(), issued.token, { service: SERVICE, view: 'audience' })).rejects.toMatchObject({
      kind: 'expired',
    });
    expect(rows.size).toBe(0);
    await expect(store.redeem(context(), issued.token, { service: SERVICE, view: 'audience' })).rejects.toMatchObject({
      kind: 'unknown',
    });
  });

  test('is refused for the right service asked of the wrong one, which is reuse and not a mistake', async () => {
    const issued = await store.issue(context(), OPERATOR, {
      kind: 'output',
      service: SERVICE,
      view: 'audience',
      expiresAt: soon(),
    });
    await expect(
      store.redeem(context(), issued.token, { service: 'service:other', view: 'audience' }),
    ).rejects.toMatchObject({ kind: 'service' });
  });

  test('is refused for a view the capability was not issued for, including one nothing may ever be issued for', async () => {
    const guest = await store.issue(context(), OPERATOR, {
      kind: 'guest',
      service: SERVICE,
      view: 'audience',
      expiresAt: soon(),
    });
    await expect(store.redeem(context(), guest.token, { service: SERVICE, view: 'stage' })).rejects.toMatchObject({
      kind: 'view',
    });
    // A caller cannot spell 'live-control' through the type, but the store still checks the row and not
    // the caller's word for it, so an adversarial value is refused exactly the same way a mismatch is.
    const adversarial = 'live-control' as unknown as 'audience';
    await expect(
      store.redeem(context(), guest.token, { service: SERVICE, view: adversarial }),
    ).rejects.toMatchObject({ kind: 'view' });
  });

  test('answers a guest with no identity at all, only the service and the view it was scoped to', async () => {
    const issued = await store.issue(context(), OPERATOR, {
      kind: 'guest',
      service: SERVICE,
      view: 'audience',
      expiresAt: soon(),
    });
    const redeemed = await store.redeem(context(), issued.token, { service: SERVICE, view: 'audience' });
    expect(redeemed).toEqual({ kind: 'guest', service: SERVICE, view: 'audience' });
    expect(Object.keys(redeemed).sort()).toEqual(['kind', 'service', 'view']);
  });

  test('answers an output window with no control and no grants, and nothing can make that answer otherwise', async () => {
    const issued = await store.issue(context(), OPERATOR, {
      kind: 'output',
      service: SERVICE,
      view: 'stage',
      expiresAt: soon(),
    });
    const redeemed = await store.redeem(context(), issued.token, { service: SERVICE, view: 'stage' });
    expect(redeemed).toEqual({ kind: 'output', service: SERVICE, view: 'stage', canControl: false, grants: [] });
  });

  test('redeems a singer-view output window exactly as it was issued', async () => {
    const issued = await store.issue(context(), OPERATOR, {
      kind: 'output',
      service: SERVICE,
      view: 'singer',
      expiresAt: soon(),
    });
    const redeemed = await store.redeem(context(), issued.token, { service: SERVICE, view: 'singer' });
    expect(redeemed).toEqual({ kind: 'output', service: SERVICE, view: 'singer', canControl: false, grants: [] });
  });
});

describe('revoking a capability', () => {
  test('is idempotent: revoking twice, or revoking one nothing holds, is not a defect', async () => {
    const issued = await store.issue(context(), OPERATOR, {
      kind: 'guest',
      service: SERVICE,
      view: 'audience',
      expiresAt: soon(),
    });
    await expect(store.revoke(context(), issued.capabilityId)).resolves.toBeUndefined();
    await expect(store.revoke(context(), issued.capabilityId)).resolves.toBeUndefined();
    await expect(store.revoke(context(), 'never-issued')).resolves.toBeUndefined();
  });

  test('takes effect on the very next redemption, with no window in which a stale copy still works', async () => {
    const issued = await store.issue(context(), OPERATOR, {
      kind: 'output',
      service: SERVICE,
      view: 'audience',
      expiresAt: soon(),
    });
    await store.revoke(context(), issued.capabilityId);
    await expect(store.redeem(context(), issued.token, { service: SERVICE, view: 'audience' })).rejects.toMatchObject({
      kind: 'unknown',
    });
  });

  // Restoring a backup puts data back that every issued capability predates. Nothing in the archive can
  // revoke them — capabilities are never in it — so the store has to be able to revoke all of them at
  // once, without needing to be told which service or view each was issued for.
  test('a restore revokes every capability at once, whatever it was issued for', async () => {
    const guest = await store.issue(context(), OPERATOR, {
      kind: 'guest',
      service: SERVICE,
      view: 'audience',
      expiresAt: soon(),
    });
    const output = await store.issue(context(), OPERATOR, { kind: 'output', service: SERVICE, view: 'stage', expiresAt: soon() });
    await expect(store.revokeEvery(context())).resolves.toBe(2);
    expect(rows.size).toBe(0);
    await expect(store.redeem(context(), guest.token, { service: SERVICE, view: 'audience' })).rejects.toMatchObject({
      kind: 'unknown',
    });
    await expect(store.redeem(context(), output.token, { service: SERVICE, view: 'stage' })).rejects.toMatchObject({
      kind: 'unknown',
    });
  });

  test('revoking every capability needs the permission to revoke one', async () => {
    await store.issue(context(), OPERATOR, { kind: 'guest', service: SERVICE, view: 'audience', expiresAt: soon() });
    const redeemOnly = requestContext({
      actor: 'system',
      permissions: [CAPABILITY_PERMISSIONS.redeem],
      correlationId: CORRELATION,
    });
    await expect(store.revokeEvery(redeemOnly)).rejects.toMatchObject({ kind: 'permission' });
    expect(rows.size).toBe(1);
  });
});

describe('a capability is not a session', () => {
  test('is not found in the session store, and does not spend a ticket there, however alike the two tokens look', async () => {
    const sessionMemory = memorySessions();
    const sessions = sessionsOn(sessionMemory.db, { now });
    const guard = sessionContext(CORRELATION);

    const issued = await store.issue(context(), OPERATOR, {
      kind: 'output',
      service: SERVICE,
      view: 'audience',
      expiresAt: soon(),
    });
    await expect(sessions.read(guard, issued.token)).rejects.toBeInstanceOf(SessionError);

    const session = await sessions.start(guard, { actor: OPERATOR, permissions: [] });
    await expect(sessions.redeemTicket(guard, session.token, issued.token)).rejects.toBeInstanceOf(SessionError);
  });
});

describe('the index a capability is forgotten by', () => {
  test('declares the expiry every capability is written with, and no index beyond it', () => {
    expect(CAPABILITY_INDEXES).toEqual([
      { name: 'capability_expiry', keys: { expiresOn: 1 }, options: { expireAfterSeconds: 0 } },
    ]);
  });

  test('builds the index it declares under the name it declares, and drops exactly that one again', async () => {
    const index = CAPABILITY_INDEXES[0]!;
    await expect(createCapabilityIndexOn(memory.db, index)).resolves.toBe('created');
    await expect(dropCapabilityIndexOn(memory.db, index.name)).resolves.toBeUndefined();
  });

  test('reaches the collection it owns in whatever database it is handed', async () => {
    const asked: string[] = [];
    const driver = {
      collection: (name: string) => {
        asked.push(name);
        return memoryCapabilities().db.collection(name);
      },
    } as unknown as Db;
    await expect(capabilitiesOn(capabilityDb(driver), { now }).revoke(context(), 'nothing')).resolves.toBeUndefined();
    expect(asked).toEqual([CAPABILITIES_COLLECTION]);
  });

  test('refuses an index it does not declare, and one over a field a capability does not carry', async () => {
    const undeclared = { name: 'capability_everything', keys: { service: 1 }, options: {} } as const;
    await expect(createCapabilityIndexOn(memory.db, undeclared)).rejects.toMatchObject({ kind: 'schema' });
    await expect(dropCapabilityIndexOn(memory.db, 'capability_everything')).rejects.toMatchObject({ kind: 'schema' });
    const wrongField = { name: 'capability_expiry', keys: { whenever: 1 }, options: {} } as const;
    await expect(createCapabilityIndexOn(memory.db, wrongField)).rejects.toMatchObject({ kind: 'schema' });
  });
});
