import { describe, expect, it } from 'vitest';

import {
  LIVE_CHANNELS,
  LIVE_SESSION_STATES,
  parseCommandFrame,
  parseEventFrame,
  parseFrame,
  parseResumeFrame,
  parseSnapshotFrame,
} from './live.js';
import { FIELD_CODES } from './problems.js';

// The values recorded in contracts/fixtures/websocket.v1.json, written out here because the product
// repository holds no phase artifacts.
const snapshot = () => ({ kind: 'snapshot', channel: 'live-control', stateRevision: 41, sequence: 100, at: '2026-09-13T09:30:00Z' });
const event = () => ({ kind: 'event', channel: 'live-control', sequence: 102, stateRevision: 42, type: 'slide-shown', mutatesState: true, at: '2026-09-13T09:30:05Z' });
const command = () => ({ kind: 'command', channel: 'live-control', id: 'cmd-3', idempotencyKey: 'idem-7a3', type: 'show-slide', clientStateRevision: 41 });
const resume = () => ({ kind: 'resume', channel: 'audience', fromSequence: 101 });

const codes = (value: unknown, parse: (input: unknown) => { ok: boolean; problems?: readonly { path: string; code: string }[] }) => {
  const parsed = parse(value);
  expect(parsed.ok).toBe(false);
  return (parsed.problems ?? []).map((problem) => `${problem.path}=${problem.code}`);
};

const without = (value: Record<string, unknown>, ...fields: readonly string[]): Record<string, unknown> => {
  const copy = { ...value };
  for (const field of fields) delete copy[field];
  return copy;
};

describe('the vocabulary a live session is limited to', () => {
  it('names the channels and the session states the protocol declares', () => {
    expect(LIVE_CHANNELS).toEqual(['live-control', 'audience', 'stage']);
    expect(LIVE_SESSION_STATES).toEqual(['connecting', 'authorizing', 'synchronised', 'resuming', 'degraded', 'closed']);
  });
});

describe('frames the server sends', () => {
  it('parses the snapshot the session opens with', () => {
    expect(parseSnapshotFrame(snapshot())).toEqual({ ok: true, value: snapshot() });
  });

  it('parses an event that moved the state and one that did not', () => {
    expect(parseEventFrame(event())).toEqual({ ok: true, value: event() });
    const heartbeat = { ...event(), sequence: 101, stateRevision: 41, type: 'heartbeat', mutatesState: false };
    expect(parseEventFrame(heartbeat)).toEqual({ ok: true, value: heartbeat });
  });

  it('refuses a snapshot that is not an object at all', () => {
    expect(parseSnapshotFrame('snapshot')).toEqual({
      ok: false,
      problems: [{ path: 'snapshot', code: FIELD_CODES.notAnObject, message: 'must be an object' }],
    });
  });

  it('refuses a snapshot on a channel the protocol does not have', () => {
    expect(codes({ ...snapshot(), channel: 'green-room' }, parseSnapshotFrame)).toEqual([
      `snapshot.channel=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses a state revision or sequence that is not a whole count', () => {
    expect(codes({ ...snapshot(), stateRevision: 41.5, sequence: -1 }, parseSnapshotFrame)).toEqual([
      `snapshot.stateRevision=${FIELD_CODES.notAWholeNumber}`,
      `snapshot.sequence=${FIELD_CODES.tooSmall}`,
    ]);
  });

  it('refuses a snapshot with no instant, because a resume window is measured from one', () => {
    expect(codes({ ...snapshot(), at: 'this morning' }, parseSnapshotFrame)).toEqual([
      `snapshot.at=${FIELD_CODES.notATime}`,
    ]);
  });

  it('refuses an event whose type is not a name the log can be read by', () => {
    expect(codes({ ...event(), type: 'Slide Shown' }, parseEventFrame)).toEqual([
      `event.type=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses an event that does not say whether it moved the state', () => {
    expect(codes(without(event(), 'mutatesState'), parseEventFrame)).toEqual([
      `event.mutatesState=${FIELD_CODES.required}`,
    ]);
  });
});

describe('frames a client sends', () => {
  it('parses a command and the state revision it was issued against', () => {
    expect(parseCommandFrame(command())).toEqual({ ok: true, value: command() });
  });

  it('parses a resume asking to replay from the last sequence it saw', () => {
    expect(parseResumeFrame(resume())).toEqual({ ok: true, value: resume() });
  });

  it('refuses a command with no idempotency key, because a retry would then apply twice', () => {
    expect(codes(without(command(), 'idempotencyKey'), parseCommandFrame)).toEqual([
      `command.idempotencyKey=${FIELD_CODES.required}`,
    ]);
  });

  it('refuses a command that names no state revision, because staleness could not be judged', () => {
    expect(codes(without(command(), 'clientStateRevision'), parseCommandFrame)).toEqual([
      `command.clientStateRevision=${FIELD_CODES.required}`,
    ]);
  });

  it('reports every defect in one frame at once rather than the first', () => {
    expect(codes({ kind: 'command', channel: 'stage', id: '', type: 'Show Slide' }, parseCommandFrame)).toEqual([
      `command.id=${FIELD_CODES.empty}`,
      `command.idempotencyKey=${FIELD_CODES.required}`,
      `command.type=${FIELD_CODES.notAllowed}`,
      `command.clientStateRevision=${FIELD_CODES.required}`,
    ]);
  });

  it('refuses a resume from a fraction of a sequence', () => {
    expect(codes({ ...resume(), fromSequence: 101.5 }, parseResumeFrame)).toEqual([
      `resume.fromSequence=${FIELD_CODES.notAWholeNumber}`,
    ]);
  });
});

describe('reading a frame whose kind is only known once it is read', () => {
  it('routes each kind the protocol declares to the parser that owns it', () => {
    for (const frame of [snapshot(), event(), command(), resume()]) {
      expect(parseFrame(frame)).toEqual({ ok: true, value: frame });
    }
  });

  it('refuses a kind the protocol does not declare, rather than ignoring the frame', () => {
    expect(codes({ ...event(), kind: 'telemetry' }, parseFrame)).toEqual([`frame.kind=${FIELD_CODES.notAllowed}`]);
  });

  it('refuses a frame that is not an object, and says so about the frame', () => {
    expect(parseFrame(null)).toEqual({
      ok: false,
      problems: [{ path: 'frame', code: FIELD_CODES.notAnObject, message: 'must be an object' }],
    });
  });

  it('reports the defects of the frame it routed to, not the routing', () => {
    expect(codes({ ...event(), type: '' }, parseFrame)).toEqual([`event.type=${FIELD_CODES.empty}`]);
  });
});
