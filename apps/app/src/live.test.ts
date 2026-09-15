import { request } from 'node:http';

import { CLIENT_WINDOW, UPDATE_REQUIRED_MESSAGE, supportedClientVersions } from '@holydeck/contracts/clients';
import { LIVE_CHANNELS, parseSnapshotFrame } from '@holydeck/contracts/live';
import { TICKET_QUERY, sessionCookie } from '@holydeck/contracts/sessions';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import {
  CLIENT_VERSION_QUERY,
  LIVE_CLOSE,
  LIVE_PATH,
  NOT_IN_THIS_BUILD,
  declaredVersion,
  isUpgrade,
  serveLive,
} from './live.js';
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
const session = (url: string) => {
  const socket = new WebSocket(url);
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

  it('serves every channel the contract declares', async () => {
    for (const channel of LIVE_CHANNELS) {
      const live = await connected(`channel=${channel}&${CURRENT}`);
      expect(await live.frame()).toMatchObject({ kind: 'snapshot', channel });
      await running?.close();
      running = undefined;
    }
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
    live.send({ kind: 'resume', channel: 'stage', fromSequence: 12 });
    expect(await live.frame()).toEqual({
      kind: 'snapshot',
      channel: 'stage',
      stateRevision: 0,
      sequence: 12,
      at: AT,
    });
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

  it.each(['command', 'event', 'snapshot'] as const)(
    'refuses a %s frame rather than pretending to serve behaviour this build does not have',
    async (kind) => {
      const live = await connected(`channel=live-control&${CURRENT}`);
      await live.frame();
      live.send({
        kind,
        channel: 'live-control',
        id: 'command-1',
        idempotencyKey: 'key-1',
        type: 'show-slide',
        clientStateRevision: 0,
        sequence: 1,
        stateRevision: 0,
        mutatesState: true,
        at: AT,
      });
      expect(await live.closed).toEqual({
        code: LIVE_CLOSE.refused,
        reason: `${kind}: ${NOT_IN_THIS_BUILD}`,
      });
    },
  );

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
