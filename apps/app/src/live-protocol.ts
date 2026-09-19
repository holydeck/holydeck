// What a live session actually is, apart from the socket it travels over: one ordered stream of state
// changes, a window of it held back so a client that dropped can be caught up exactly, and the rules
// deciding which sessions may watch which channel, which may command, and what becomes of one that stops
// answering or falls behind. None of that needs a socket to be true, so none of it is written against one
// — `live.ts` adapts a real connection to the transport below, and a test adapts an array.
//
// Two numbers run through all of it and are deliberately not the same number. The *state revision* counts
// how many times the live state has moved, and is what a command is issued against: a client holding an
// old one is holding an answer to a question the state has since changed. The *sequence* numbers the
// frames a session was sent, and is what a resume is measured from. They advance together here because
// every change published in this milestone moves the state, but a client reads them for different
// reasons, and a later task publishing something that changes nothing will move only the second.
//
// (Neither is `conflicts.ts`'s `sequence`, which orders what sits on a shelf and never leaves the server.)

import { STALE_STATE_REVISION } from '@holydeck/contracts/http';
import {
  LIVE_CHANNELS,
  LIVE_CLOSE,
  MAX_CLOSE_REASON,
  OUTPUT_CHANNELS,
  parseFrame,
} from '@holydeck/contracts/live';

import { PRESENTATION_CONTROL } from './roles.js';

import type {
  AckFrame,
  AckOutcome,
  EventFrame,
  HeartbeatFrame,
  LiveChannel,
  LiveFrame,
  SnapshotFrame,
} from '@holydeck/contracts/live';

/**
 * The far side of a live session, reduced to the three things this protocol needs of it: write a frame,
 * end the session with a code and a reason, and say how much is still waiting to reach the peer. The
 * third is what tells a consumer that cannot keep up apart from one that simply has nothing to read.
 */
export interface LiveTransport {
  send(text: string): void;
  close(code: number, reason: string): void;
  buffered(): number;
}

/** What one session may reach: the channels it may watch, and whether it may move the state at all. */
export interface LiveGrant {
  readonly watch: readonly LiveChannel[];
  readonly command: boolean;
}

/**
 * Control presentation is the whole of the difference. It opens the channel a service is run from — the
 * only one carrying what an operator does before anyone sees it — and it is the authority to command.
 * Everything else, including a session holding every other permission this deployment grants, watches
 * the surfaces a service is shown on and commands nothing.
 */
export function grantFor(permissions: readonly string[]): LiveGrant {
  return permissions.includes(PRESENTATION_CONTROL)
    ? Object.freeze({ watch: LIVE_CHANNELS, command: true })
    : Object.freeze({ watch: OUTPUT_CHANNELS, command: false });
}

export interface LiveHubOptions {
  /** Explicit, so a frame's time is the session's time and a test does not have to read a clock. */
  readonly clock: () => string;
  /** How far back a resume can reach. Past it a client is resynchronised rather than handed a gap. */
  readonly backlogFrames?: number;
  /** How far behind a session may fall before it is ended as a consumer this deployment cannot serve. */
  readonly pendingFrames?: number;
  /** How much a transport may already be holding before a frame is queued instead of written. */
  readonly highWaterBytes?: number;
  /** How many heartbeats a session may leave unanswered before it is treated as gone. */
  readonly heartbeatLapses?: number;
  /** How many commands are remembered by their idempotency key, so a retry is answered and not re-run. */
  readonly rememberedCommands?: number;
}

/** One live session, from the hub's side: what it says, and the moment it stops being one. */
export interface LiveConnection {
  receive(raw: string): void;
  leave(): void;
}

export interface LiveHub {
  /** How many times the live state has moved. What a command is issued against. */
  stateRevision(): number;
  /** The last frame number published. What a resume is measured from. */
  sequence(): number;
  /** Opens a session, or refuses it and answers nothing when the channel is outside what it may watch. */
  join(transport: LiveTransport, channel: LiveChannel, grant: LiveGrant): LiveConnection | undefined;
  /** One beat: drains whatever a transport had room for, then asks every session whether it is still there. */
  tick(): void;
}

const DEFAULTS = {
  backlogFrames: 256,
  pendingFrames: 32,
  highWaterBytes: 64 * 1024,
  heartbeatLapses: 3,
  rememberedCommands: 256,
} as const;

/** One published change, held for as long as the backlog window reaches, so it can be replayed. */
interface Change {
  readonly sequence: number;
  readonly stateRevision: number;
  readonly type: string;
  readonly at: string;
}

/** Where a command left the state, which is the whole of what a replay of it has to be answered with. */
interface Landed {
  readonly stateRevision: number;
  readonly sequence: number;
}

interface Member {
  readonly transport: LiveTransport;
  readonly channel: LiveChannel;
  readonly grant: LiveGrant;
  /** Frames the transport had no room for, in the order they were published. Never reordered. */
  readonly pending: string[];
  /** Heartbeats sent since this session last said anything at all. */
  unanswered: number;
  open: boolean;
}

export function liveHub(options: LiveHubOptions): LiveHub {
  const { clock } = options;
  const backlogFrames = options.backlogFrames ?? DEFAULTS.backlogFrames;
  const pendingFrames = options.pendingFrames ?? DEFAULTS.pendingFrames;
  const highWaterBytes = options.highWaterBytes ?? DEFAULTS.highWaterBytes;
  const heartbeatLapses = options.heartbeatLapses ?? DEFAULTS.heartbeatLapses;
  const rememberedCommands = options.rememberedCommands ?? DEFAULTS.rememberedCommands;

  const members = new Set<Member>();
  const backlog: Change[] = [];
  // Keyed by a value that arrived off the wire, which is why this is a Map: a client naming
  // `__proto__` as its idempotency key has to find nothing rather than find an inherited member.
  // Insertion order is also the eviction order, which is what keeps the oldest key the first forgotten.
  const landed = new Map<string, Landed>();

  let stateRevision = 0;
  let sequence = 0;

  const forget = (member: Member): void => {
    member.open = false;
    members.delete(member);
  };

  /** Ends a session this server is ending, saying why in the little room a close frame leaves for it. */
  const end = (member: Member, code: number, reason: string): void => {
    if (!member.open) return;
    forget(member);
    member.transport.close(code, reason.slice(0, MAX_CLOSE_REASON));
  };

  /**
   * Writes everything queued that the transport now has room for. A transport still holding more than the
   * high-water mark is not written into at all: pushing more at a peer that is not reading is how a
   * server's own memory becomes the place a slow consumer's backlog lives.
   */
  const flush = (member: Member): void => {
    while (member.open && member.pending.length > 0 && member.transport.buffered() <= highWaterBytes) {
      const text = member.pending.shift();
      if (text === undefined) return;
      try {
        member.transport.send(text);
      } catch {
        // The connection is gone and said so by failing, which is what a network loss looks like from
        // here. Nothing is closed — there is nothing left to close — and every other session carries on.
        forget(member);
        return;
      }
    }
    if (member.open && member.pending.length > pendingFrames) {
      end(member, LIVE_CLOSE.overloaded, `backpressure: this session fell further behind than ${pendingFrames} frames`);
    }
  };

  const write = (member: Member, frame: LiveFrame): void => {
    if (!member.open) return;
    member.pending.push(JSON.stringify(frame));
    flush(member);
  };

  /**
   * The revision that was actually current at a given sequence, recovered from the backlog Change that
   * carries it rather than read off the hub's own present standing — which is a different number as soon
   * as anything has published since, and would hand a resumed client a wire that jumps the revision
   * forward at the snapshot and then backward through the events replayed after it.
   */
  const revisionAt = (at: number): number => backlog.find((change) => change.sequence === at)?.stateRevision ?? stateRevision;

  const snapshotAt = (channel: LiveChannel, at: number): SnapshotFrame => ({
    kind: 'snapshot',
    channel,
    stateRevision: revisionAt(at),
    sequence: at,
    at: clock(),
  });

  const eventOf = (channel: LiveChannel, change: Change): EventFrame => ({
    kind: 'event',
    channel,
    sequence: change.sequence,
    stateRevision: change.stateRevision,
    type: change.type,
    mutatesState: true,
    at: change.at,
  });

  const ackOf = (member: Member, id: string, outcome: AckOutcome, at: Landed): AckFrame => {
    const base = {
      kind: 'ack' as const,
      channel: member.channel,
      id,
      outcome,
      stateRevision: at.stateRevision,
      sequence: at.sequence,
      at: clock(),
    };
    return outcome === 'stale' ? { ...base, conflictCode: STALE_STATE_REVISION } : base;
  };

  const beatOn = (channel: LiveChannel): HeartbeatFrame => ({ kind: 'heartbeat', channel, at: clock() });

  /** Where the hub stands right now, which is what every refused command is answered with. */
  const standing = (): Landed => ({ stateRevision, sequence });

  const publish = (type: string): Landed => {
    stateRevision += 1;
    sequence += 1;
    const change: Change = { sequence, stateRevision, type, at: clock() };
    backlog.push(change);
    while (backlog.length > backlogFrames) backlog.shift();
    // Copied before it is walked, because serving one member can end another's session, and a set
    // being written to while it is read is how a live run starts losing frames nobody asked it to lose.
    for (const member of [...members]) write(member, eventOf(member.channel, change));
    return { stateRevision, sequence };
  };

  const remember = (key: string, at: Landed): void => {
    landed.set(key, at);
    while (landed.size > rememberedCommands) {
      const oldest = landed.keys().next();
      if (oldest.done === true) return;
      landed.delete(oldest.value);
    }
  };

  const command = (member: Member, frame: LiveFrame & { kind: 'command' }): void => {
    if (!member.grant.command) {
      // Answered rather than closed: a surface that mistakenly asks to command is still a surface an
      // audience is watching, and ending its session would take the service off a screen over a mistake.
      write(member, ackOf(member, frame.id, 'unauthorized', standing()));
      return;
    }
    // Asked before staleness, deliberately. A client retrying a command it never saw acknowledged
    // retries the frame it sent, revision and all, and that revision is behind by exactly the change
    // its own first attempt made. Judging it stale first would refuse every successful retry there is.
    const already = landed.get(frame.idempotencyKey);
    if (already !== undefined) {
      write(member, ackOf(member, frame.id, 'duplicate', already));
      return;
    }
    if (frame.clientStateRevision !== stateRevision) {
      write(member, ackOf(member, frame.id, 'stale', standing()));
      return;
    }
    const at = publish(frame.type);
    remember(frame.idempotencyKey, at);
    write(member, ackOf(member, frame.id, 'applied', at));
  };

  const resume = (member: Member, fromSequence: number): void => {
    const oldest = backlog[0]?.sequence;
    // Reachable only when everything after `fromSequence` is still held, and when that sequence is one
    // this server actually issued. Anything else is answered by moving the client to where the server
    // stands, which it can see it has done, rather than by a replay with a hole in the middle of it.
    const reachable = fromSequence <= sequence && (oldest === undefined || oldest <= fromSequence + 1);
    if (!reachable) {
      write(member, snapshotAt(member.channel, sequence));
      return;
    }
    write(member, snapshotAt(member.channel, fromSequence));
    for (const change of backlog) {
      if (change.sequence > fromSequence) write(member, eventOf(member.channel, change));
    }
  };

  const receive = (member: Member, raw: string): void => {
    if (!member.open) return;
    // Anything at all from this session proves it is still there, whatever the frame turns out to be.
    member.unanswered = 0;

    let sent: unknown;
    try {
      sent = JSON.parse(raw);
    } catch {
      end(member, LIVE_CLOSE.unreadable, 'frame: must be JSON');
      return;
    }
    const parsed = parseFrame(sent);
    if (!parsed.ok) {
      // Every problem the parser found, in the order it found them, because a client fixing a frame
      // wants the whole list and not the first item of it.
      end(member, LIVE_CLOSE.unreadable, parsed.problems.map(({ path, message }) => `${path}: ${message}`).join('; '));
      return;
    }
    const frame = parsed.value;
    if (frame.channel !== member.channel) {
      end(member, LIVE_CLOSE.refused, `${frame.kind}.channel: this session is connected to ${member.channel}`);
      return;
    }
    if (frame.kind === 'heartbeat') return;
    if (frame.kind === 'resume') {
      resume(member, frame.fromSequence);
      return;
    }
    if (frame.kind === 'command') {
      command(member, frame);
      return;
    }
    // A snapshot, an event or an acknowledgement arriving from a client is not a mistake to be forgiven
    // quietly: it means the two ends disagree about which of them is the server.
    end(member, LIVE_CLOSE.refused, `${frame.kind}: a client does not send this frame`);
  };

  return Object.freeze({
    stateRevision: (): number => stateRevision,
    sequence: (): number => sequence,

    join: (transport: LiveTransport, channel: LiveChannel, grant: LiveGrant): LiveConnection | undefined => {
      if (!grant.watch.includes(channel)) {
        transport.close(LIVE_CLOSE.refused, `channel: this session may not watch ${channel}`.slice(0, MAX_CLOSE_REASON));
        return undefined;
      }
      const member: Member = { transport, channel, grant, pending: [], unanswered: 0, open: true };
      members.add(member);
      write(member, snapshotAt(channel, sequence));
      return Object.freeze({
        receive: (raw: string): void => receive(member, raw),
        leave: (): void => forget(member),
      });
    },

    tick: (): void => {
      for (const member of [...members]) {
        flush(member);
        if (!member.open) continue;
        if (member.unanswered >= heartbeatLapses) {
          end(member, LIVE_CLOSE.lapsed, `heartbeat: this session left ${heartbeatLapses} of them unanswered`);
          continue;
        }
        member.unanswered += 1;
        write(member, beatOn(member.channel));
      }
    },
  });
}
