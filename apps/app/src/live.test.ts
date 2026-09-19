import { request } from 'node:http';

import { CLIENT_WINDOW, UPDATE_REQUIRED_MESSAGE, supportedClientVersions } from '@holydeck/contracts/clients';
import { STALE_STATE_REVISION } from '@holydeck/contracts/http';
import { LIVE_CHANNELS, LIVE_CLOSE, OUTPUT_CHANNELS, parseSnapshotFrame } from '@holydeck/contracts/live';
import { TICKET_QUERY, sessionCookie } from '@holydeck/contracts/sessions';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { CLIENT_VERSION_QUERY, LIVE_PATH, declaredVersion, isUpgrade, serveLive } from './live.js';
import { PRESENTATION_CONTROL } from './roles.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { DEFAULT_SETTINGS, type LoadedSettings } from './settings.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { Fetching } from './corpus.js';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { SessionStore } from './sessions.js';

const settings: LoadedSettings = {
  values: { ...DEFAULT_SETTINGS },
  sources: {
    port: 'default',
    dataDir: 'default',
    mediaRoot: 'default',
    resticRepository: 'default',
    locale: 'default',
    corpusUrl: 'default',
    corpusToken: 'default',
    mongoUrl: 'default',
    timezone: 'default',
  },
  path: '/data/holydeck/config/settings.yaml',
};

const refusing: Fetching = () => Promise.reject(new Error('nothing in this test may leave the process'));

const AT = '2026-09-13T10:00:00.000Z';

let running: FastifyInstance | undefined;

const listening = async (sessions?: SessionStore): Promise<string> => {
  const app = buildApp({ settings, logger: false, fetching: refusing, sessions });
  await serveLive(app, { clock: () => AT, sessions });
  await app.listen({ host: '127.0.0.1', port: 0 });
  running = app;
  const { port } = app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}`;
};

/**
 * The handshake itself, and only the handshake: a browser sets no header on a socket, so what is proven
 * here is proven out of the cookie the browser attaches and the ticket in the query string. The answer
 * is the status the upgrade was refused with, or 101 for the upgrade that was allowed to happen.
 */
const handshake = async (base: string, query: string, headers: Record<string, string>): Promise<number> => {
  const url = new URL(`${LIVE_PATH}?${query}`, base.replace(/^ws/u, 'http'));
  return new Promise<number>((resolve, reject) => {
    const asked = request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        origin: `http://${url.host}`,
        ...headers,
      },
    });
    asked.on('upgrade', (_answer, socket) => {
      socket.destroy();
      resolve(101);
    });
    asked.on('response', (answer) => {
      answer.resume();
      resolve(answer.statusCode ?? 0);
    });
    asked.on('error', reject);
    asked.end();
  });
};

/** A session that records what arrived, so a test can wait for the next frame or for the close. */
const session = (url: string, headers: Record<string, string> = {}) => {
  // A browser sets neither of these itself, which is exactly why the handshake reads them: this is the
  // only place in a test where a socket has to be opened the way a page would have opened it.
  const socket = new WebSocket(url, { headers } as never);
  const arrived: unknown[] = [];
  const waiting: ((frame: unknown) => void)[] = [];
  socket.addEventListener('message', (event) => {
    const frame: unknown = JSON.parse(String(event.data));
    const next = waiting.shift();
    if (next === undefined) arrived.push(frame);
    else next(frame);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason }));
  });
  return {
    socket,
    closed,
    opened: new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('the handshake failed')));
    }),
    frame: async (): Promise<unknown> => {
      const already = arrived.shift();
      if (already !== undefined) return already;
      return new Promise<unknown>((resolve) => waiting.push(resolve));
    },
    send: (frame: unknown): void => socket.send(JSON.stringify(frame)),
  };
};

const connected = async (query: string) => {
  const base = await listening();
  const live = session(`${base}${LIVE_PATH}?${query}`);
  await live.opened;
  return live;
};

const CURRENT = `${CLIENT_VERSION_QUERY}=${CLIENT_WINDOW.current}`;

/**
 * One deployment that keeps sessions, and one signed-in session on it carrying exactly the permissions a
 * test names. Every socket it opens spends a ticket of its own, because a ticket opens one socket — which
 * is what lets a test hold an operator and a surface open on the same run at the same time.
 */
const deployment = async (permissions: readonly string[]) => {
  const real = sessionsOn(memorySessions().db, { now: () => new Date().toISOString() });
  const context = sessionContext('req-0f9c2a41');
  const signedIn = await real.start(context, { actor: 'account:7f3a', permissions });
  const base = await listening(real);
  const cookie = sessionCookie(signedIn.token, 60);
  return {
    open: async (channel: string) => {
      const ticket = await real.issueTicket(context, signedIn.token);
      const live = session(`${base}${LIVE_PATH}?channel=${channel}&${CURRENT}&${TICKET_QUERY}=${ticket}`, {
        cookie,
        origin: base.replace(/^ws/u, 'http'),
      });
      await live.opened;
      return live;
    },
  };
};

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('the version a socket client declares', () => {
  it('is the query parameter, because a browser socket cannot send a header', () => {
    expect(declaredVersion(`${LIVE_PATH}?${CURRENT}`)).toBe(String(CLIENT_WINDOW.current));
  });

  it('is absent on a socket that declares nothing', () => {
    expect(declaredVersion(LIVE_PATH)).toBeUndefined();
  });
});

describe('a request asking to stop being an HTTP request', () => {
  it('is the one that names the socket protocol, however it is spelled', () => {
    expect(isUpgrade({ upgrade: 'WebSocket' })).toBe(true);
    expect(isUpgrade({ upgrade: 'h2c' })).toBe(false);
    expect(isUpgrade({})).toBe(false);
  });
});

describe('the live session', () => {
  it('closes a client version this build cannot serve, saying so where a browser can read it', async () => {
    const live = await connected(`channel=audience&${CLIENT_VERSION_QUERY}=99`);
    expect(await live.closed).toEqual({
      code: LIVE_CLOSE.refused,
      reason: `${CLIENT_VERSION_QUERY}: ${UPDATE_REQUIRED_MESSAGE} — supported: ${supportedClientVersions().join(', ')}`,
    });
  });

  it('closes a client that declares no version at all, rather than guessing which protocol it speaks', async () => {
    const live = await connected('channel=audience');
    expect((await live.closed).code).toBe(LIVE_CLOSE.refused);
  });

  it('answers a supported client with a snapshot of the channel it asked for', async () => {
    const live = await connected(`channel=audience&${CURRENT}`);
    const parsed = parseSnapshotFrame(await live.frame());
    expect(parsed).toEqual({
      ok: true,
      value: { kind: 'snapshot', channel: 'audience', stateRevision: 0, sequence: 0, at: AT },
    });
  });

  it('serves every surface a service is shown on, none of which is behind a permission', async () => {
    for (const channel of OUTPUT_CHANNELS) {
      const live = await connected(`channel=${channel}&${CURRENT}`);
      expect(await live.frame()).toMatchObject({ kind: 'snapshot', channel });
      await running?.close();
      running = undefined;
    }
  });

  it('closes a session reaching for the channel a service is run from without Control presentation', async () => {
    const live = await connected(`channel=live-control&${CURRENT}`);
    expect(await live.closed).toEqual({
      code: LIVE_CLOSE.refused,
      reason: 'channel: this session may not watch live-control',
    });
  });

  it('closes a session that asks for a channel the contract does not declare', async () => {
    const live = await connected(`channel=lobby&${CURRENT}`);
    expect(await live.closed).toEqual({
      code: LIVE_CLOSE.refused,
      reason: `channel: must be one of ${LIVE_CHANNELS.join(', ')}`,
    });
  });

  it('closes a session that asks for no channel at all', async () => {
    const live = await connected(CURRENT);
    expect(await live.closed).toEqual({
      code: LIVE_CLOSE.refused,
      reason: `channel: must be one of ${LIVE_CHANNELS.join(', ')}`,
    });
  });

  it('answers a resume with a snapshot from the sequence the client asked to resume from', async () => {
    const live = await connected(`channel=stage&${CURRENT}`);
    await live.frame();
    live.send({ kind: 'resume', channel: 'stage', fromSequence: 0 });
    expect(await live.frame()).toEqual({
      kind: 'snapshot',
      channel: 'stage',
      stateRevision: 0,
      sequence: 0,
      at: AT,
    });
  });

  it('moves a client resuming from a sequence this server never issued to where the server stands', async () => {
    const live = await connected(`channel=stage&${CURRENT}`);
    await live.frame();
    live.send({ kind: 'resume', channel: 'stage', fromSequence: 12 });
    expect(await live.frame()).toMatchObject({ kind: 'snapshot', channel: 'stage', sequence: 0 });
  });

  it('closes a session that resumes a channel it is not connected to', async () => {
    const live = await connected(`channel=stage&${CURRENT}`);
    await live.frame();
    live.send({ kind: 'resume', channel: 'audience', fromSequence: 0 });
    expect(await live.closed).toEqual({
      code: LIVE_CLOSE.refused,
      reason: 'resume.channel: this session is connected to stage',
    });
  });

  it('closes a session that sends something that is not a frame at all', async () => {
    const live = await connected(`channel=audience&${CURRENT}`);
    await live.frame();
    live.socket.send('{ not json');
    expect(await live.closed).toEqual({ code: LIVE_CLOSE.unreadable, reason: 'frame: must be JSON' });
  });

  it('closes a session that sends a frame this build cannot read, naming what it could not read', async () => {
    const live = await connected(`channel=audience&${CURRENT}`);
    await live.frame();
    live.send({ kind: 'resume', channel: 'audience', fromSequence: -1 });
    expect(await live.closed).toEqual({
      code: LIVE_CLOSE.unreadable,
      reason: 'resume.fromSequence: must be at least 0',
    });
  });

  it('closes a session that sends a frame of a kind the contract does not declare', async () => {
    const live = await connected(`channel=audience&${CURRENT}`);
    await live.frame();
    live.send({ kind: 'shout', channel: 'audience' });
    expect((await live.closed).code).toBe(LIVE_CLOSE.unreadable);
  });

  it.each(['snapshot', 'event', 'ack'] as const)('closes a session that sent a %s, which is the server’s to send', async (kind) => {
    const live = await connected(`channel=audience&${CURRENT}`);
    await live.frame();
    live.send({
      kind,
      channel: 'audience',
      id: 'command-1',
      outcome: 'applied',
      type: 'show-slide',
      sequence: 1,
      stateRevision: 0,
      mutatesState: true,
      at: AT,
    });
    expect(await live.closed).toEqual({
      code: LIVE_CLOSE.refused,
      reason: `${kind}: a client does not send this frame`,
    });
  });

  it('tells a surface that tried to command that it may watch, and leaves it watching', async () => {
    const live = await connected(`channel=audience&${CURRENT}`);
    await live.frame();
    live.send({
      kind: 'command',
      channel: 'audience',
      id: 'command-1',
      idempotencyKey: 'key-1',
      type: 'show-slide',
      clientStateRevision: 0,
    });
    expect(await live.frame()).toMatchObject({ kind: 'ack', id: 'command-1', outcome: 'unauthorized' });
    expect(live.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('leaves the ordinary HTTP surface answering while a session is open', async () => {
    const live = await connected(`channel=audience&${CURRENT}`);
    await live.frame();
    const response = await running?.inject({ method: 'GET', url: '/health' });
    expect(response?.statusCode).toBe(200);
  });

  it('stamps frames with the wall clock when nothing hands it one', async () => {
    const app = buildApp({ settings, logger: false, fetching: refusing });
    await serveLive(app);
    await app.listen({ host: '127.0.0.1', port: 0 });
    running = app;
    const { port } = app.server.address() as AddressInfo;
    const live = session(`ws://127.0.0.1:${port}${LIVE_PATH}?channel=audience&${CURRENT}`);
    await live.opened;
    const frame = (await live.frame()) as { at: string };
    expect(Date.now() - Date.parse(frame.at)).toBeLessThan(5_000);
  });

  it('still tells an ordinary request to the live path to update, since it declared no version', async () => {
    await listening();
    const response = await running?.inject({ method: 'GET', url: `${LIVE_PATH}?channel=audience` });
    expect(response?.statusCode).toBe(426);
    expect(response?.json()).toMatchObject({ error: { message: UPDATE_REQUIRED_MESSAGE } });
  });
});

describe('a session carrying Control presentation', () => {
  it('opens the channel a service is run from, which nothing else may watch', async () => {
    const run = await deployment([PRESENTATION_CONTROL]);
    const control = await run.open('live-control');
    expect(await control.frame()).toMatchObject({ kind: 'snapshot', channel: 'live-control', stateRevision: 0 });
  });

  it('runs a command, and is told what became of it after the change it made', async () => {
    const run = await deployment([PRESENTATION_CONTROL]);
    const control = await run.open('live-control');
    await control.frame();
    control.send({
      kind: 'command',
      channel: 'live-control',
      id: 'command-1',
      idempotencyKey: 'key-1',
      type: 'show-slide',
      clientStateRevision: 0,
    });
    expect(await control.frame()).toMatchObject({ kind: 'event', sequence: 1, stateRevision: 1, type: 'show-slide' });
    expect(await control.frame()).toMatchObject({ kind: 'ack', id: 'command-1', outcome: 'applied', stateRevision: 1 });
  });

  it('reaches a surface watching the same run, without that surface asking for anything', async () => {
    const run = await deployment([PRESENTATION_CONTROL]);
    const audience = await run.open('audience');
    const control = await run.open('live-control');
    await audience.frame();
    await control.frame();
    control.send({
      kind: 'command',
      channel: 'live-control',
      id: 'command-1',
      idempotencyKey: 'key-1',
      type: 'show-slide',
      clientStateRevision: 0,
    });
    expect(await audience.frame()).toMatchObject({ kind: 'event', channel: 'audience', sequence: 1 });
  });

  it('refuses a command issued against a revision the run has moved past, and says what to re-issue against', async () => {
    const run = await deployment([PRESENTATION_CONTROL]);
    const control = await run.open('live-control');
    await control.frame();
    const command = (id: string, key: string) => ({
      kind: 'command',
      channel: 'live-control',
      id,
      idempotencyKey: key,
      type: 'show-slide',
      clientStateRevision: 0,
    });
    control.send(command('command-1', 'key-1'));
    await control.frame();
    await control.frame();
    control.send(command('command-2', 'key-2'));
    expect(await control.frame()).toMatchObject({
      kind: 'ack',
      id: 'command-2',
      outcome: 'stale',
      conflictCode: STALE_STATE_REVISION,
      stateRevision: 1,
    });
  });

  // Failure injection, spec 14.3: the network goes during a live run. The surface loses its connection
  // without a word while the operator carries on, and comes back to exactly what it missed.
  it('catches a surface up on a run it was disconnected in the middle of, with no gap and no duplicate', async () => {
    const run = await deployment([PRESENTATION_CONTROL]);
    const audience = await run.open('audience');
    const control = await run.open('live-control');
    await audience.frame();
    await control.frame();

    const command = (at: number) => ({
      kind: 'command',
      channel: 'live-control',
      id: `command-${at}`,
      idempotencyKey: `key-${at}`,
      type: 'show-slide',
      clientStateRevision: at,
    });

    control.send(command(0));
    expect(await audience.frame()).toMatchObject({ kind: 'event', sequence: 1 });
    await control.frame();
    await control.frame();

    audience.socket.close();
    await audience.closed;
    for (const at of [1, 2]) {
      control.send(command(at));
      await control.frame();
      await control.frame();
    }

    const again = await run.open('audience');
    await again.frame();
    again.send({ kind: 'resume', channel: 'audience', fromSequence: 1 });
    expect(await again.frame()).toMatchObject({ kind: 'snapshot', sequence: 1, stateRevision: 1 });
    expect(await again.frame()).toMatchObject({ kind: 'event', sequence: 2 });
    expect(await again.frame()).toMatchObject({ kind: 'event', sequence: 3 });
  });

  it('runs a command retried after the connection dropped exactly once, however often it is sent', async () => {
    const run = await deployment([PRESENTATION_CONTROL]);
    const first = await run.open('live-control');
    await first.frame();
    const command = {
      kind: 'command',
      channel: 'live-control',
      id: 'command-1',
      idempotencyKey: 'key-1',
      type: 'show-slide',
      clientStateRevision: 0,
    };
    first.send(command);
    await first.frame();
    await first.frame();
    first.socket.close();
    await first.closed;

    const again = await run.open('live-control');
    expect(await again.frame()).toMatchObject({ kind: 'snapshot', stateRevision: 1, sequence: 1 });
    again.send(command);
    expect(await again.frame()).toMatchObject({ kind: 'ack', outcome: 'duplicate', stateRevision: 1, sequence: 1 });
  });
});

// a socket is a state-changing connection a page on another site can also ask for, so the
// handshake proves what a mutation proves — this deployment's own origin, and a ticket the session in
// the cookie was issued, good once and for seconds. The ticket is in the URL because a browser socket
// can put nothing anywhere else; the session identifier stays in the cookie, where a URL never sees it.
describe('the handshake a deployment that keeps sessions requires', () => {
  const started = async (defect?: unknown): Promise<{ base: string; cookie: string; ticket: string }> => {
    const real = sessionsOn(memorySessions().db, { now: () => new Date().toISOString() });
    const context = sessionContext('req-0f9c2a41');
    const session = await real.start(context, { actor: 'account:7f3a', permissions: ['services.read'] });
    const ticket = await real.issueTicket(context, session.token);
    const base = await listening(defect === undefined ? real : { ...real, redeemTicket: () => Promise.reject(defect) });
    return { base, cookie: sessionCookie(session.token, 60), ticket };
  };

  it('opens the socket for a session that spent a ticket, and closes that ticket behind it', async () => {
    const { base, cookie, ticket } = await started();
    const query = `channel=audience&${CURRENT}&${TICKET_QUERY}=${ticket}`;
    expect(await handshake(base, query, { cookie })).toBe(101);
    expect(await handshake(base, query, { cookie })).toBe(403);
  });

  it('refuses a handshake carrying no ticket at all', async () => {
    const { base, cookie } = await started();
    expect(await handshake(base, `channel=audience&${CURRENT}`, { cookie })).toBe(403);
  });

  it('refuses a ticket this deployment never issued', async () => {
    const { base, cookie } = await started();
    const query = `channel=audience&${CURRENT}&${TICKET_QUERY}=${'x'.repeat(43)}`;
    expect(await handshake(base, query, { cookie })).toBe(403);
  });

  it('refuses a handshake carrying a ticket and no session', async () => {
    const { base, ticket } = await started();
    expect(await handshake(base, `channel=audience&${CURRENT}&${TICKET_QUERY}=${ticket}`, {})).toBe(401);
  });

  it('refuses a handshake asked for from another site, whatever it carries', async () => {
    const { base, cookie, ticket } = await started();
    const query = `channel=audience&${CURRENT}&${TICKET_QUERY}=${ticket}`;
    expect(await handshake(base, query, { cookie, origin: 'https://elsewhere.example.invalid' })).toBe(403);
  });

  it('answers a store that failed for any other reason as a fault of this server’s, and says nothing of it', async () => {
    const defect = new TypeError('mongodb://holydeck:hunter2@records.invalid:27017 is not a function');
    const { base, cookie, ticket } = await started(defect);
    expect(await handshake(base, `channel=audience&${CURRENT}&${TICKET_QUERY}=${ticket}`, { cookie })).toBe(500);
  });

  it('refuses a handshake whose session is unknown, and says so as a request with no session', async () => {
    const { base, ticket } = await started();
    const query = `channel=audience&${CURRENT}&${TICKET_QUERY}=${ticket}`;
    const cookie = sessionCookie('y'.repeat(43), 60);
    expect(await handshake(base, query, { cookie })).toBe(401);
  });
});

describe('a deployment that keeps no sessions', () => {
  it('opens the socket without a ticket, because there is no session for one to come from', async () => {
    const base = await listening();
    expect(await handshake(base, `channel=audience&${CURRENT}`, {})).toBe(101);
  });
});
