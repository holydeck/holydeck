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

const GATEKEEPER = sessionContext('req-0f9c2a41');

const READER = requestContext({
  actor: 'system',
  permissions: [SESSION_PERMISSIONS.read],
  correlationId: 'req-0f9c2a41',
});

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
    expect(stored?.['expiresAt']).toBe(at(SESSION_ABSOLUTE_HOURS * HOUR));
  });

  test('a context this code cannot read is refused before anything is written', async () => {
    const error = await refusal(() => store.start({}, { actor: ACTOR, permissions: [] }));
    expect(error.kind).toBe('context');
    expect(db.rows.size).toBe(0);
  });

  test('an actor who may not start a session is refused, and one who may not read cannot read', async () => {
    expect((await refusal(() => store.start(READER, { actor: ACTOR, permissions: [] }))).kind).toBe('permission');
    const session = await started();
    const reading = await refusal(() =>
      store.read(requestContext({ actor: 'system', permissions: [], correlationId: 'req-0f9c2a41' }), session.token),
    );
    expect(reading.kind).toBe('permission');
  });

  test('a session the contract refuses is refused here, rather than stored for nobody to read back', async () => {
    const error = await refusal(() => store.start(GATEKEEPER, { actor: '', permissions: [] }));
    expect(error.kind).toBe('schema');
    expect(error.message).toContain('session.actor');
    expect(db.rows.size).toBe(0);
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
    db.rows.set(id, { ...(db.rows.get(id) as Document), rotation: 'because-we-felt-like-it' });
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

  test('recovering a credential ends every session that actor holds and nobody else’s', async () => {
    await started();
    await store.start(GATEKEEPER, { actor: ACTOR, permissions: ['services.read'] });
    const other = await store.start(GATEKEEPER, { actor: 'account:9b12', permissions: ['services.read'] });
    await expect(store.revokeAllFor(GATEKEEPER, ACTOR)).resolves.toBe(2);
    expect(db.rows.size).toBe(1);
    await expect(store.read(GATEKEEPER, other.token)).resolves.toMatchObject({ actor: 'account:9b12' });
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
    expect(stored['tickets']).toEqual([{ hash: tokenDigest(ticket), expiresAt: at(TICKET_SECONDS * 1000) }]);
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
    const theirs = await store.start(GATEKEEPER, { actor: 'account:9b12', permissions: ['services.read'] });
    const ticket = await store.issueTicket(GATEKEEPER, mine.token);
    expect((await refusal(() => store.redeemTicket(GATEKEEPER, theirs.token, ticket))).kind).toBe('ticket');
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
    const issuing = await store.start(GATEKEEPER, { actor: 'account:9b12', permissions: ['services.read'] });
    const ticket = await store.issueTicket(GATEKEEPER, redeeming.token);
    clock = START + (SESSION_IDLE_MINUTES + 1) * MINUTE;
    expect((await refusal(() => store.redeemTicket(GATEKEEPER, redeeming.token, ticket))).kind).toBe('expired');
    expect((await refusal(() => store.issueTicket(GATEKEEPER, issuing.token))).kind).toBe('expired');
    expect(db.rows.size).toBe(0);
  });

  test('issuing and redeeming a ticket both need a context allowed to read the session', async () => {
    const session = await started();
    const nothing = requestContext({ actor: 'system', permissions: [], correlationId: 'req-0f9c2a41' });
    expect((await refusal(() => store.issueTicket(nothing, session.token))).kind).toBe('permission');
    expect((await refusal(() => store.redeemTicket(nothing, session.token, 'x'.padEnd(43, '0')))).kind).toBe(
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
    // Recovering a credential ends every session one actor holds, which is a query and not a scan.
    expect(index('session_actor').keys).toEqual({ actor: 1 });
  });

  test('a declared index is built on the collection the sessions live in', async () => {
    await expect(createSessionIndexOn(db.db, index('session_expiry'))).resolves.toBe('created');
    await expect(dropSessionIndexOn(db.db, 'session_actor')).resolves.toBeUndefined();
    expect(db.names).toEqual([SESSIONS_COLLECTION, SESSIONS_COLLECTION]);
  });

  test('an index this module does not declare is refused, whichever way it is asked for', async () => {
    const error = await refusal(() =>
      createSessionIndexOn(db.db, { name: 'session_actor_secret', keys: { actor: 1 }, options: {} }),
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
