import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { STALE_STATE_REVISION } from '@holydeck/contracts/http';
import { CHANNEL_QUERY, LIVE_CLOSE, LIVE_CONTROL_CHANNEL } from '@holydeck/contracts/live';
import { TICKET_QUERY } from '@holydeck/contracts/sessions';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RETRY_BASE_MS,
  RETRY_CEILING_MS,
  createLiveClient,
  detectLiveSocket,
  liveSocketUrl,
  retryDelayMs,
} from './live-client.js';

import type {
  LiveClient,
  LiveClientOptions,
  LiveCredentials,
  LiveSnapshot,
  SocketEventLike,
  WebSocketLike,
  WebSocketOpener,
} from './live-client.js';
import type { EventFrame, LiveChannel } from '@holydeck/contracts/live';

const AT = '2026-09-19T10:00:00.000Z';
const ORIGIN = 'https://deployment.invalid';

type Frame = Record<string, unknown>;

/**
 * The far side of a socket, with the four things a real one has that a test has to be able to move:
 * when it opens, what arrives on it, when it fails, and when it ends. `vanish` is the fifth — a write
 * that throws because the peer is no longer there, which is what a network loss looks like from inside
 * a browser. Written against `WebSocketLike` rather than a real socket for the same reason
 * `live-protocol.test.ts`'s `peer()` is written against `LiveTransport`.
 */
interface FarSide {
  readonly socket: WebSocketLike;
  readonly url: string;
  sent(): readonly Frame[];
  accept(): void;
  deliver(frame: Frame): void;
  deliverRaw(text: string): void;
  fail(): void;
  end(code?: number, reason?: string): void;
  /** A close event carrying neither a code nor a reason, which some browsers do fire. */
  endBare(): void;
  vanish(): void;
  ended(): { readonly code: number; readonly reason: string } | undefined;
}

const far = (
  url: string,
  onSend: (text: string) => void = () => undefined,
  onClose: () => void = () => undefined,
): FarSide => {
  const listeners = new Map<string, ((event: SocketEventLike) => void)[]>();
  const written: string[] = [];
  let readyState = 0;
  let gone = false;
  let ended: { readonly code: number; readonly reason: string } | undefined;

  const fire = (type: string, event: SocketEventLike): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  };

  const socket: WebSocketLike = {
    get readyState(): number {
      return readyState;
    },
    send(data: string): void {
      if (gone) throw new Error('the connection is gone');
      written.push(data);
      onSend(data);
    },
    close(code = 1000, reason = ''): void {
      if (gone) throw new Error('the connection is gone');
      if (ended !== undefined) return;
      ended = { code, reason };
      readyState = 3;
      onClose();
    },
    addEventListener(type: string, listener: (event: SocketEventLike) => void): void {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };

  return {
    socket,
    url,
    sent: (): readonly Frame[] => written.map((text) => JSON.parse(text) as Frame),
    accept: (): void => {
      readyState = 1;
      fire('open', {});
    },
    deliver: (frame: Frame): void => fire('message', { data: JSON.stringify(frame) }),
    deliverRaw: (text: string): void => fire('message', { data: text }),
    fail: (): void => fire('error', {}),
    end: (code = 1006, reason = ''): void => {
      readyState = 3;
      fire('close', { code, reason });
    },
    endBare: (): void => {
      readyState = 3;
      fire('close', {});
    },
    vanish: (): void => {
      gone = true;
    },
    ended: () => ended,
  };
};

/** Sockets a test opens by hand, for the cases that have no hub behind them. */
const sockets = (): { open: WebSocketOpener; opened: FarSide[]; last(): FarSide } => {
  const opened: FarSide[] = [];
  return {
    open: (url: string): WebSocketLike => {
      const side = far(url);
      opened.push(side);
      return side.socket;
    },
    opened,
    last(): FarSide {
      const side = opened.at(-1);
      if (side === undefined) throw new Error('no socket was opened');
      return side;
    },
  };
};

/** A client whose reconnects are collected rather than waited out, and whose tickets are countable. */
const clientOn = (
  channel: LiveChannel,
  open: WebSocketOpener | undefined,
  overrides: Partial<LiveClientOptions> = {},
): { client: LiveClient; runs: (() => void)[]; minted: () => number } => {
  const runs: (() => void)[] = [];
  let minted = 0;
  const client = createLiveClient({
    channel,
    origin: ORIGIN,
    credentials: async (): Promise<LiveCredentials> => ({ kind: 'ticket', ticket: `ticket-${(minted += 1)}` }),
    open,
    clock: () => AT,
    ids: undefined,
    retry: (_attempt, run) => {
      runs.push(run);
    },
    ...overrides,
  });
  return { client, runs, minted: () => minted };
};

// ---------------------------------------------------------------------------------------------------
// A hub standing in for the server's own, faithfully enough for a client to be wrong against
// ---------------------------------------------------------------------------------------------------

interface Member {
  readonly side: FarSide;
  readonly channel: LiveChannel;
  readonly commands: boolean;
  readonly outbox: Frame[];
  unanswered: number;
  open: boolean;
  /** Frames queued rather than delivered — a context the wire has not caught up to yet. */
  held: boolean;
}

interface Standing {
  readonly stateRevision: number;
  readonly sequence: number;
}

/**
 * `apps/app/src/live-protocol.ts` as a client sees it: one ordered stream, a backlog a resume is replayed
 * from, acknowledgements with the four outcomes, and a beat that drops a session leaving three of them
 * unanswered. It is a fake, but the ordering it keeps is the one that matters — the snapshot a joining
 * connection is written *before* the hub has read the resume that connection sends.
 */
const hub = (options: { readonly backlogFrames?: number; readonly heartbeatLapses?: number } = {}) => {
  const backlogFrames = options.backlogFrames ?? 256;
  const heartbeatLapses = options.heartbeatLapses ?? 3;
  const members = new Set<Member>();
  const joining: Member[] = [];
  const backlog: { sequence: number; stateRevision: number; type: string; at: string }[] = [];
  const landed = new Map<string, Standing>();
  let stateRevision = 0;
  let sequence = 0;
  let holding = false;

  const write = (member: Member, frame: Frame): void => {
    if (!member.open) return;
    if (holding || member.held) member.outbox.push(frame);
    else member.side.deliver(frame);
  };

  const snapshotAt = (member: Member, at: number): Frame => ({
    kind: 'snapshot',
    channel: member.channel,
    stateRevision: backlog.find((change) => change.sequence === at)?.stateRevision ?? at,
    sequence: at,
    at: AT,
  });

  const eventOf = (member: Member, change: { sequence: number; stateRevision: number; type: string }): Frame => ({
    kind: 'event',
    channel: member.channel,
    sequence: change.sequence,
    stateRevision: change.stateRevision,
    type: change.type,
    mutatesState: true,
    at: AT,
  });

  const ackOf = (member: Member, id: string, outcome: string, at: Standing): Frame => ({
    kind: 'ack',
    channel: member.channel,
    id,
    outcome,
    ...(outcome === 'stale' ? { conflictCode: STALE_STATE_REVISION } : {}),
    stateRevision: at.stateRevision,
    sequence: at.sequence,
    at: AT,
  });

  const publish = (type: string): Standing => {
    stateRevision += 1;
    sequence += 1;
    const change = { sequence, stateRevision, type, at: AT };
    backlog.push(change);
    while (backlog.length > backlogFrames) backlog.shift();
    for (const member of [...members]) write(member, eventOf(member, change));
    return { stateRevision, sequence };
  };

  const end = (member: Member, code: number, reason: string): void => {
    if (!member.open) return;
    member.open = false;
    members.delete(member);
    member.side.end(code, reason);
  };

  const resume = (member: Member, from: number): void => {
    const oldest = backlog[0]?.sequence;
    const reachable = from <= sequence && (oldest === undefined || oldest <= from + 1);
    if (!reachable) {
      write(member, snapshotAt(member, sequence));
      return;
    }
    write(member, snapshotAt(member, from));
    for (const change of backlog) if (change.sequence > from) write(member, eventOf(member, change));
  };

  const receive = (member: Member, text: string): void => {
    const frame = JSON.parse(text) as Frame;
    member.unanswered = 0;
    if (frame['kind'] === 'resume') {
      resume(member, Number(frame['fromSequence']));
      return;
    }
    if (frame['kind'] !== 'command') return;
    const id = String(frame['id']);
    if (!member.commands) {
      write(member, ackOf(member, id, 'unauthorized', { stateRevision, sequence }));
      return;
    }
    const already = landed.get(String(frame['idempotencyKey']));
    if (already !== undefined) {
      write(member, ackOf(member, id, 'duplicate', already));
      return;
    }
    if (Number(frame['clientStateRevision']) !== stateRevision) {
      write(member, ackOf(member, id, 'stale', { stateRevision, sequence }));
      return;
    }
    const at = publish(String(frame['type']));
    landed.set(String(frame['idempotencyKey']), at);
    write(member, ackOf(member, id, 'applied', at));
  };

  const memberFor = (channel: LiveChannel): Member => {
    for (const member of members) if (member.channel === channel) return member;
    throw new Error(`nothing is watching ${channel}`);
  };

  return {
    open: (url: string): WebSocketLike => {
      const channel = (new URL(url).searchParams.get(CHANNEL_QUERY) ?? 'audience') as LiveChannel;
      const holder: { member?: Member } = {};
      const side = far(
        url,
        (text) => {
          if (holder.member !== undefined) receive(holder.member, text);
        },
        () => {
          // The context left of its own accord. The hub stops writing to it, and nothing else changes.
          if (holder.member === undefined) return;
          holder.member.open = false;
          members.delete(holder.member);
        },
      );
      const member: Member = {
        side,
        channel,
        commands: channel === LIVE_CONTROL_CHANNEL,
        outbox: [],
        unanswered: 0,
        open: true,
        held: false,
      };
      holder.member = member;
      joining.push(member);
      return side.socket;
    },

    /** Joins whatever is waiting: the hub writes each one its snapshot, *then* the socket opens, and
     *  only then is anything delivered — the order a real connection sees. */
    settle: (): void => {
      holding = true;
      for (const member of joining.splice(0)) {
        members.add(member);
        write(member, snapshotAt(member, sequence));
        member.side.accept();
      }
      holding = false;
      for (const member of [...members]) {
        for (const frame of member.outbox.splice(0)) member.side.deliver(frame);
      }
    },

    publish,

    beat: (): void => {
      for (const member of [...members]) {
        if (member.unanswered >= heartbeatLapses) {
          end(member, LIVE_CLOSE.lapsed, `heartbeat: this session left ${heartbeatLapses} of them unanswered`);
          continue;
        }
        member.unanswered += 1;
        write(member, { kind: 'heartbeat', channel: member.channel, at: AT });
      }
    },

    /** A connection that stopped being one, with no close code worth reading — a network, not a policy. */
    drop: (channel: LiveChannel): void => end(memberFor(channel), 1006, ''),

    /** A socket still open as far as the hub is concerned, but one nothing this context writes reaches. */
    silence: (channel: LiveChannel): void => memberFor(channel).side.vanish(),

    /** Holds everything bound for one context, and lets it go again: a wire one context is behind on,
     *  which is the only way a client is still holding a revision the server has already moved past. */
    withhold: (channel: LiveChannel): void => {
      memberFor(channel).held = true;
    },
    release: (channel: LiveChannel): void => {
      const member = memberFor(channel);
      member.held = false;
      for (const frame of member.outbox.splice(0)) member.side.deliver(frame);
    },

    /** What one context actually put on the wire, which is where a client's own version numbers show. */
    sentOn: (channel: LiveChannel): readonly Frame[] => memberFor(channel).side.sent(),

    /** Everything this deployment knew about where it was, gone: the state a restarted server comes back
     *  with, and the one a client holding a higher sequence than the server has to be corrected out of. */
    restart: (): void => {
      stateRevision = 0;
      sequence = 0;
      backlog.length = 0;
      landed.clear();
      for (const member of [...members]) end(member, 1006, '');
    },

    standing: (): Standing => ({ stateRevision, sequence }),
    watching: (): number => members.size,
    unansweredOn: (channel: LiveChannel): number => memberFor(channel).unanswered,
  };
};

/** Opens a client onto a hub and lets the join settle, which is where most of these tests start. */
const joined = async (
  live: ReturnType<typeof hub>,
  channel: LiveChannel,
  overrides: Partial<LiveClientOptions> = {},
): Promise<ReturnType<typeof clientOn>> => {
  const held = clientOn(channel, live.open, overrides);
  await held.client.connect();
  live.settle();
  return held;
};

const collecting = (client: LiveClient): { events: EventFrame[]; snapshots: LiveSnapshot[] } => {
  const events: EventFrame[] = [];
  const snapshots: LiveSnapshot[] = [];
  client.onEvent((event) => events.push(event));
  client.onSnapshot((snapshot) => snapshots.push(snapshot));
  return { events, snapshots };
};

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------

describe('liveSocketUrl', () => {
  it('opens wss for a page served over https, carrying the channel, the version and the ticket', () => {
    const url = new URL(liveSocketUrl(ORIGIN, 'audience', { kind: 'ticket', ticket: 'ticket-1' }));
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/api/v1/live');
    expect(url.searchParams.get(CHANNEL_QUERY)).toBe('audience');
    expect(url.searchParams.get('clientVersion')).toBe(String(CLIENT_WINDOW.current));
    expect(url.searchParams.get(TICKET_QUERY)).toBe('ticket-1');
  });

  it('opens ws for a page served over http, and carries a capability with the service it opens', () => {
    const url = new URL(
      liveSocketUrl('http://127.0.0.1:3000', 'stage', { kind: 'capability', capability: 'token-1', service: 'service-1' }),
    );
    expect(url.protocol).toBe('ws:');
    expect(url.searchParams.get('capability')).toBe('token-1');
    expect(url.searchParams.get('service')).toBe('service-1');
    expect(url.searchParams.get(TICKET_QUERY)).toBeNull();
  });

  it('declares whichever client version it was given', () => {
    const url = new URL(liveSocketUrl(ORIGIN, 'singer', { kind: 'ticket', ticket: 'ticket-1' }, 99));
    expect(url.searchParams.get('clientVersion')).toBe('99');
  });
});

describe('detectLiveSocket', () => {
  it('finds nothing in a browser that has no WebSocket at all', () => {
    expect(detectLiveSocket({})).toBeUndefined();
  });

  it('opens through the global it was handed', () => {
    const urls: string[] = [];
    const made = far('ws://held.invalid');
    class Fake {
      constructor(url: string) {
        urls.push(url);
        return made.socket as unknown as Fake;
      }
    }
    const open = detectLiveSocket({ WebSocket: Fake as unknown as new (url: string) => WebSocketLike });
    expect(open).toBeDefined();
    expect(open?.('ws://held.invalid')).toBe(made.socket);
    expect(urls).toEqual(['ws://held.invalid']);
  });
});

describe('opening a session', () => {
  it('reports a browser without a WebSocket as a failure nothing retries, rather than throwing', async () => {
    const { client, runs } = clientOn('audience', undefined);
    const status = await client.connect();
    expect(status.state).toBe('closed');
    expect(status.failure).toMatchObject({ reason: 'unsupported', recoverable: false });
    expect(runs).toHaveLength(0);
  });

  it('reports credentials it could not obtain, and opens nothing', async () => {
    const far = sockets();
    const { client, runs } = clientOn('audience', far.open, { credentials: async () => undefined });
    const status = await client.connect();
    expect(status.state).toBe('closed');
    expect(status.failure).toMatchObject({ reason: 'unauthorized', recoverable: false });
    expect(far.opened).toHaveLength(0);
    expect(runs).toHaveLength(0);
  });

  it('reads a rejected credentials promise the same way', async () => {
    const far = sockets();
    const { client } = clientOn('audience', far.open, {
      credentials: async () => {
        throw new Error('this session ended');
      },
    });
    expect((await client.connect()).failure?.reason).toBe('unauthorized');
    expect(far.opened).toHaveLength(0);
  });

  it('tells a listener every state it passes through on its way to synchronised', async () => {
    const live = hub();
    const held = clientOn('audience', live.open);
    const states: string[] = [];
    held.client.onStatus((status) => states.push(status.state));

    await held.client.connect();
    live.settle();

    expect(states).toEqual(['authorizing', 'connecting', 'synchronised']);
  });

  it('reports a socket the browser refused to construct, and tries again', async () => {
    const { client, runs } = clientOn('audience', () => {
      throw new Error('mixed content');
    });
    const status = await client.connect();
    expect(status.state).toBe('degraded');
    expect(status.failure).toMatchObject({ reason: 'open-failed', message: 'mixed content', recoverable: true });
    expect(runs).toHaveLength(1);
  });

  it('reports a refusal that arrived as something other than an Error', async () => {
    const { client } = clientOn('audience', () => {
      throw 'SecurityError' as unknown as Error;
    });
    expect((await client.connect()).failure).toMatchObject({ reason: 'open-failed', message: 'SecurityError' });
  });

  it('adopts the snapshot it joined on and reports itself synchronised', async () => {
    const live = hub();
    live.publish('show-slide');
    live.publish('show-slide');
    const { client } = await joined(live, 'audience');
    expect(client.status).toMatchObject({ state: 'synchronised', stateRevision: 2, sequence: 2 });
  });

  it('tells a listener the first snapshot was not a resynchronisation', async () => {
    const live = hub();
    const held = clientOn('audience', live.open);
    const seen = collecting(held.client);
    await held.client.connect();
    live.settle();
    expect(seen.snapshots).toHaveLength(1);
    expect(seen.snapshots[0]?.resynchronised).toBe(false);
  });

  it('does not open a second socket while it is holding one', async () => {
    const far = sockets();
    const { client } = clientOn('audience', far.open);
    await client.connect();
    await client.connect();
    expect(far.opened).toHaveLength(1);
  });
});

/** A client on a bare socket, for the frames no hub would ever write. */
const bareSocket = async (channel: LiveChannel): Promise<{ client: LiveClient; socket: FarSide }> => {
  const opened = sockets();
  const { client } = clientOn(channel, opened.open);
  await client.connect();
  opened.last().accept();
  return { client, socket: opened.last() };
};

describe('watching a service', () => {
  it('moves both version numbers with every event and hands the event on', async () => {
    const live = hub();
    const held = clientOn('audience', live.open);
    const seen = collecting(held.client);
    await held.client.connect();
    live.settle();

    live.publish('show-slide');
    live.publish('blank');

    expect(seen.events.map((event) => event.type)).toEqual(['show-slide', 'blank']);
    expect(held.client.status).toMatchObject({ stateRevision: 2, sequence: 2 });
  });

  it('answers a heartbeat, so a context that only watches is not dropped as lapsed', async () => {
    const live = hub({ heartbeatLapses: 3 });
    const { client } = await joined(live, 'audience');

    live.beat();
    live.beat();
    live.beat();
    live.beat();

    // Every beat was answered, so the count never climbed and the session is still a member.
    expect(live.unansweredOn('audience')).toBe(0);
    expect(live.watching()).toBe(1);
    expect(client.status.state).toBe('synchronised');
  });

  it('is dropped as lapsed when its answers stop arriving, which is what answering prevents', async () => {
    const live = hub({ heartbeatLapses: 3 });
    const held = await joined(live, 'audience');

    // The socket is still open as far as the hub knows, but nothing written on it arrives any more.
    live.silence('audience');
    live.beat();
    live.beat();
    live.beat();
    live.beat();

    expect(live.watching()).toBe(0);
    expect(held.client.status.state).toBe('degraded');
    expect(held.client.status.failure).toMatchObject({ code: LIVE_CLOSE.lapsed, recoverable: true });
  });

  it('reports a frame that is not JSON without ending the session', async () => {
    const { client, socket } = await bareSocket('audience');
    socket.deliver({ kind: 'snapshot', channel: 'audience', stateRevision: 2, sequence: 2, at: AT });

    socket.deliverRaw('not json at all');

    expect(client.status).toMatchObject({ state: 'synchronised', sequence: 2 });
    expect(client.status.failure).toMatchObject({ reason: 'unreadable-frame', recoverable: true });
    expect(socket.ended()).toBeUndefined();
  });

  it('reports a frame it cannot read, and clears the report on the next frame it can', async () => {
    const { client, socket } = await bareSocket('audience');
    socket.deliver({ kind: 'event', channel: 'audience' });
    expect(client.status.failure?.reason).toBe('unreadable-frame');

    socket.deliver({
      kind: 'event',
      channel: 'audience',
      sequence: 1,
      stateRevision: 1,
      type: 'show-slide',
      mutatesState: true,
      at: AT,
    });
    expect(client.status.failure).toBeUndefined();
    expect(client.status.sequence).toBe(1);
  });

  it('acts on nothing addressed to another channel', async () => {
    const { client, socket } = await bareSocket('audience');
    socket.deliver({ kind: 'snapshot', channel: 'stage', stateRevision: 9, sequence: 9, at: AT });
    expect(client.status).toMatchObject({ sequence: 0, stateRevision: 0 });
    expect(client.status.failure?.message).toContain('this context is connected to audience');
  });

  it('acts on nothing only a client sends', async () => {
    const { client, socket } = await bareSocket('audience');
    socket.deliver({ kind: 'resume', channel: 'audience', fromSequence: 4 });
    expect(client.status.failure?.message).toContain('a server does not send this frame');
    expect(client.status.sequence).toBe(0);
  });

  it('stops telling a listener that unsubscribed', async () => {
    const { client, socket } = await bareSocket('audience');
    const events: EventFrame[] = [];
    const statuses: number[] = [];
    const snapshots: LiveSnapshot[] = [];
    const stopEvents = client.onEvent((event) => events.push(event));
    const stopStatus = client.onStatus((status) => statuses.push(status.sequence));
    const stopSnapshots = client.onSnapshot((snapshot) => snapshots.push(snapshot));
    stopEvents();
    stopStatus();
    stopSnapshots();

    socket.deliver({
      kind: 'event',
      channel: 'audience',
      sequence: 1,
      stateRevision: 1,
      type: 'show-slide',
      mutatesState: true,
      at: AT,
    });
    socket.deliver({ kind: 'snapshot', channel: 'audience', stateRevision: 1, sequence: 1, at: AT });

    expect(events).toHaveLength(0);
    expect(statuses).toHaveLength(0);
    expect(snapshots).toHaveLength(0);
  });
});

describe('commanding', () => {
  it('issues against the revision it holds and resolves with what the server made of it', async () => {
    const live = hub();
    const { client } = await joined(live, LIVE_CONTROL_CHANNEL);

    const ack = await client.command('show-slide', 'key-1');

    expect(ack).toMatchObject({ outcome: 'applied', stateRevision: 1, sequence: 1 });
    expect(client.status).toMatchObject({ stateRevision: 1, sequence: 1 });
  });

  it('is told it may not command on a channel that only watches', async () => {
    const live = hub();
    const { client } = await joined(live, 'audience');
    expect(await client.command('show-slide', 'key-1')).toMatchObject({ outcome: 'unauthorized' });
    expect(live.standing()).toEqual({ stateRevision: 0, sequence: 0 });
  });

  it('is refused as stale when the run moved on before this context heard about it', async () => {
    const live = hub();
    const { client } = await joined(live, LIVE_CONTROL_CHANNEL);
    const { client: audience } = await joined(live, 'audience');

    // The event that would have told this context where the state now is has not reached it yet.
    live.withhold(LIVE_CONTROL_CHANNEL);
    live.publish('show-slide');
    expect(audience.status.stateRevision).toBe(1);
    expect(client.status.stateRevision).toBe(0);

    const refused = client.command('blank', 'key-1');
    expect(live.sentOn(LIVE_CONTROL_CHANNEL).at(-1)).toMatchObject({ clientStateRevision: 0 });
    live.release(LIVE_CONTROL_CHANNEL);

    expect(await refused).toMatchObject({ outcome: 'stale', conflictCode: STALE_STATE_REVISION, stateRevision: 1 });
    expect(client.status.stateRevision).toBe(1);
    expect(live.standing()).toEqual({ stateRevision: 1, sequence: 1 });
  });

  it('adopts the revision a stale refusal names, so the next command is issued against it', async () => {
    const far = sockets();
    const { client } = clientOn(LIVE_CONTROL_CHANNEL, far.open);
    await client.connect();
    const socket = far.last();
    socket.accept();
    socket.deliver({ kind: 'snapshot', channel: LIVE_CONTROL_CHANNEL, stateRevision: 1, sequence: 1, at: AT });

    const refused = client.command('show-slide', 'key-1');
    const sent = socket.sent().at(-1);
    expect(sent).toMatchObject({ clientStateRevision: 1 });
    socket.deliver({
      kind: 'ack',
      channel: LIVE_CONTROL_CHANNEL,
      id: String(sent?.['id']),
      outcome: 'stale',
      conflictCode: STALE_STATE_REVISION,
      stateRevision: 7,
      sequence: 7,
      at: AT,
    });

    expect(await refused).toMatchObject({ outcome: 'stale', conflictCode: STALE_STATE_REVISION });
    expect(client.status).toMatchObject({ stateRevision: 7, sequence: 7 });

    void client.command('show-slide', 'key-2');
    expect(socket.sent().at(-1)).toMatchObject({ clientStateRevision: 7 });
  });

  it('does not walk backwards over an acknowledgement naming where an older command landed', async () => {
    const far = sockets();
    const { client } = clientOn(LIVE_CONTROL_CHANNEL, far.open);
    await client.connect();
    const socket = far.last();
    socket.accept();
    socket.deliver({ kind: 'snapshot', channel: LIVE_CONTROL_CHANNEL, stateRevision: 9, sequence: 9, at: AT });

    const retried = client.command('show-slide', 'key-1');
    socket.deliver({
      kind: 'ack',
      channel: LIVE_CONTROL_CHANNEL,
      id: String(socket.sent().at(-1)?.['id']),
      outcome: 'duplicate',
      stateRevision: 3,
      sequence: 3,
      at: AT,
    });

    expect(await retried).toMatchObject({ outcome: 'duplicate' });
    expect(client.status).toMatchObject({ stateRevision: 9, sequence: 9 });
  });

  it('adopts an acknowledgement no caller is waiting on rather than dropping the numbers on it', async () => {
    const { client, socket } = await bareSocket(LIVE_CONTROL_CHANNEL);
    socket.deliver({
      kind: 'ack',
      channel: LIVE_CONTROL_CHANNEL,
      id: 'command-99',
      outcome: 'applied',
      stateRevision: 4,
      sequence: 4,
      at: AT,
    });
    expect(client.status).toMatchObject({ state: 'synchronised', stateRevision: 4, sequence: 4 });
  });

  it('refuses to send a command the server could not read, rather than losing the session over it', async () => {
    const live = hub();
    const { client } = await joined(live, LIVE_CONTROL_CHANNEL);

    expect(await client.command('Show Slide', 'key-1')).toBeUndefined();
    expect(client.status.state).toBe('synchronised');
    expect(client.status.failure).toMatchObject({ reason: 'unreadable-frame' });
    expect(live.standing()).toEqual({ stateRevision: 0, sequence: 0 });
  });

  it('answers with nothing when there is no socket to send it on', async () => {
    const far = sockets();
    const { client } = clientOn(LIVE_CONTROL_CHANNEL, far.open);
    expect(await client.command('show-slide', 'key-1')).toBeUndefined();

    await client.connect();
    // Opened, but not yet open: a frame written now would be written into nothing.
    expect(await client.command('show-slide', 'key-2')).toBeUndefined();
  });

  it('answers a command the session ended before acknowledging, rather than leaving it hanging', async () => {
    const far = sockets();
    const { client } = clientOn(LIVE_CONTROL_CHANNEL, far.open);
    await client.connect();
    far.last().accept();

    const pending = client.command('show-slide', 'key-1');
    far.last().end(LIVE_CLOSE.lapsed, 'heartbeat: this session left 3 of them unanswered');

    expect(await pending).toBeUndefined();
  });

  it('answers a command a deliberate close cut short', async () => {
    const far = sockets();
    const { client } = clientOn(LIVE_CONTROL_CHANNEL, far.open);
    await client.connect();
    far.last().accept();

    const pending = client.command('show-slide', 'key-1');
    client.close();

    expect(await pending).toBeUndefined();
  });

  it('answers with nothing when the connection failed as the command was written', async () => {
    const far = sockets();
    const { client } = clientOn(LIVE_CONTROL_CHANNEL, far.open);
    await client.connect();
    far.last().accept();
    far.last().vanish();

    expect(await client.command('show-slide', 'key-1')).toBeUndefined();
  });
});

describe('reconnecting', () => {
  it('resumes from the last sequence it saw, on credentials minted for this attempt', async () => {
    const live = hub();
    const held = await joined(live, 'audience');
    const seen = collecting(held.client);
    live.publish('show-slide');
    expect(held.client.status.sequence).toBe(1);

    live.drop('audience');
    expect(held.client.status).toMatchObject({ state: 'degraded' });
    expect(held.client.status.failure).toMatchObject({ reason: 'closed', code: 1006, recoverable: true });

    // Everything this context missed happened while it was away.
    live.publish('blank');
    live.publish('show-slide');

    held.runs.splice(0).forEach((run) => run());
    await Promise.resolve();
    live.settle();

    expect(held.minted()).toBe(2);
    expect(held.client.status).toMatchObject({ state: 'synchronised', sequence: 3, stateRevision: 3 });
    // The join snapshot was skipped, the resume's own was not a resynchronisation, and the two events
    // this context missed arrived in order.
    expect(seen.snapshots.map((snapshot) => snapshot.resynchronised)).toEqual([false]);
    expect(seen.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it('is corrected to where the server stands when the resume cannot be honoured', async () => {
    const live = hub();
    const held = await joined(live, 'audience');
    const seen = collecting(held.client);
    live.publish('show-slide');
    live.publish('blank');
    live.publish('show-slide');
    expect(held.client.status.sequence).toBe(3);

    // The server lost its place, and this context is now holding numbers that never happened.
    live.restart();
    held.runs.splice(0).forEach((run) => run());
    await Promise.resolve();
    live.settle();

    expect(held.client.status).toMatchObject({ state: 'synchronised', sequence: 0, stateRevision: 0 });
    expect(seen.snapshots.map((snapshot) => snapshot.resynchronised)).toEqual([true]);
  });

  it('adopts the snapshot it joined on when the resume it meant to send never left', async () => {
    const opened = sockets();
    const { client, runs } = clientOn('audience', opened.open);
    await client.connect();
    opened.last().accept();
    opened.last().deliver({ kind: 'snapshot', channel: 'audience', stateRevision: 2, sequence: 2, at: AT });
    opened.last().end(1006, '');

    runs.splice(0).forEach((run) => run());
    await Promise.resolve();
    // The replacement connection is already gone by the time it reports itself open, so the resume this
    // context meant to send never goes out — and the snapshot it would have skipped is the only one it
    // is going to get.
    opened.last().vanish();
    opened.last().accept();
    expect(opened.last().sent()).toHaveLength(0);

    opened.last().deliver({ kind: 'snapshot', channel: 'audience', stateRevision: 5, sequence: 5, at: AT });
    expect(client.status).toMatchObject({ state: 'synchronised', stateRevision: 5, sequence: 5 });
  });

  it('reads a close that carried neither a code nor a reason as an ordinary closure', async () => {
    const opened = sockets();
    const { client, runs } = clientOn('audience', opened.open);
    await client.connect();
    opened.last().accept();

    opened.last().endBare();

    expect(client.status.state).toBe('closed');
    expect(client.status.failure).toMatchObject({ code: 1000, message: 'the live session ended', recoverable: false });
    expect(runs).toHaveLength(0);
  });

  it('does not reconnect over a refusal, which a retry would only repeat', async () => {
    const far = sockets();
    const { client, runs } = clientOn('audience', far.open);
    await client.connect();
    far.last().accept();
    far.last().end(LIVE_CLOSE.refused, 'channel: this session may not watch live-control');

    expect(client.status.state).toBe('closed');
    expect(client.status.failure).toMatchObject({ reason: 'closed', code: LIVE_CLOSE.refused, recoverable: false });
    expect(runs).toHaveLength(0);
  });

  it('reconnects over a session the hub dropped as lapsed', async () => {
    const far = sockets();
    const { client, runs } = clientOn('audience', far.open);
    await client.connect();
    far.last().accept();
    far.last().end(LIVE_CLOSE.lapsed, 'heartbeat: this session left 3 of them unanswered');

    expect(client.status.state).toBe('degraded');
    expect(client.status.failure?.recoverable).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it('says a connection failed when the close itself carried no reason', async () => {
    const far = sockets();
    const { client } = clientOn('audience', far.open);
    await client.connect();
    far.last().accept();
    far.last().fail();
    far.last().end(1006, '');

    expect(client.status.failure?.message).toBe('the live connection failed');
  });

  it('backs off further with each attempt, up to a ceiling', () => {
    expect(retryDelayMs(1)).toBe(RETRY_BASE_MS);
    expect(retryDelayMs(2)).toBe(RETRY_BASE_MS * 2);
    expect(retryDelayMs(3)).toBe(RETRY_BASE_MS * 4);
    expect(retryDelayMs(40)).toBe(RETRY_CEILING_MS);
    expect(retryDelayMs(0)).toBe(RETRY_BASE_MS);
  });

  it('puts its own reconnect on a timer when it was given no schedule', async () => {
    vi.useFakeTimers();
    const far = sockets();
    const client = createLiveClient({
      channel: 'audience',
      origin: ORIGIN,
      credentials: async (): Promise<LiveCredentials> => ({ kind: 'ticket', ticket: 'ticket-1' }),
      open: far.open,
    });
    await client.connect();
    far.last().accept();
    // No clock was injected either, so the answer this context sends is timed by its own.
    far.last().deliver({ kind: 'heartbeat', channel: 'audience', at: AT });
    expect(far.last().sent().at(-1)).toMatchObject({ kind: 'heartbeat', channel: 'audience' });
    expect(String(far.last().sent().at(-1)?.['at'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    far.last().end(1006, '');
    expect(far.opened).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);
    expect(far.opened).toHaveLength(2);
  });

  it('forgets nothing and reconnects nothing once a context has left deliberately', async () => {
    const far = sockets();
    const { client, runs } = clientOn('audience', far.open);
    await client.connect();
    far.last().accept();

    client.close();
    expect(far.last().ended()).toMatchObject({ code: 1000 });
    expect(client.status.state).toBe('closed');

    // The socket's own close event arrives afterwards, as a real one does, and changes nothing.
    far.last().end(1000, '');
    expect(client.status.state).toBe('closed');
    expect(runs).toHaveLength(0);
    expect(far.opened).toHaveLength(1);
  });

  it('closes cleanly even when the socket was already gone', async () => {
    const far = sockets();
    const { client } = clientOn('audience', far.open);
    await client.connect();
    far.last().accept();
    far.last().vanish();
    client.close();
    expect(client.status.state).toBe('closed');
  });

  it('can be opened again after it was closed', async () => {
    const live = hub();
    const held = await joined(live, 'audience');
    live.publish('show-slide');
    held.client.close();

    await held.client.connect();
    live.settle();
    expect(held.client.status).toMatchObject({ state: 'synchronised', sequence: 1 });
    expect(held.minted()).toBe(2);
  });
});

describe('several contexts on one device', () => {
  it('coordinates them through the server’s version numbers, never with each other', async () => {
    const live = hub();
    const operator = await joined(live, LIVE_CONTROL_CHANNEL);
    const audience = await joined(live, 'audience');
    const stage = await joined(live, 'stage');
    const seen = [collecting(operator.client), collecting(audience.client), collecting(stage.client)];

    const ack = await operator.client.command('show-slide', 'key-1');

    expect(ack).toMatchObject({ outcome: 'applied', stateRevision: 1, sequence: 1 });
    for (const context of [operator.client, audience.client, stage.client]) {
      expect(context.status).toMatchObject({ state: 'synchronised', stateRevision: 1, sequence: 1 });
    }
    // Each was told by the server, on its own channel, with the same numbers on it.
    expect(seen.map((collected) => collected.events.map((event) => event.channel))).toEqual([
      [LIVE_CONTROL_CHANNEL],
      ['audience'],
      ['stage'],
    ]);
    expect(seen.every((collected) => collected.events.every((event) => event.sequence === 1))).toBe(true);
  });

  it('gives two contexts watching the same channel the same versioned frames, separately', async () => {
    const live = hub();
    const operator = await joined(live, LIVE_CONTROL_CHANNEL);
    // Two windows of the same service open on one device — a second screen and a rehearsal view.
    const first = await joined(live, 'audience');
    const second = await joined(live, 'audience');
    const seen = [collecting(first.client), collecting(second.client)];

    await operator.client.command('show-slide', 'key-1');
    live.publish('blank');

    for (const context of [first.client, second.client]) {
      expect(context.status).toMatchObject({ state: 'synchronised', stateRevision: 2, sequence: 2 });
    }
    for (const collected of seen) {
      expect(collected.events.map((event) => event.sequence)).toEqual([1, 2]);
      expect(collected.events.map((event) => event.type)).toEqual(['show-slide', 'blank']);
    }
    // Each holds a session of its own: three of them, and neither audience context is where it is
    // because of the other.
    expect(live.watching()).toBe(3);
    expect(seen.every((collected) => collected.snapshots.length === 0)).toBe(true);
  });

  it('leaves the others and the run untouched when one context closes', async () => {
    const live = hub();
    const operator = await joined(live, LIVE_CONTROL_CHANNEL);
    const audience = await joined(live, 'audience');
    const stage = await joined(live, 'stage');
    const watched = collecting(stage.client);
    const left = collecting(audience.client);

    audience.client.close();
    expect(live.watching()).toBe(2);

    const ack = await operator.client.command('show-slide', 'key-1');
    live.publish('blank');

    expect(ack).toMatchObject({ outcome: 'applied' });
    expect(operator.client.status).toMatchObject({ state: 'synchronised', sequence: 2 });
    expect(stage.client.status).toMatchObject({ state: 'synchronised', sequence: 2 });
    expect(watched.events).toHaveLength(2);
    // The context that left heard none of it, and asked for none of it back.
    expect(left.events).toHaveLength(0);
    expect(audience.client.status).toMatchObject({ state: 'closed', sequence: 0 });
    expect(audience.runs).toHaveLength(0);
  });

  it('corrects one diverged context without moving any of the others', async () => {
    const live = hub();
    const operator = await joined(live, LIVE_CONTROL_CHANNEL);
    const audience = await joined(live, 'audience');
    live.publish('show-slide');
    live.publish('blank');

    // One context's connection drops and stays down while the run carries on without it.
    live.drop('audience');
    live.publish('show-slide');
    expect(operator.client.status.sequence).toBe(3);
    expect(audience.client.status).toMatchObject({ state: 'degraded', sequence: 2 });

    audience.runs.splice(0).forEach((run) => run());
    await Promise.resolve();
    live.settle();

    expect(audience.client.status).toMatchObject({ state: 'synchronised', sequence: 3, stateRevision: 3 });
    // The other context was neither interrupted nor resynchronised by any of it.
    expect(operator.client.status).toMatchObject({ state: 'synchronised', sequence: 3, stateRevision: 3 });
    expect(live.watching()).toBe(2);
  });

  it('holds one session each, so one falling behind is not the other falling behind', async () => {
    const live = hub();
    const operator = await joined(live, LIVE_CONTROL_CHANNEL);
    const audience = await joined(live, 'audience');

    live.drop('audience');
    live.publish('show-slide');
    live.publish('blank');

    expect(operator.client.status).toMatchObject({ state: 'synchronised', sequence: 2 });
    expect(audience.client.status).toMatchObject({ state: 'degraded', sequence: 0 });
    expect(operator.client.status.failure).toBeUndefined();
  });
});
