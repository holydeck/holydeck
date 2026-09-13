// The frames a live session carries. Only the payloads are settled here: what a frame must contain to
// be read at all, in the vocabulary the protocol contract declares. What the server *does* with a
// resume, a slow consumer, or a stale command is the protocol's behaviour and belongs with it.

import { FIELD_CODES, type FieldReader, type Parsed, isRecord, parseObject } from './problems.js';

export const LIVE_CHANNELS = ['live-control', 'audience', 'stage'] as const;
export type LiveChannel = (typeof LIVE_CHANNELS)[number];

export const LIVE_SESSION_STATES = [
  'connecting',
  'authorizing',
  'synchronised',
  'resuming',
  'degraded',
  'closed',
] as const;
export type LiveSessionState = (typeof LIVE_SESSION_STATES)[number];

export const FRAME_KINDS = ['snapshot', 'event', 'command', 'resume'] as const;
export type FrameKind = (typeof FRAME_KINDS)[number];

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

export type LiveFrame = SnapshotFrame | EventFrame | CommandFrame | ResumeFrame;

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

// Keyed by the value read off the wire rather than by a declared key, so a frame claiming `constructor`
// or `__proto__` as its kind finds nothing instead of finding an inherited member.
const FRAME_PARSERS = new Map<unknown, (value: unknown) => Parsed<LiveFrame>>([
  ['snapshot', parseSnapshotFrame],
  ['event', parseEventFrame],
  ['command', parseCommandFrame],
  ['resume', parseResumeFrame],
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
