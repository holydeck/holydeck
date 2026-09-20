import { describe, expect, it } from 'vitest';

import { STALE_STATE_REVISION } from './http.js';
import {
  ACK_OUTCOMES,
  LIVE_CHANNELS,
  LIVE_CLOSE,
  CAPABILITIES_PATH,
  LIVE_CONNECTIONS_PATH,
  LIVE_SESSION_STATES,
  OUTPUT_CAPABILITY_PATH,
  OUTPUT_CHANNELS,
  capabilityPath,
  parseAckFrame,
  parseCommandFrame,
  parseEventFrame,
  parseFrame,
  parseHeartbeatFrame,
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
const ack = () => ({ kind: 'ack', channel: 'live-control', id: 'cmd-3', outcome: 'applied', stateRevision: 42, sequence: 102, at: '2026-09-13T09:30:05Z' });
const heartbeat = () => ({ kind: 'heartbeat', channel: 'singer', at: '2026-09-13T09:30:10Z' });

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
    expect(LIVE_CHANNELS).toEqual(['live-control', 'audience', 'stage', 'singer']);
    expect(LIVE_SESSION_STATES).toEqual(['connecting', 'authorizing', 'synchronised', 'resuming', 'degraded', 'closed']);
  });

  it('separates the surfaces a service is shown on from the one channel it is run from', () => {
    expect(OUTPUT_CHANNELS).toEqual(['audience', 'stage', 'singer']);
    expect(OUTPUT_CHANNELS).not.toContain('live-control');
    expect(LIVE_CHANNELS).toEqual(['live-control', ...OUTPUT_CHANNELS]);
  });

  it('tells a client that stopped answering apart from one that fell behind', () => {
    expect(new Set(Object.values(LIVE_CLOSE)).size).toBe(Object.keys(LIVE_CLOSE).length);
    expect(LIVE_CLOSE.lapsed).not.toBe(LIVE_CLOSE.overloaded);
    // The 4000s are reserved for an application's own codes, which is what these two are.
    for (const code of [LIVE_CLOSE.lapsed, LIVE_CLOSE.overloaded]) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThan(5000);
    }
  });

  it('names one path both the route that answers connection counts and the client that reads them share', () => {
    expect(LIVE_CONNECTIONS_PATH).toBe('/api/v1/live/connections');
  });

  it('names one path both the route that issues an output capability and the client that asks for one share', () => {
    expect(OUTPUT_CAPABILITY_PATH).toBe('/api/v1/live/output-capability');
    expect(CAPABILITIES_PATH).toBe('/api/v1/live/capabilities');
  });

  it('builds one capability’s own path, with an identifier a path segment can carry', () => {
    expect(capabilityPath('cap-7a3')).toBe('/api/v1/live/capabilities/cap-7a3');
    // An identifier is opaque, and an opaque value is not trusted to be free of path separators.
    expect(capabilityPath('a/b?c')).toBe('/api/v1/live/capabilities/a%2Fb%3Fc');
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

  it('parses the acknowledgement a command is answered with, whatever became of it', () => {
    for (const outcome of ACK_OUTCOMES) {
      // A stale outcome carries the stable code naming why; every other outcome carries none.
      const frame = outcome === 'stale' ? { ...ack(), outcome, conflictCode: STALE_STATE_REVISION } : { ...ack(), outcome };
      expect(parseAckFrame(frame)).toEqual({ ok: true, value: frame });
    }
  });

  it('requires the conflict code on a stale acknowledgement, because that is what a client re-issues against', () => {
    expect(codes({ ...ack(), outcome: 'stale' }, parseAckFrame)).toEqual([`ack.conflictCode=${FIELD_CODES.required}`]);
  });

  it('refuses a conflict code on an acknowledgement that is not stale', () => {
    expect(codes({ ...ack(), conflictCode: STALE_STATE_REVISION }, parseAckFrame)).toEqual([
      `ack.conflictCode=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('names the four things that can become of a command and no others', () => {
    expect(ACK_OUTCOMES).toEqual(['applied', 'duplicate', 'stale', 'unauthorized']);
    expect(codes({ ...ack(), outcome: 'maybe' }, parseAckFrame)).toEqual([`ack.outcome=${FIELD_CODES.notAllowed}`]);
  });

  it('refuses an acknowledgement that names no command, because a client matches it by that', () => {
    expect(codes(without(ack(), 'id'), parseAckFrame)).toEqual([`ack.id=${FIELD_CODES.required}`]);
  });

  it('refuses an acknowledgement carrying no revision, because a stale client is told the revision by it', () => {
    expect(codes(without(ack(), 'stateRevision'), parseAckFrame)).toEqual([
      `ack.stateRevision=${FIELD_CODES.required}`,
    ]);
  });

  it('parses a heartbeat, which carries the channel and the instant and nothing else', () => {
    expect(parseHeartbeatFrame(heartbeat())).toEqual({ ok: true, value: heartbeat() });
  });

  it('refuses a heartbeat with no instant, because a lapse is measured from one', () => {
    expect(codes(without(heartbeat(), 'at'), parseHeartbeatFrame)).toEqual([`heartbeat.at=${FIELD_CODES.required}`]);
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
    for (const frame of [snapshot(), event(), command(), resume(), ack(), heartbeat()]) {
      expect(parseFrame(frame)).toEqual({ ok: true, value: frame });
    }
  });

  // The parser table is keyed by the value read off the wire, so a frame naming an inherited member as
  // its kind has to find nothing at all rather than find `Object.prototype`'s.
  it('refuses a frame claiming a member every object inherits as its kind', () => {
    for (const kind of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(codes({ kind, channel: 'audience' }, parseFrame)).toEqual([`frame.kind=${FIELD_CODES.notAllowed}`]);
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
