// The frames a live session carries. Only the payloads are settled here: what a frame must contain to
// be read at all, in the vocabulary the protocol contract declares. What the server *does* with a
// resume, a slow consumer, or a stale command is the protocol's behaviour and belongs with it.

import { FIELD_CODES, type FieldReader, type Parsed, isRecord, parseObject } from './problems.js';

/**
 * The one channel a service is run from. It is never a channel a capability presents, because it is the
 * only one carrying what an operator does privately — a search, a passage being checked, an edit to
 * something not shown yet. Reaching it is a permission, and reaching the rest is not.
 */
export const LIVE_CONTROL_CHANNEL = 'live-control';

/** The surfaces a service is shown on. Each of them is watched; none of them is ever commanded. */
export const OUTPUT_CHANNELS = ['audience', 'stage', 'singer'] as const;
export type OutputChannel = (typeof OUTPUT_CHANNELS)[number];

export const LIVE_CHANNELS = [LIVE_CONTROL_CHANNEL, ...OUTPUT_CHANNELS] as const;
export type LiveChannel = (typeof LIVE_CHANNELS)[number];

/** Where a live session is opened. Shared for the same reason the connections path below is: the
 *  application that serves the socket and the client that opens one name it once. */
export const LIVE_PATH = '/api/v1/live';

/** Where an operator reads connection counts by view type — spec 9.5, LIVE-06. Shared so the
 *  application that answers it and the client that reads it name the same path once. */
export const LIVE_CONNECTIONS_PATH = `${LIVE_PATH}/connections`;

/**
 * What an upgrade request carries in its query string, and only there: a browser WebSocket can set no
 * request header, so the channel asked for and the client version declared travel in the URL — as does
 * the capability a shared join link carries, with the service it opens (T81). The ticket a signed-in
 * session spends is `sessions.ts`'s `TICKET_QUERY`, because a ticket is a session's own thing.
 *
 * Which channel the connection is for.
 */
export const CHANNEL_QUERY = 'channel';

/** Which client version is connecting — read against `CLIENT_WINDOW` before the socket is accepted. */
export const CLIENT_VERSION_QUERY = 'clientVersion';

/** The capability a shared join link carries, where this connection is a Guest's rather than a session's. */
export const CAPABILITY_QUERY = 'capability';

/** Which service that capability opens. Sent with `CAPABILITY_QUERY`, and meaningless without it. */
export const SERVICE_QUERY = 'service';

/**
 * How a live session ends when it was not the client that ended it. 1003 is unsupported data and 1008 a
 * policy refusal, which is the difference those two carry. The other two are in the 4000s, the range
 * reserved for an application's own codes, because nothing standard tells "you stopped answering" apart
 * from "you fell too far behind to be caught up" — and those two ask different things of the client that
 * reads them: one reconnects, the other reconnects having stopped doing whatever put it behind.
 */
export const LIVE_CLOSE = {
  unreadable: 1003,
  refused: 1008,
  lapsed: 4000,
  overloaded: 4001,
} as const;

/** A close frame carries at most 123 bytes of reason, so a reason longer than that is cut, not dropped. */
export const MAX_CLOSE_REASON = 120;

export const LIVE_SESSION_STATES = [
  'connecting',
  'authorizing',
  'synchronised',
  'resuming',
  'degraded',
  'closed',
] as const;
export type LiveSessionState = (typeof LIVE_SESSION_STATES)[number];

export const FRAME_KINDS = ['snapshot', 'event', 'command', 'resume', 'ack', 'heartbeat'] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

/**
 * What became of a command. Four outcomes, each of which tells the client its next move without any
 * prose to read: `applied` moved the state, `duplicate` says this command had already moved it and was
 * not applied again, `stale` says the revision it was issued against is no longer the server's, and
 * `unauthorized` says this session may watch but not command.
 */
export const ACK_OUTCOMES = ['applied', 'duplicate', 'stale', 'unauthorized'] as const;
export type AckOutcome = (typeof ACK_OUTCOMES)[number];

export type SnapshotFrame = {
  readonly kind: 'snapshot';
  readonly channel: LiveChannel;
  readonly stateRevision: number;
  readonly sequence: number;
  readonly at: string;
};

export type EventFrame = {
  readonly kind: 'event';
  readonly channel: LiveChannel;
  readonly sequence: number;
  readonly stateRevision: number;
  readonly type: string;
  readonly mutatesState: boolean;
  readonly at: string;
};

export type CommandFrame = {
  readonly kind: 'command';
  readonly channel: LiveChannel;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly clientStateRevision: number;
};

export type ResumeFrame = {
  readonly kind: 'resume';
  readonly channel: LiveChannel;
  readonly fromSequence: number;
};

/**
 * The answer to exactly one command, matched to it by `id`. The revision is the server's own, whatever
 * the outcome, so a client refused as stale is told in the same frame what to re-issue against.
 * `conflictCode` names why, in the stable vocabulary `./http.js` publishes — carried only when the
 * outcome is `stale`, because that is the only outcome a client needs a code to act on.
 */
export type AckFrame = {
  readonly kind: 'ack';
  readonly channel: LiveChannel;
  readonly id: string;
  readonly outcome: AckOutcome;
  readonly conflictCode?: string;
  readonly stateRevision: number;
  readonly sequence: number;
  readonly at: string;
};

/**
 * Proof that a session is still there. It takes no sequence and moves no state: a resume replays what
 * happened, and nothing happened here. Either end may send one, and either end reads one as the other
 * end still being on the far side of the connection.
 */
export type HeartbeatFrame = {
  readonly kind: 'heartbeat';
  readonly channel: LiveChannel;
  readonly at: string;
};

export type LiveFrame = SnapshotFrame | EventFrame | CommandFrame | ResumeFrame | AckFrame | HeartbeatFrame;

// Event and command types name themselves in the log an operator reads afterwards, so they are held to
// a shape a log line can be grouped and searched by rather than to a closed list this milestone would
// have to guess at.
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

const readName = (reader: FieldReader, field: string): string => {
  const value = reader.text(field);
  if (value !== '' && !NAME.test(value)) {
    reader.reject(field, FIELD_CODES.notAllowed, 'must be a lower-case name in words joined by hyphens');
  }
  return value;
};

const readChannel = (reader: FieldReader): LiveChannel => reader.choice('channel', LIVE_CHANNELS);

export function parseSnapshotFrame(value: unknown): Parsed<SnapshotFrame> {
  return parseObject(value, 'snapshot', (reader) => ({
    kind: reader.choice('kind', ['snapshot'] as const),
    channel: readChannel(reader),
    stateRevision: reader.wholeNumber('stateRevision'),
    sequence: reader.wholeNumber('sequence'),
    at: reader.time('at'),
  }));
}

export function parseEventFrame(value: unknown): Parsed<EventFrame> {
  return parseObject(value, 'event', (reader) => ({
    kind: reader.choice('kind', ['event'] as const),
    channel: readChannel(reader),
    sequence: reader.wholeNumber('sequence'),
    stateRevision: reader.wholeNumber('stateRevision'),
    type: readName(reader, 'type'),
    mutatesState: reader.flag('mutatesState'),
    at: reader.time('at'),
  }));
}

export function parseCommandFrame(value: unknown): Parsed<CommandFrame> {
  return parseObject(value, 'command', (reader) => ({
    kind: reader.choice('kind', ['command'] as const),
    channel: readChannel(reader),
    id: reader.text('id'),
    idempotencyKey: reader.text('idempotencyKey'),
    type: readName(reader, 'type'),
    clientStateRevision: reader.wholeNumber('clientStateRevision'),
  }));
}

export function parseResumeFrame(value: unknown): Parsed<ResumeFrame> {
  return parseObject(value, 'resume', (reader) => ({
    kind: reader.choice('kind', ['resume'] as const),
    channel: readChannel(reader),
    fromSequence: reader.wholeNumber('fromSequence'),
  }));
}

export function parseAckFrame(value: unknown): Parsed<AckFrame> {
  return parseObject(value, 'ack', (reader) => {
    const kind = reader.choice('kind', ['ack'] as const);
    const channel = readChannel(reader);
    const id = reader.text('id');
    const outcome = reader.choice('outcome', ACK_OUTCOMES);
    if (outcome !== 'stale') {
      reader.absent('conflictCode', FIELD_CODES.notAllowed, 'is carried only when the outcome is stale');
      return {
        kind,
        channel,
        id,
        outcome,
        stateRevision: reader.wholeNumber('stateRevision'),
        sequence: reader.wholeNumber('sequence'),
        at: reader.time('at'),
      };
    }
    return {
      kind,
      channel,
      id,
      outcome,
      conflictCode: reader.text('conflictCode'),
      stateRevision: reader.wholeNumber('stateRevision'),
      sequence: reader.wholeNumber('sequence'),
      at: reader.time('at'),
    };
  });
}

export function parseHeartbeatFrame(value: unknown): Parsed<HeartbeatFrame> {
  return parseObject(value, 'heartbeat', (reader) => ({
    kind: reader.choice('kind', ['heartbeat'] as const),
    channel: readChannel(reader),
    at: reader.time('at'),
  }));
}

// Keyed by the value read off the wire rather than by a declared key, so a frame claiming `constructor`
// or `__proto__` as its kind finds nothing instead of finding an inherited member.
const FRAME_PARSERS = new Map<unknown, (value: unknown) => Parsed<LiveFrame>>([
  ['snapshot', parseSnapshotFrame],
  ['event', parseEventFrame],
  ['command', parseCommandFrame],
  ['resume', parseResumeFrame],
  ['ack', parseAckFrame],
  ['heartbeat', parseHeartbeatFrame],
]);

/** Reads a frame whose kind is only known once the frame is read, and refuses one this build cannot. */
export function parseFrame(value: unknown): Parsed<LiveFrame> {
  if (!isRecord(value)) {
    return { ok: false, problems: [{ path: 'frame', code: FIELD_CODES.notAnObject, message: 'must be an object' }] };
  }
  const parse = FRAME_PARSERS.get(value['kind']);
  if (parse === undefined) {
    return {
      ok: false,
      problems: [
        { path: 'frame.kind', code: FIELD_CODES.notAllowed, message: `must be one of ${FRAME_KINDS.join(', ')}` },
      ],
    };
  }
  return parse(value);
}
