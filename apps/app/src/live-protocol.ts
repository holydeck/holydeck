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
  LIVE_CONTROL_CHANNEL,
  MAX_CLOSE_REASON,
  OUTPUT_CHANNELS,
  parseFrame,
} from '@holydeck/contracts/live';

import { LIVE_EVENT_TYPES } from './live-events.js';
import { PRESENTATION_CONTROL } from './roles.js';

import type {
  AckFrame,
  AckOutcome,
  CommandFrame,
  EventFrame,
  HeartbeatFrame,
  LiveChannel,
  LiveFrame,
  OutputChannel,
  SnapshotFrame,
} from '@holydeck/contracts/live';
import type { ChannelState } from '@holydeck/contracts/live-state';

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

/** The authority and identity command policy needs, without socket bookkeeping. */
export interface LiveMember {
  readonly channel: LiveChannel;
  readonly grant: LiveGrant;
  readonly identity?: string;
}

/** What one session may reach: the channels it may watch, and whether it may move the state at all. */
export interface LiveGrant {
  readonly watch: readonly LiveChannel[];
  readonly command: boolean;
  readonly capabilityId?: string;
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

const grantForView = (view: OutputChannel): LiveGrant => Object.freeze({ watch: [view], command: false });

/**
 * The counterpart to `grantFor` above for a session that carries no permission at all, only a capability
 * (`capabilities.ts`'s `CapabilityView` — a guest's or an output window's) scoped to one view. Where
 * `grantFor([])` opens every output surface to a session identified by nothing, this opens exactly the
 * one channel the capability was issued for and none other: an audience capability reaches `audience`,
 * never `stage` or `singer`, whatever else this deployment is showing. `Record<OutputChannel, …>` is
 * declared, not derived from `OUTPUT_CHANNELS` at runtime, so a channel this contract adds has to be
 * added here too — the type checker refuses a build that leaves one out, the way this deployment once
 * left `singer` out of `capabilities.ts`.
 */
export const VIEW_GRANTS: Readonly<Record<OutputChannel, LiveGrant>> = Object.freeze({
  audience: grantForView('audience'),
  stage: grantForView('stage'),
  singer: grantForView('singer'),
});

/**
 * What an operator may know about a connection beyond how many there are of it (spec 9.3/9.5, LIVE-06):
 * which kind of view it is watching, and never anything that could identify who. `guest` stands apart
 * from `audience` on purpose — a capability-scoped Guest is exactly the thing spec 9.5 asks an operator
 * to see the shape of without ever seeing the identity of, collapsed to one count whichever output
 * channel the capability happened to be scoped to, since nothing about a Guest connection is meant to
 * be told apart any further than that.
 */
export const CONNECTION_VIEW_TYPES = ['control', 'audience', 'guest', 'stage', 'singer'] as const;
export type ConnectionViewType = (typeof CONNECTION_VIEW_TYPES)[number];

/** How many connections are open right now, by view type and nothing narrower — the whole of what
 *  `LiveHub.connectionCounts()` answers an operator with. */
export type ConnectionCounts = Readonly<Record<ConnectionViewType, number>>;

/** A Guest connection is told apart by how it was admitted, never by which channel it happened to land
 *  on; every other connection is exactly the channel it is watching. */
const viewTypeOf = (channel: LiveChannel, guest: boolean): ConnectionViewType =>
  channel === LIVE_CONTROL_CHANNEL ? 'control' : guest ? 'guest' : channel;

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
  seedStateRevision(value: number): void;
  useCommands(handler: (member: LiveMember, frame: CommandFrame) => Promise<{ readonly outcome: AckOutcome; readonly conflictCode?: string }>): void;
  /** How many times the live state has moved. What a command is issued against. */
  stateRevision(): number;
  /** The last frame number published. What a resume is measured from. */
  sequence(): number;
  /**
   * Opens a session, or refuses it and answers nothing when the channel is outside what it may watch.
   * `guest` is true only for a connection admitted through a capability rather than a session (T81) —
   * the one thing that tells a Guest's count apart from an ordinary Audience one, since the grant shape
   * alone does not.
   */
  join(transport: LiveTransport, channel: LiveChannel, grant: LiveGrant, guest?: boolean, clientId?: string): LiveConnection | undefined;
  /** How many sessions are open right now, by view type only — never anything that could identify one
   *  of them (spec 9.5, LIVE-06). A lapsed or left connection stops counting the same instant it stops
   *  being a member, because this reads the same set every other operation here does. */
  connectionCounts(): ConnectionCounts;
  /**
   * Announces a change no client commanded — a domain module's own state moved on its own authority, not
   * a live-control session's. `command()` is the client-facing door onto the same movement; this is the
   * server-facing one, for `live-events.ts`'s four change classes and whatever `runs.ts` and later tasks
   * publish through it. Every joined session, on every channel, is written the resulting event.
   */
  publish(type: string): Landed;
  /**
   * The channel-aware counterpart to `publish` (RUN-02/LIVE-04): reaches only the members of `channel`,
   * carrying whatever `stateFor(channel)` projects for it — never a wider audience computing its own
   * projection from a frame meant for someone else, which is what keeps privacy enforced on the wire
   * (Design §2) rather than trusted to every reader of one. `stateFor` takes the channel it is asked
   * about, not just `channel` back, so one projector can serve every `publishTo` call a change needs
   * without a caller writing one closure per channel.
   *
   * Nothing is published, and the hub does not move, when `stateFor(channel)` answers `undefined`: a
   * channel a change has nothing to say to is not a change that channel saw, and `stateRevision`/
   * `sequence` count only what was actually landed.
   */
  publishTo(channel: LiveChannel, type: string, stateFor: (channel: LiveChannel) => ChannelState | undefined): Landed;
  /**
   * One change the run engine made, landed once however many channels it reaches (RUN-01/RUN-03): the
   * revision moves by one per command, not once per channel told about it, which is what keeps this hub's
   * revision the run's persisted one (Design §4). Each channel named in `states` is sent that state; the
   * hub remembers it as what the channel now shows, so a snapshot on join, resume or a gap carries it.
   * `everyone` also reaches the channels left out of `states` — and clears what they show, which is what
   * a run starting or ending means for a view. `stateRevision`, when given, is the revision the caller
   * just persisted; the hub never moves backward to it.
   */
  publishChange(change: LiveChange): Landed;
  /** Seeds what each channel shows, before any change has landed — a restarted process's first snapshot. */
  seedStates(states: Partial<Record<LiveChannel, ChannelState>>): void;
  revokeCapability(capabilityId: string | undefined): void;
  /** One beat: drains whatever a transport had room for, then asks every session whether it is still there. */
  tick(): void;
}

export const RESUME_INTERVAL_MS = 5_000;

const PUBLIC_COMMAND_TYPES = new Set<string>(Object.values(LIVE_EVENT_TYPES));

const DEFAULTS = {
  backlogFrames: 256,
  pendingFrames: 32,
  highWaterBytes: 64 * 1024,
  heartbeatLapses: 3,
  rememberedCommands: 256,
} as const;

/** What `LiveHub.publishChange` lands. */
export interface LiveChange {
  readonly type: string;
  readonly states: Partial<Record<LiveChannel, ChannelState>>;
  readonly everyone?: boolean;
  readonly stateRevision?: number;
}

/** One published change, held for as long as the backlog window reaches, so it can be replayed. */
interface Change {
  readonly sequence: number;
  readonly stateRevision: number;
  /** The revision standing just before this change — what a snapshot at the sequence before it reports. */
  readonly previousRevision: number;
  readonly type: string;
  readonly at: string;
  /** The channels this change was addressed to. A resume replays a change only to those (RUN-03/RUN-04):
   *  an audience member must never be replayed what was only ever sent to stage and control. */
  readonly channels: ReadonlySet<LiveChannel>;
  /** The state each addressed channel was sent, replayed with the change exactly as it went out live. */
  readonly states: Partial<Record<LiveChannel, ChannelState>>;
  /** Whether this change set what its channels show (every `publishChange`), or only announced a type. */
  readonly stateful: boolean;
  /** What each addressed channel showed just before this change, so a snapshot at an earlier sequence
   *  carries what was true at that sequence rather than what is true now. */
  readonly before: Partial<Record<LiveChannel, ChannelState>>;
}

/** Where a command left the state, which is the whole of what a replay of it has to be answered with. */
export interface Landed {
  readonly stateRevision: number;
  readonly sequence: number;
}

interface Member {
  readonly transport: LiveTransport;
  readonly channel: LiveChannel;
  readonly grant: LiveGrant;
  readonly capabilityId: string | undefined;
  readonly identity: string | undefined;
  /** Fixed at join, from the channel and whether this connection was a capability's rather than a
   *  session's — what `connectionCounts()` groups by. */
  readonly viewType: ConnectionViewType;
  /** Frames the transport had no room for, in the order they were published. Never reordered. */
  readonly pending: string[];
  /** Heartbeats sent since this session last said anything at all. */
  unanswered: number;
  resumeAfter: number;
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

  /** What each channel shows right now — the state a snapshot at the present sequence carries. */
  const current = new Map<LiveChannel, ChannelState>();

  let commandHandler: Parameters<LiveHub['useCommands']>[0] | undefined;
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
        // A failed write may leave the transport open. Close it best-effort before forgetting it.
        try {
          member.transport.close(LIVE_CLOSE.overloaded, 'transport: this session could not be written to');
        } catch {
          // A broken transport may also fail to close; every other session must still carry on.
        }
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
   * The revision that was actually current at a given sequence, recovered from the backlog rather than
   * read off the hub's own present standing — which is a different number as soon as anything has
   * published since, and would hand a resumed client a wire that jumps the revision forward at the
   * snapshot and then backward through the events replayed after it. Revision and sequence do not move
   * one for one (a restarted process seeds the persisted revision; a sequence restarts at zero), so the
   * revision at a sequence is the one the next change after it started from.
   */
  const revisionAt = (at: number): number =>
    at >= sequence ? stateRevision : backlog.find((change) => change.sequence > at)?.previousRevision ?? stateRevision;

  /** What `channel` showed at sequence `at`: the state the first later change replaced, or today's. */
  const stateAt = (channel: LiveChannel, at: number): ChannelState | undefined => {
    const later = backlog.find((change) => change.sequence > at && change.stateful && change.channels.has(channel));
    return later === undefined ? current.get(channel) : later.before[channel];
  };

  const stateFor = (channel: LiveChannel, at: number): { readonly state?: ChannelState } => {
    const state = stateAt(channel, at);
    return state === undefined ? {} : { state };
  };

  const snapshotAt = (channel: LiveChannel, at: number): SnapshotFrame => ({
    kind: 'snapshot',
    channel,
    stateRevision: revisionAt(at),
    sequence: at,
    at: clock(),
    ...stateFor(channel, at),
  });

  const eventOf = (channel: LiveChannel, change: Change, state = change.states[channel]): EventFrame => ({
    kind: 'event',
    channel,
    sequence: change.sequence,
    stateRevision: change.stateRevision,
    type: change.type,
    mutatesState: true,
    at: change.at,
    ...(state === undefined ? {} : { state }),
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

  /** Lands one change — the counters and the backlog entry every published frame is built from — shared
   *  by every way a change reaches a member, so none of them drift apart on it. */
  const land = (
    type: string,
    channels: ReadonlySet<LiveChannel>,
    states: Partial<Record<LiveChannel, ChannelState>> = {},
    stateful = false,
    revision?: number,
  ): Change => {
    const previousRevision = stateRevision;
    stateRevision = Math.max(stateRevision + 1, revision ?? 0);
    sequence += 1;
    const before: Partial<Record<LiveChannel, ChannelState>> = {};
    if (stateful) {
      for (const channel of channels) {
        const was = current.get(channel);
        if (was !== undefined) before[channel] = was;
        const now = states[channel];
        if (now === undefined) current.delete(channel);
        else current.set(channel, now);
      }
    }
    const change: Change = { sequence, stateRevision, previousRevision, type, at: clock(), channels, states, stateful, before };
    backlog.push(change);
    while (backlog.length > backlogFrames) backlog.shift();
    return change;
  };

  const deliver = (change: Change): Landed => {
    // Copied before it is walked, because serving one member can end another's session, and a set
    // being written to while it is read is how a live run starts losing frames nobody asked it to lose.
    for (const member of [...members]) {
      if (change.channels.has(member.channel)) write(member, eventOf(member.channel, change));
    }
    return { stateRevision, sequence };
  };

  const publish = (type: string): Landed => deliver(land(type, new Set(LIVE_CHANNELS)));

  const publishTo = (
    channel: LiveChannel,
    type: string,
    stateFor: (channel: LiveChannel) => ChannelState | undefined,
  ): Landed => {
    const state = stateFor(channel);
    if (state === undefined) return standing();
    return deliver(land(type, new Set([channel]), { [channel]: state }, true));
  };

  const publishChange = ({ type, states, everyone = false, stateRevision: revision }: LiveChange): Landed => {
    const channels = new Set<LiveChannel>(everyone ? LIVE_CHANNELS : LIVE_CHANNELS.filter((channel) => states[channel] !== undefined));
    return deliver(land(type, channels, states, true, revision));
  };

  const remember = (key: string, at: Landed): void => {
    landed.set(key, at);
    while (landed.size > rememberedCommands) {
      const oldest = landed.keys().next();
      if (oldest.done === true) return;
      landed.delete(oldest.value);
    }
  };

  const landedKey = (member: Member, key: string): string => `${member.identity ?? ''} ${key}`;

  /**
   * The one delegated command running at a time. Commands wait their turn rather than overlapping: a
   * client retrying a frame it never saw acknowledged sends the same idempotency key while the first
   * attempt may still be in flight, and only a retry that starts after the first finished can find that
   * key remembered. Serial order is also what a single operator desk means by "one change after another".
   */
  let commands: Promise<void> = Promise.resolve();

  const delegate = async (
    member: Member,
    frame: CommandFrame,
    handler: NonNullable<typeof commandHandler>,
  ): Promise<void> => {
    if (!member.open) return;
    const already = landed.get(landedKey(member, frame.idempotencyKey));
    if (already !== undefined) {
      write(member, ackOf(member, frame.id, 'duplicate', already));
      return;
    }
    // LIVE-05: a command issued against a revision that has since moved is refused, and the client is
    // handed where things stand so it can decide again. Asked after the duplicate check for the reason
    // the legacy path below gives, and inside the queue so the revision compared is the settled one.
    if (frame.clientStateRevision !== stateRevision) {
      write(member, ackOf(member, frame.id, 'stale', standing()));
      write(member, snapshotAt(member.channel, sequence));
      return;
    }
    const liveMember: LiveMember = { channel: member.channel, grant: member.grant, identity: member.identity };
    let outcome: AckOutcome;
    try {
      ({ outcome } = await handler(liveMember, frame));
    } catch {
      // Nothing waits on this chain to hand a rejection to, and an unhandled one ends the whole process —
      // every view of the run, not just this command. A handler that threw moved nothing it could vouch
      // for, so it is answered the way any other command that could not be carried out is.
      outcome = 'failed';
    }
    if (!member.open) return;
    const at = standing();
    if (outcome === 'applied') remember(landedKey(member, frame.idempotencyKey), at);
    write(member, ackOf(member, frame.id, outcome, at));
    if (outcome === 'stale') write(member, snapshotAt(member.channel, sequence));
  };

  const command = (member: Member, frame: CommandFrame): void => {
    // Only the control channel steers a run (Design §5). A stage, singer or guest session holding a
    // command grant is still a screen somebody is watching, so it is answered rather than closed.
    if (!member.grant.command || member.channel !== LIVE_CONTROL_CHANNEL) {
      write(member, ackOf(member, frame.id, 'unauthorized', standing()));
      return;
    }
    if (commandHandler !== undefined) {
      const handler = commandHandler;
      commands = commands.then(() => delegate(member, frame, handler));
      return;
    }
    // Asked before staleness, deliberately. A client retrying a command it never saw acknowledged
    // retries the frame it sent, revision and all, and that revision is behind by exactly the change
    // its own first attempt made. Judging it stale first would refuse every successful retry there is.
    const already = landed.get(landedKey(member, frame.idempotencyKey));
    if (already !== undefined) {
      write(member, ackOf(member, frame.id, 'duplicate', already));
      return;
    }
    if (!PUBLIC_COMMAND_TYPES.has(frame.type)) {
      write(member, ackOf(member, frame.id, 'unauthorized', standing()));
      return;
    }
    if (frame.clientStateRevision !== stateRevision) {
      write(member, ackOf(member, frame.id, 'stale', standing()));
      return;
    }
    const at = publish(frame.type);
    remember(landedKey(member, frame.idempotencyKey), at);
    write(member, ackOf(member, frame.id, 'applied', at));
  };

  const resume = (member: Member, fromSequence: number): void => {
    const now = Date.parse(clock());
    if (now < member.resumeAfter) return;
    member.resumeAfter = now + RESUME_INTERVAL_MS;
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
      if (change.sequence > fromSequence && change.channels.has(member.channel)) write(member, eventOf(member.channel, change));
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
    seedStateRevision: (value: number): void => { stateRevision = Math.max(stateRevision, value); },
    useCommands: (handler: Parameters<LiveHub['useCommands']>[0]): void => { commandHandler = handler; },
    stateRevision: (): number => stateRevision,
    sequence: (): number => sequence,

    join: (transport: LiveTransport, channel: LiveChannel, grant: LiveGrant, guest = false, clientId?: string): LiveConnection | undefined => {
      if (!grant.watch.includes(channel)) {
        transport.close(LIVE_CLOSE.refused, `channel: this session may not watch ${channel}`.slice(0, MAX_CLOSE_REASON));
        return undefined;
      }
      const member: Member = {
        transport,
        channel,
        grant,
        capabilityId: grant.capabilityId,
        identity: grant.capabilityId ?? clientId,
        viewType: viewTypeOf(channel, guest),
        pending: [],
        unanswered: 0,
        resumeAfter: -Infinity,
        open: true,
      };
      members.add(member);
      write(member, snapshotAt(channel, sequence));
      return Object.freeze({
        receive: (raw: string): void => receive(member, raw),
        leave: (): void => forget(member),
      });
    },

    connectionCounts: (): ConnectionCounts => {
      const counts: Record<ConnectionViewType, number> = {
        control: 0,
        audience: 0,
        guest: 0,
        stage: 0,
        singer: 0,
      };
      for (const member of members) counts[member.viewType] += 1;
      return Object.freeze({ ...counts });
    },

    publish,
    publishTo,
    publishChange,
    seedStates: (states: Partial<Record<LiveChannel, ChannelState>>): void => {
      for (const channel of LIVE_CHANNELS) {
        const state = states[channel];
        if (state !== undefined) current.set(channel, state);
      }
    },

    revokeCapability: (capabilityId: string | undefined): void => {
      for (const member of [...members]) {
        if (member.capabilityId !== undefined && (capabilityId === undefined || member.capabilityId === capabilityId)) {
          end(member, LIVE_CLOSE.refused, 'capability: revoked');
        }
      }
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
