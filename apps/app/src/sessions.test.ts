import {
  SESSION_ABSOLUTE_HOURS,
  SESSION_IDLE_MINUTES,
  SESSION_ROTATIONS,
  TICKET_SECONDS,
  isOpaqueToken,
} from '@holydeck/contracts/sessions';
import { beforeEach, describe, expect, test } from 'vitest';

import { requestContext } from './context.js';
import {
  MAX_TICKETS,
  SESSION_ACTIONS,
  SESSION_INDEXES,
  SESSION_PERMISSIONS,
  SESSIONS_COLLECTION,
  SessionError,
  createSessionIndexOn,
  dropSessionIndexOn,
  sessionContext,
  sessionPrivileges,
  sessionsOn,
  tokenDigest,
} from './sessions.js';

import { memorySessions } from '../test/helpers/sessions.js';

import type { Document } from './repositories.js';
import type { SessionIndex, SessionStore } from './sessions.js';

const START = Date.parse('2026-09-13T09:30:00.000Z');
const ACTOR = 'account:7f3a';
const OTHER = 'account:9b12';

const GATEKEEPER = sessionContext('req-0f9c2a41');

const READER = requestContext({
  actor: 'system',
  permissions: [SESSION_PERMISSIONS.read],
  correlationId: 'req-0f9c2a41',
});

const NOTHING = requestContext({ actor: 'system', permissions: [], correlationId: 'req-0f9c2a41' });

let store: SessionStore;
let db: ReturnType<typeof memorySessions>;
let clock: number;
let issued: number;

const at = (milliseconds: number): string => new Date(START + milliseconds).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const open = (): void => {
  db = memorySessions();
  clock = START;
  issued = 0;
  store = sessionsOn(db.db, {
    now: () => new Date(clock).toISOString(),
    // Predictable and still shaped like the real thing, so a test can name the token it is holding.
    newToken: () => `token-${++issued}`.padEnd(43, '0'),
  });
};

const refusal = async (run: () => Promise<unknown>): Promise<SessionError> => {
  const error = await run().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SessionError);
  return error as SessionError;
};

const started = (permissions: readonly string[] = ['services.read']) =>
  store.start(GATEKEEPER, { actor: ACTOR, permissions });

/** The identifier a stored slot was given, read directly off the document — no answer ever carries it back. */
const slotIdOf = (token: string, actor: string): string => {
  const stored = db.rows.get(tokenDigest(token)) as Document;
  const slot = (stored['slots'] as Document[]).find((candidate) => candidate['actor'] === actor) as Document;
  return slot['slotId'] as string;
};

beforeEach(() => {
  open();
});

describe('what a session is', () => {
  test('names the collection it owns, the permissions it is reached through, and the actions it needs', () => {
    expect(SESSIONS_COLLECTION).toBe('sessions');
    expect(SESSION_PERMISSIONS).toEqual({
      start: 'sessions.start',
      read: 'sessions.read',
      end: 'sessions.end',
    });
    // Unlike a durable record, a session is operational state: it is refreshed, rotated and removed, and
    // the privileges say so out loud rather than leaving a deployment to grant more than the code uses.
    expect(SESSION_ACTIONS).toContain('remove');
    expect(sessionPrivileges()).toEqual({ collection: SESSIONS_COLLECTION, actions: SESSION_ACTIONS });
  });

  test('the gatekeeper context is the product acting as itself, with the three session permissions', () => {
    expect(GATEKEEPER.actor).toBe('system');
    expect([...GATEKEEPER.permissions].sort()).toEqual([...Object.values(SESSION_PERMISSIONS)].sort());
  });

  test('starting one answers with an opaque token and a record the client may hold', async () => {
    const session = await started(['services.read', 'services.write']);
    expect(isOpaqueToken(session.token)).toBe(true);
    expect(session.record).toEqual({
      actor: ACTOR,
      permissions: ['services.read', 'services.write'],
      startedAt: at(0),
      lastSeenAt: at(0),
      expiresAt: at(SESSION_ABSOLUTE_HOURS * HOUR),
      rotation: 'authentication',
      csrf: expect.any(String) as unknown as string,
    });
    expect(isOpaqueToken(session.record.csrf)).toBe(true);
    expect(db.names).toEqual([SESSIONS_COLLECTION]);
  });

  // the identifier is opaque and what it stands for lives here. A database this product stores
  // its own sessions in holds no session identifier, so a copy of it signs nobody in.
  test('the database holds the digest of the token and never the token', async () => {
    const session = await started();
    const [stored] = [...db.rows.values()];
    expect(stored?.['_id']).toBe(tokenDigest(session.token));
    expect(JSON.stringify(stored)).not.toContain(session.token);
    expect(tokenDigest(session.token)).not.toBe(tokenDigest(`${session.token}x`));
  });

  test('the absolute deadline is stored a second time as an instant the database can expire on', async () => {
    await started();
    const [stored] = [...db.rows.values()];
    expect(stored?.['expiresOn']).toEqual(new Date(at(SESSION_ABSOLUTE_HOURS * HOUR)));
    expect((stored?.['slots'] as Document[])[0]?.['expiresAt']).toBe(at(SESSION_ABSOLUTE_HOURS * HOUR));
  });

  test('a context this code cannot read is refused before anything is written', async () => {
    const error = await refusal(() => store.start({}, { actor: ACTOR, permissions: [] }));
    expect(error.kind).toBe('context');
    expect(db.rows.size).toBe(0);
  });

  test('an actor who may not start a session is refused, and one who may not read cannot read', async () => {
    expect((await refusal(() => store.start(READER, { actor: ACTOR, permissions: [] }))).kind).toBe('permission');
    const session = await started();
    const reading = await refusal(() => store.read(NOTHING, session.token));
    expect(reading.kind).toBe('permission');
  });

  test('a session the contract refuses is refused here, rather than stored for nobody to read back', async () => {
    const error = await refusal(() => store.start(GATEKEEPER, { actor: '', permissions: [] }));
    expect(error.kind).toBe('schema');
    expect(error.message).toContain('session.actor');
    expect(db.rows.size).toBe(0);
  });
});

describe('joining an existing container', () => {
  test('no join token starts a fresh container, the same as ever', async () => {
    const session = await started();
    expect(session.record.actor).toBe(ACTOR);
    expect(db.rows.size).toBe(1);
  });

  test('a join token nobody issued falls back to a fresh container, silently', async () => {
    const unknown = 'not-a-token'.padEnd(43, '0');
    const session = await store.start(GATEKEEPER, { actor: ACTOR, permissions: ['services.read'] }, unknown);
    expect(session.token).not.toBe(unknown);
    expect(db.rows.size).toBe(1);
  });

  test('a join token whose container has nothing alive falls back to a fresh container, silently', async () => {
    const stale = await started();
    clock = START + (SESSION_IDLE_MINUTES + 1) * MINUTE;
    const session = await store.start(GATEKEEPER, { actor: OTHER, permissions: ['services.read'] }, stale.token);
    expect(session.token).not.toBe(stale.token);
    expect(session.record.actor).toBe(OTHER);
  });

  test('a live join adds a slot to the same container, with nothing copied between slots', async () => {
    const first = await started(['services.read']);
    const second = await store.start(
      GATEKEEPER,
      { actor: OTHER, permissions: ['presentation.control'] },
      first.token,
    );
    expect(second.token).toBe(first.token);
    expect(db.rows.size).toBe(1);
    const stored = db.rows.get(tokenDigest(first.token)) as Document;
    expect((stored['slots'] as Document[]).length).toBe(2);
    expect(stored['active']).toBe(slotIdOf(first.token, OTHER));
    expect(second.record.actor).toBe(OTHER);
    expect(second.record.permissions).toEqual(['presentation.control']);
    expect(second.record.csrf).not.toBe(first.record.csrf);
    const untouched = (stored['slots'] as Document[]).find((slot) => slot['actor'] === ACTOR);
    expect(untouched?.['csrf']).toBe(first.record.csrf);
    expect(untouched?.['permissions']).toEqual(['services.read']);
  });

  test('a same-actor re-join replaces the slot in place, not alongside it', async () => {
    const first = await started(['services.read']);
    const before = slotIdOf(first.token, ACTOR);
    clock = START + MINUTE;
    const second = await store.start(
      GATEKEEPER,
      { actor: ACTOR, permissions: ['services.read', 'services.write'] },
      first.token,
    );
    expect(second.token).toBe(first.token);
    const stored = db.rows.get(tokenDigest(first.token)) as Document;
    expect((stored['slots'] as Document[]).length).toBe(1);
    expect(slotIdOf(first.token, ACTOR)).toBe(before);
    expect(second.record.permissions).toEqual(['services.read', 'services.write']);
    expect(second.record.csrf).not.toBe(first.record.csrf);
  });

  test('a same-actor re-join beside a sibling replaces only its own slot, leaving the sibling untouched', async () => {
    const first = await started(['services.read']);
    const sibling = await store.start(GATEKEEPER, { actor: OTHER, permissions: ['presentation.control'] }, first.token);
    const second = await store.start(
      GATEKEEPER,
      { actor: ACTOR, permissions: ['services.read', 'services.write'] },
      first.token,
    );
    const stored = db.rows.get(tokenDigest(second.token)) as Document;
    expect((stored['slots'] as Document[]).length).toBe(2);
    const untouched = (stored['slots'] as Document[]).find((slot) => slot['actor'] === OTHER);
    expect(untouched?.['csrf']).toBe(sibling.record.csrf);
    expect(untouched?.['permissions']).toEqual(['presentation.control']);
  });
});

describe('switching the active slot', () => {
  test('activating a sibling makes it the active slot, and leaves the other where it was', async () => {
    const first = await started(['services.read']);
    const second = await store.start(
      GATEKEEPER,
      { actor: OTHER, permissions: ['presentation.control'] },
      first.token,
    );
    const firstId = slotIdOf(first.token, ACTOR);
    clock = START + MINUTE;
    const record = await store.activate(GATEKEEPER, first.token, firstId);
    expect(record.actor).toBe(ACTOR);
    expect(record.lastSeenAt).toBe(at(MINUTE));
    const stored = db.rows.get(tokenDigest(first.token)) as Document;
    expect(stored['active']).toBe(firstId);
    const untouchedOther = (stored['slots'] as Document[]).find((slot) => slot['actor'] === OTHER);
    expect(untouchedOther?.['lastSeenAt']).toBe(second.record.lastSeenAt);
  });

  test('switching to a slot identifier this container does not hold is refused, and nothing changes', async () => {
    const session = await started();
    const before = JSON.stringify(db.rows.get(tokenDigest(session.token)));
    const error = await refusal(() => store.activate(GATEKEEPER, session.token, 'not-a-real-slot'));
    expect(error.kind).toBe('slot');
    expect(JSON.stringify(db.rows.get(tokenDigest(session.token)))).toBe(before);
  });

  test('switching needs the permission to read a session', async () => {
    const session = await started();
    expect((await refusal(() => store.activate(NOTHING, session.token, 'anything'))).kind).toBe('permission');
  });
});

describe('reporting the slots a container holds', () => {
  test('lists exactly slotId and actor for every slot, and nothing a sibling should not see', async () => {
    const first = await started(['services.read']);
    await store.start(GATEKEEPER, { actor: OTHER, permissions: ['presentation.control'] }, first.token);
    const firstId = slotIdOf(first.token, ACTOR);
    const secondId = slotIdOf(first.token, OTHER);
    const byActor = (left: { actor: string }, right: { actor: string }): number => left.actor.localeCompare(right.actor);
    const summaries = await store.slots(GATEKEEPER, first.token);
    expect([...summaries].sort(byActor)).toEqual(
      [
        { slotId: firstId, actor: ACTOR },
        { slotId: secondId, actor: OTHER },
      ].sort(byActor),
    );
    for (const summary of summaries) {
      expect(Object.keys(summary).sort()).toEqual(['actor', 'slotId']);
    }
  });

  test('reporting slots needs the permission to read a session', async () => {
    const session = await started();
    expect((await refusal(() => store.slots(NOTHING, session.token))).kind).toBe('permission');
  });
});

describe('per-slot pruning', () => {
  const rawSlot = (fields: { readonly slotId: string; readonly actor: string; readonly lastSeenAt: string }): Document => ({
    slotId: fields.slotId,
    actor: fields.actor,
    permissions: ['services.read'],
    startedAt: at(0),
    lastSeenAt: fields.lastSeenAt,
    expiresAt: at(SESSION_ABSOLUTE_HOURS * HOUR),
    rotation: 'authentication',
    csrf: `csrf-${fields.slotId}`.padEnd(43, '0'),
  });

  const seeded = (token: string, active: string, slots: readonly Document[]): void => {
    const id = tokenDigest(token);
    db.rows.set(id, {
      _id: id,
      active,
      slots,
      expiresOn: new Date(at(SESSION_ABSOLUTE_HOURS * HOUR)),
      tickets: [],
    });
  };

  test('an idle sibling is pruned without pulling the active slot down with it', async () => {
    const token = 'token-seeded-1'.padEnd(43, '0');
    seeded(token, 'active-1', [
      rawSlot({ slotId: 'active-1', actor: ACTOR, lastSeenAt: at(100 * MINUTE) }),
      rawSlot({ slotId: 'sibling-1', actor: OTHER, lastSeenAt: at(0) }),
    ]);
    clock = START + 121 * MINUTE;
    const record = await store.read(GATEKEEPER, token);
    expect(record.actor).toBe(ACTOR);
    const stored = db.rows.get(tokenDigest(token)) as Document;
    expect((stored['slots'] as Document[]).map((slot) => slot['slotId'])).toEqual(['active-1']);
    expect(stored['active']).toBe('active-1');
  });

  test('the active slot going idle promotes its most recently seen sibling, silently', async () => {
    const token = 'token-seeded-2'.padEnd(43, '0');
    seeded(token, 'active-1', [
      rawSlot({ slotId: 'active-1', actor: ACTOR, lastSeenAt: at(0) }),
      rawSlot({ slotId: 'sibling-1', actor: OTHER, lastSeenAt: at(100 * MINUTE) }),
    ]);
    clock = START + 121 * MINUTE;
    const record = await store.read(GATEKEEPER, token);
    expect(record.actor).toBe(OTHER);
    const stored = db.rows.get(tokenDigest(token)) as Document;
    expect((stored['slots'] as Document[]).map((slot) => slot['slotId'])).toEqual(['sibling-1']);
    expect(stored['active']).toBe('sibling-1');
  });

  test('an active pointer naming no live slot falls back to the most recently seen of several', async () => {
    const token = 'token-seeded-4'.padEnd(43, '0');
    seeded(token, 'not-a-real-slot', [
      rawSlot({ slotId: 'slot-a', actor: ACTOR, lastSeenAt: at(10 * MINUTE) }),
      rawSlot({ slotId: 'slot-b', actor: OTHER, lastSeenAt: at(20 * MINUTE) }),
    ]);
    clock = START + 25 * MINUTE;
    const record = await store.read(GATEKEEPER, token);
    expect(record.actor).toBe(OTHER);
  });

  test('every slot going idle at once ends the container, exactly as a single-slot session does', async () => {
    const token = 'token-seeded-3'.padEnd(43, '0');
    seeded(token, 'active-1', [
      rawSlot({ slotId: 'active-1', actor: ACTOR, lastSeenAt: at(0) }),
      rawSlot({ slotId: 'sibling-1', actor: OTHER, lastSeenAt: at(0) }),
    ]);
    clock = START + (SESSION_IDLE_MINUTES + 1) * MINUTE;
    expect((await refusal(() => store.read(GATEKEEPER, token))).kind).toBe('expired');
    expect(db.rows.has(tokenDigest(token))).toBe(false);
  });

  test('a stored container with no slots array at all is read as holding none, and refused the same way', async () => {
    const token = 'token-seeded-5'.padEnd(43, '0');
    const id = tokenDigest(token);
    db.rows.set(id, { _id: id, active: 'whatever', expiresOn: new Date(at(SESSION_ABSOLUTE_HOURS * HOUR)), tickets: [] });
    expect((await refusal(() => store.read(GATEKEEPER, token))).kind).toBe('expired');
    expect(db.rows.has(id)).toBe(false);
  });

  test('a stored slot missing its own identifier is read back with an empty one, not thrown on', async () => {
    const token = 'token-seeded-6'.padEnd(43, '0');
    const bare = rawSlot({ slotId: 'ignored', actor: ACTOR, lastSeenAt: at(0) });
    Reflect.deleteProperty(bare, 'slotId');
    seeded(token, '', [bare]);
    clock = START + MINUTE;
    expect(await store.slots(GATEKEEPER, token)).toEqual([{ slotId: '', actor: ACTOR }]);
  });
});

describe('reading a session back', () => {
  test('the token reads the record, and reading it is what keeps it alive', async () => {
    const session = await started();
    clock = START + 90 * MINUTE;
    const record = await store.read(GATEKEEPER, session.token);
    expect(record.lastSeenAt).toBe(at(90 * MINUTE));
    clock = START + 180 * MINUTE;
    // Ninety minutes after the refresh, which is inside the idle window the refresh moved.
    await expect(store.read(GATEKEEPER, session.token)).resolves.toMatchObject({ actor: ACTOR });
  });

  test('a token this server did not issue is unknown, and the refusal says nothing else', async () => {
    const error = await refusal(() => store.read(GATEKEEPER, 'not-a-token'.padEnd(43, '0')));
    expect(error.kind).toBe('unknown');
    expect(error.message).not.toContain('not-a-token');
  });

  test('a session that heard nothing for the idle window is over, and is gone', async () => {
    const session = await started();
    clock = START + (SESSION_IDLE_MINUTES + 1) * MINUTE;
    expect((await refusal(() => store.read(GATEKEEPER, session.token))).kind).toBe('expired');
    expect(db.rows.size).toBe(0);
  });

  test('a session busy all day is still over at the absolute deadline', async () => {
    const session = await started();
    for (let hour = 1; hour <= SESSION_ABSOLUTE_HOURS; hour += 1) {
      clock = START + hour * HOUR;
      if (hour < SESSION_ABSOLUTE_HOURS) await store.read(GATEKEEPER, session.token);
    }
    expect((await refusal(() => store.read(GATEKEEPER, session.token))).kind).toBe('expired');
    expect(db.rows.size).toBe(0);
  });

  test('a stored session this code cannot read is refused rather than trusted', async () => {
    const session = await started();
    const id = tokenDigest(session.token);
    const stored = db.rows.get(id) as Document;
    const slots = (stored['slots'] as Document[]).map((slot) => ({ ...slot, rotation: 'because-we-felt-like-it' }));
    db.rows.set(id, { ...stored, slots });
    const error = await refusal(() => store.read(GATEKEEPER, session.token));
    expect(error.kind).toBe('schema');
    expect(error.message).toContain('session.rotation');
  });
});

describe('rotation invalidates the identifier that came before', () => {
  test('each reason issues a new token and a new CSRF token, and retires the old one', async () => {
    for (const rotation of SESSION_ROTATIONS) {
      open();
      const first = await started();
      clock = START + MINUTE;
      const second = await store.rotate(GATEKEEPER, first.token, { rotation });
      expect(second.token).not.toBe(first.token);
      expect(second.record.csrf).not.toBe(first.record.csrf);
      expect(second.record.rotation).toBe(rotation);
      // The session continues — same actor, same day — under an identifier the old one cannot reach.
      expect(second.record.actor).toBe(ACTOR);
      expect(second.record.startedAt).toBe(first.record.startedAt);
      expect(second.record.expiresAt).toBe(first.record.expiresAt);
      expect((await refusal(() => store.read(GATEKEEPER, first.token))).kind).toBe('unknown');
      expect(db.rows.size).toBe(1);
    }
  });

  test('a privilege change carries the permissions it changed to', async () => {
    const first = await started(['services.read']);
    const second = await store.rotate(GATEKEEPER, first.token, {
      rotation: 'privilege-change',
      permissions: ['services.read', 'services.write'],
    });
    expect(second.record.permissions).toEqual(['services.read', 'services.write']);
  });

  test('a reason the contract does not know is refused, and the session it names survives', async () => {
    const first = await started();
    const error = await refusal(() => store.rotate(GATEKEEPER, first.token, { rotation: 'because' as never }));
    expect(error.kind).toBe('schema');
    await expect(store.read(GATEKEEPER, first.token)).resolves.toMatchObject({ actor: ACTOR });
  });

  test('a session that is over cannot be rotated into a fresh one', async () => {
    const first = await started();
    clock = START + (SESSION_IDLE_MINUTES + 1) * MINUTE;
    expect((await refusal(() => store.rotate(GATEKEEPER, first.token, { rotation: 'reauthentication' }))).kind).toBe(
      'expired',
    );
  });

  test('rotation needs the permission to end a session as well as the one to start it', async () => {
    const first = await started();
    const starter = requestContext({
      actor: 'system',
      permissions: [SESSION_PERMISSIONS.start, SESSION_PERMISSIONS.read],
      correlationId: 'req-0f9c2a41',
    });
    expect((await refusal(() => store.rotate(starter, first.token, { rotation: 'reauthentication' }))).kind).toBe(
      'permission',
    );
  });

  test('rotating the active slot in a shared container leaves the other slot untouched', async () => {
    const first = await started(['services.read']);
    // Joining a slot makes it the active one, so this rotation lands on the sibling that just joined —
    // and it is the first, now-inactive slot whose fields must be the ones nothing here touches.
    await store.start(GATEKEEPER, { actor: OTHER, permissions: ['presentation.control'] }, first.token);
    const rotated = await store.rotate(GATEKEEPER, first.token, { rotation: 'privilege-change', permissions: ['services.read', 'services.write'] });
    const stored = db.rows.get(tokenDigest(rotated.token)) as Document;
    const untouched = (stored['slots'] as Document[]).find((slot) => slot['actor'] === ACTOR);
    expect(untouched?.['csrf']).toBe(first.record.csrf);
    expect(untouched?.['permissions']).toEqual(['services.read']);
  });
});

describe('ending a session', () => {
  test('signing out removes the record, and the token that was signed out with is unknown', async () => {
    const session = await started();
    await expect(store.revoke(GATEKEEPER, session.token)).resolves.toBe(true);
    expect(db.rows.size).toBe(0);
    expect((await refusal(() => store.read(GATEKEEPER, session.token))).kind).toBe('unknown');
  });

  test('signing out twice is not an error, because the second one asks for what is already true', async () => {
    const session = await started();
    await store.revoke(GATEKEEPER, session.token);
    await expect(store.revoke(GATEKEEPER, session.token)).resolves.toBe(false);
  });

  test('signing out ends every slot in the container at once — there is no partial sign-out', async () => {
    const first = await started();
    await store.start(GATEKEEPER, { actor: OTHER, permissions: ['services.read'] }, first.token);
    await expect(store.revoke(GATEKEEPER, first.token)).resolves.toBe(true);
    expect(db.rows.size).toBe(0);
    expect((await refusal(() => store.read(GATEKEEPER, first.token))).kind).toBe('unknown');
  });

  test('recovering a credential ends every session that actor holds and nobody else’s', async () => {
    await started();
    await store.start(GATEKEEPER, { actor: ACTOR, permissions: ['services.read'] });
    const other = await store.start(GATEKEEPER, { actor: OTHER, permissions: ['services.read'] });
    await expect(store.revokeAllFor(GATEKEEPER, ACTOR)).resolves.toBe(2);
    expect(db.rows.size).toBe(1);
    await expect(store.read(GATEKEEPER, other.token)).resolves.toMatchObject({ actor: OTHER });
  });

  test('recovering a credential leaves a sibling actor’s own slot in the same container untouched', async () => {
    const first = await started();
    await store.start(GATEKEEPER, { actor: OTHER, permissions: ['services.read'] }, first.token);
    await expect(store.revokeAllFor(GATEKEEPER, ACTOR)).resolves.toBe(1);
    const stored = db.rows.get(tokenDigest(first.token)) as Document;
    expect((stored['slots'] as Document[]).map((slot) => slot['actor'])).toEqual([OTHER]);
  });

  test('recovering a credential that held the active slot promotes a sibling automatically', async () => {
    const first = await started();
    await store.start(GATEKEEPER, { actor: OTHER, permissions: ['services.read'] }, first.token);
    // The join above made OTHER's slot active; switch back so the revoked actor's slot is the active one.
    await store.activate(GATEKEEPER, first.token, slotIdOf(first.token, ACTOR));
    await store.revokeAllFor(GATEKEEPER, ACTOR);
    await expect(store.read(GATEKEEPER, first.token)).resolves.toMatchObject({ actor: OTHER });
  });

  test('ending a session needs the permission to end one', async () => {
    const session = await started();
    expect((await refusal(() => store.revoke(READER, session.token))).kind).toBe('permission');
    expect((await refusal(() => store.revokeAllFor(READER, ACTOR))).kind).toBe('permission');
  });
});

describe('the ticket a socket handshake carries', () => {
  test('a ticket is opaque, short-lived, and stored as a digest beside the session it belongs to', async () => {
    const session = await started();
    const ticket = await store.issueTicket(GATEKEEPER, session.token);
    expect(isOpaqueToken(ticket)).toBe(true);
    const stored = db.rows.get(tokenDigest(session.token)) as Document;
    expect(stored['tickets']).toEqual([
      { hash: tokenDigest(ticket), expiresAt: at(TICKET_SECONDS * 1000), slotId: slotIdOf(session.token, ACTOR) },
    ]);
    expect(JSON.stringify(stored)).not.toContain(ticket);
  });

  test('a ticket opens one socket, and the second attempt with it opens none', async () => {
    const session = await started();
    const ticket = await store.issueTicket(GATEKEEPER, session.token);
    await expect(store.redeemTicket(GATEKEEPER, session.token, ticket)).resolves.toMatchObject({ actor: ACTOR });
    expect((await refusal(() => store.redeemTicket(GATEKEEPER, session.token, ticket))).kind).toBe('ticket');
  });

  test('a ticket past its seconds is refused, and is used up in the refusing', async () => {
    const session = await started();
    const ticket = await store.issueTicket(GATEKEEPER, session.token);
    clock = START + (TICKET_SECONDS + 1) * 1000;
    expect((await refusal(() => store.redeemTicket(GATEKEEPER, session.token, ticket))).kind).toBe('ticket');
    const stored = db.rows.get(tokenDigest(session.token)) as Document;
    expect(stored['tickets']).toEqual([]);
  });

  test('a ticket is only good for the session it was issued to', async () => {
    const mine = await started();
    const theirs = await store.start(GATEKEEPER, { actor: OTHER, permissions: ['services.read'] });
    const ticket = await store.issueTicket(GATEKEEPER, mine.token);
    expect((await refusal(() => store.redeemTicket(GATEKEEPER, theirs.token, ticket))).kind).toBe('ticket');
  });

  test('a ticket minted for a low-privilege slot never resolves to a sibling switched into afterward', async () => {
    const member = await started(['services.read']);
    const ticket = await store.issueTicket(GATEKEEPER, member.token);
    // The join makes the Control-holding sibling active — the ticket must still resolve to the slot that
    // minted it, never to whichever slot happens to be active when it is redeemed.
    await store.start(GATEKEEPER, { actor: OTHER, permissions: ['presentation.control'] }, member.token);
    const record = await store.redeemTicket(GATEKEEPER, member.token, ticket);
    expect(record.actor).toBe(ACTOR);
    expect(record.permissions).not.toContain('presentation.control');
  });

  test('a ticket whose slot has since been pruned is refused the same way any other bad ticket is', async () => {
    const first = await started();
    // Minted just before the first slot's own idle deadline, so both it and the ticket are alive here.
    clock = START + SESSION_IDLE_MINUTES * MINUTE - 10_000;
    const ticket = await store.issueTicket(GATEKEEPER, first.token);
    await store.start(GATEKEEPER, { actor: OTHER, permissions: ['services.read'] }, first.token);
    // Past the first slot's idle deadline, but still inside the ticket's own thirty seconds.
    clock = START + SESSION_IDLE_MINUTES * MINUTE + 5_000;
    expect((await refusal(() => store.redeemTicket(GATEKEEPER, first.token, ticket))).kind).toBe('ticket');
  });

  test('switching back to the slot that minted a ticket resumes it, undisturbed by what happened in between', async () => {
    const first = await started(['services.read']);
    const firstId = slotIdOf(first.token, ACTOR);
    const ticket = await store.issueTicket(GATEKEEPER, first.token);
    await store.start(GATEKEEPER, { actor: OTHER, permissions: ['presentation.control'] }, first.token);
    await store.activate(GATEKEEPER, first.token, firstId);
    const record = await store.redeemTicket(GATEKEEPER, first.token, ticket);
    expect(record.actor).toBe(ACTOR);
  });

  test('an operator opening several outputs keeps the newest tickets and no more', async () => {
    const session = await started();
    const tickets: string[] = [];
    for (let index = 0; index < MAX_TICKETS + 1; index += 1) {
      tickets.push(await store.issueTicket(GATEKEEPER, session.token));
    }
    const stored = db.rows.get(tokenDigest(session.token)) as Document;
    expect((stored['tickets'] as unknown[]).length).toBe(MAX_TICKETS);
    // The oldest fell off the end; every one after it still opens the socket it was issued for.
    expect((await refusal(() => store.redeemTicket(GATEKEEPER, session.token, tickets[0] as string))).kind).toBe(
      'ticket',
    );
    await expect(store.redeemTicket(GATEKEEPER, session.token, tickets[1] as string)).resolves.toMatchObject({
      actor: ACTOR,
    });
  });

  // Two sessions, because the first refusal ends the session it refused, and the second half of this is
  // about a session that is over rather than about a session that is gone.
  test('a ticket for a session that is over is refused as the session is, not as a bad ticket', async () => {
    const redeeming = await started();
    const issuing = await store.start(GATEKEEPER, { actor: OTHER, permissions: ['services.read'] });
    const ticket = await store.issueTicket(GATEKEEPER, redeeming.token);
    clock = START + (SESSION_IDLE_MINUTES + 1) * MINUTE;
    expect((await refusal(() => store.redeemTicket(GATEKEEPER, redeeming.token, ticket))).kind).toBe('expired');
    expect((await refusal(() => store.issueTicket(GATEKEEPER, issuing.token))).kind).toBe('expired');
    expect(db.rows.size).toBe(0);
  });

  test('issuing and redeeming a ticket both need a context allowed to read the session', async () => {
    const session = await started();
    expect((await refusal(() => store.issueTicket(NOTHING, session.token))).kind).toBe('permission');
    expect((await refusal(() => store.redeemTicket(NOTHING, session.token, 'x'.padEnd(43, '0')))).kind).toBe(
      'permission',
    );
  });
});

describe('the indexes a deployment builds', () => {
  const index = (name: string): SessionIndex => {
    const declared = SESSION_INDEXES.find((candidate) => candidate.name === name);
    expect(declared).toBeDefined();
    return declared as SessionIndex;
  };

  test('the database is what forgets a session that is over, on the instant it holds for that', () => {
    expect(SESSION_INDEXES.map((declared) => declared.name)).toEqual(['session_actor', 'session_expiry']);
    expect(index('session_expiry')).toEqual({
      name: 'session_expiry',
      keys: { expiresOn: 1 },
      options: { expireAfterSeconds: 0 },
    });
    // Recovering a credential ends every session one actor holds, which is a query and not a scan — a
    // multikey index into every slot's own actor, since one container can hold more than one.
    expect(index('session_actor').keys).toEqual({ 'slots.actor': 1 });
  });

  test('a declared index is built on the collection the sessions live in', async () => {
    await expect(createSessionIndexOn(db.db, index('session_expiry'))).resolves.toBe('created');
    await expect(dropSessionIndexOn(db.db, 'session_actor')).resolves.toBeUndefined();
    expect(db.names).toEqual([SESSIONS_COLLECTION, SESSIONS_COLLECTION]);
  });

  test('an index this module does not declare is refused, whichever way it is asked for', async () => {
    const error = await refusal(() =>
      createSessionIndexOn(db.db, { name: 'session_actor_secret', keys: { 'slots.actor': 1 }, options: {} }),
    );
    expect(error.kind).toBe('schema');
    expect((await refusal(() => dropSessionIndexOn(db.db, 'session_actor_secret'))).kind).toBe('schema');
  });

  test('an index on a field a session does not carry is refused', async () => {
    const error = await refusal(() =>
      createSessionIndexOn(db.db, { name: 'session_actor', keys: { churchId: 1 }, options: {} }),
    );
    expect(error.kind).toBe('schema');
    expect(error.message).toContain('churchId');
  });
});
