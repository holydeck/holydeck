import { CLIENT_WINDOW, UPDATE_REQUIRED_MESSAGE, supportedClientVersions } from '@holydeck/contracts/clients';
import { LIVE_CHANNELS, parseSnapshotFrame } from '@holydeck/contracts/live';
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
import { DEFAULT_SETTINGS, type LoadedSettings } from './settings.js';

import type { Fetching } from './corpus.js';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

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
  },
  path: '/data/holydeck/config/settings.yaml',
};

const refusing: Fetching = () => Promise.reject(new Error('nothing in this test may leave the process'));

const AT = '2026-09-13T10:00:00.000Z';

let running: FastifyInstance | undefined;

const listening = async (): Promise<string> => {
  const app = buildApp({ settings, logger: false, fetching: refusing });
  await serveLive(app, { clock: () => AT });
  await app.listen({ host: '127.0.0.1', port: 0 });
  running = app;
  const { port } = app.server.address() as AddressInfo;
  return `ws://127.0.0.1:${port}`;
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
