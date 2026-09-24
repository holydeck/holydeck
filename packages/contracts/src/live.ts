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
 * Where an output window's capability is issued — IDEN-08, granted to Control presentation alone. Named
 * here for the same reason the connections path above is: the route that serves it (`capability-routes.ts`)
 * and the client that asks it for the token a surface opens with are in two different workspaces, and a
 * path spelled twice is a path one of them will eventually spell differently.
 */
export const OUTPUT_CAPABILITY_PATH = `${LIVE_PATH}/output-capability`;

/** Where a capability already issued is given up again, one identifier at a time. */
export const CAPABILITIES_PATH = `${LIVE_PATH}/capabilities`;

/** One capability's own path. The identifier is encoded, because an opaque value is not trusted to be
 *  free of the separators the segment it travels in is read by. */
export const capabilityPath = (capabilityId: string): string =>
  `${CAPABILITIES_PATH}/${encodeURIComponent(capabilityId)}`;

/**
 * Where a Guest's join token is exchanged for what actually opens a live session: a short-lived socket
 * ticket and a read ticket bound to the capability, service and view it was issued for (OUT-01). Named
 * here, not app-locally, because both the web `/join` page and the server that answers it are two
 * different workspaces that must spell the same path.
 */
export const GUEST_EXCHANGE_PATH = `${LIVE_PATH}/guest-exchange`;

/** The same exchange, for an output window opened from a capability minted by `OUTPUT_CAPABILITY_PATH`
 *  rather than a shared join link (OUT-02). */
export const OUTPUT_EXCHANGE_PATH = `${LIVE_PATH}/output-exchange`;

/** What a Guest's join token names, to be traded in at `GUEST_EXCHANGE_PATH` for a socket ticket. */
export interface GuestExchangeBody {
  readonly token: string;
  readonly service: string;
}

export function parseGuestExchangeBody(value: unknown): Parsed<GuestExchangeBody> {
  return parseObject(value, 'guestExchange', (reader) => ({
    token: reader.text('token'),
    service: reader.text('service'),
  }));
}

/** The same, for an output capability, which additionally names the one view it opens. */
export interface OutputExchangeBody {
  readonly token: string;
  readonly service: string;
  readonly view: OutputChannel;
}

export function parseOutputExchangeBody(value: unknown): Parsed<OutputExchangeBody> {
  return parseObject(value, 'outputExchange', (reader) => ({
    token: reader.text('token'),
    service: reader.text('service'),
    view: reader.choice('view', OUTPUT_CHANNELS),
  }));
}

/**
 * What either exchange answers with: a socket ticket the connection upgrade spends and a read ticket
 * bound to the capability, service and view it was issued for — never the capability itself, which
 * stays server-side once redeemed.
 */
export interface LiveExchangeResponse {
  readonly socketTicket: string;
  readonly readTicket: string;
  readonly view: OutputChannel;
  readonly expiresAt: string;
}

export function parseLiveExchangeResponse(value: unknown): Parsed<LiveExchangeResponse> {
  return parseObject(value, 'liveExchange', (reader) => ({
    socketTicket: reader.text('socketTicket'),
    readTicket: reader.text('readTicket'),
    view: reader.choice('view', OUTPUT_CHANNELS),
    expiresAt: reader.time('expiresAt'),
  }));
}

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

/** Where a capability token was once carried in a socket URL. Never sent now (OUT-01): the server refuses a
 *  socket URL that carries one with `LIVE_CLOSE.refused`, and a capability is exchanged for a ticket. */
export const CAPABILITY_QUERY = 'capability';

/** Which service that capability opened, sent alongside it. Never sent now, for the same reason. */
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
 * What became of a command. Six outcomes, each of which tells the client its next move without any
 * prose to read: `applied` moved the state, `duplicate` says this command had already moved it and was
 * not applied again, `stale` says the revision it was issued against is no longer the server's, and
 * `unauthorized` says the session or command type is not permitted to publish.
 */
export const ACK_OUTCOMES = ['applied', 'duplicate', 'stale', 'unauthorized', 'invalid', 'failed'] as const;
export type AckOutcome = (typeof ACK_OUTCOMES)[number];

export type SnapshotFrame = {
  readonly kind: 'snapshot';
  readonly channel: LiveChannel;
  readonly stateRevision: number;
  readonly sequence: number;
  readonly at: string;
  readonly state?: unknown;
};

export type EventFrame = {
  readonly kind: 'event';
  readonly channel: LiveChannel;
  readonly sequence: number;
  readonly stateRevision: number;
  readonly type: string;
  readonly mutatesState: boolean;
  readonly at: string;
  readonly state?: unknown;
};

export type CommandFrame = {
  readonly kind: 'command';
  readonly channel: LiveChannel;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly clientStateRevision: number;
  readonly args?: unknown;
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
    state: reader.optionalParsed('state', (raw, path) => isRecord(raw)
      ? { ok: true, value: raw }
      : { ok: false, problems: [{ path, code: FIELD_CODES.notAnObject, message: 'must be an object' }] }),
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
    state: reader.optionalParsed('state', (raw, path) => isRecord(raw)
      ? { ok: true, value: raw }
      : { ok: false, problems: [{ path, code: FIELD_CODES.notAnObject, message: 'must be an object' }] }),
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
    // Args are the command's own business: a frame with odd args is still a readable command, which the
    // handler answers with an `invalid` ack (RUN-03) instead of the socket being closed as unreadable.
    args: reader.optionalParsed('args', (raw) => ({ ok: true, value: raw })),
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

/** What a `type: 'media'` command's `args` carries (LIVE-11). Only `seek` moves the timeline to a
 *  position, matching `live-media.ts`'s own `playMediaTimeline`/`pauseMediaTimeline`/`seekMediaTimeline`
 *  signatures, so `positionMs` is required for a seek and forbidden otherwise. */
export const MEDIA_COMMAND_ACTIONS = ['play', 'pause', 'seek'] as const;
export type MediaCommandAction = (typeof MEDIA_COMMAND_ACTIONS)[number];

export type MediaCommandArgs = {
  readonly action: MediaCommandAction;
  readonly mediaId: string;
  readonly positionMs?: number;
};

export function parseMediaCommandArgs(value: unknown): Parsed<MediaCommandArgs> {
  return parseObject(value, 'media', (reader) => {
    const action = reader.choice('action', MEDIA_COMMAND_ACTIONS);
    const mediaId = reader.text('mediaId');
    if (action !== 'seek') {
      reader.absent('positionMs', FIELD_CODES.notAllowed, 'is carried only when the action is seek');
      return { action, mediaId };
    }
    return { action, mediaId, positionMs: reader.wholeNumber('positionMs') };
  });
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
