import { STALE_STATE_REVISION } from '@holydeck/contracts/http';
import { LIVE_CHANNELS, LIVE_CLOSE, MAX_CLOSE_REASON, OUTPUT_CHANNELS } from '@holydeck/contracts/live';
import { describe, expect, it, vi } from 'vitest';

import { VIEW_GRANTS, grantFor, liveHub } from './live-protocol.js';
import { PRESENTATION_CONTROL } from './roles.js';

import type { LiveGrant, LiveHub, LiveTransport } from './live-protocol.js';
import type { LiveChannel } from '@holydeck/contracts/live';
import type { ChannelState } from '@holydeck/contracts/live-state';

const AT = '2026-09-13T10:00:00.000Z';

const OPERATOR: LiveGrant = grantFor([PRESENTATION_CONTROL]);
const WATCHER: LiveGrant = grantFor([]);

type Frame = Record<string, unknown>;

/**
 * The far side of a connection, with the two things a real one has that a test has to be able to move:
 * how much the transport is still holding for its peer, and whether a write to it fails because the
 * peer is no longer there.
 */
const peer = (): {
  transport: LiveTransport;
  frames(): readonly Frame[];
  kinds(): readonly string[];
  hold(bytes: number): void;
  vanish(): void;
  ended(): { readonly code: number; readonly reason: string } | undefined;
} => {
  const written: string[] = [];
  let buffered = 0;
  let gone = false;
  let ended: { readonly code: number; readonly reason: string } | undefined;
  return {
    transport: {
      send: (text: string): void => {
        if (gone) throw new Error('the connection is gone');
        written.push(text);
      },
      // First close wins, the same way a socket's does: a second one changes nothing a client sees.
      close: (code: number, reason: string): void => {
        ended ??= { code, reason };
      },
      buffered: (): number => buffered,
    },
    frames: (): readonly Frame[] => written.map((text) => JSON.parse(text) as Frame),
    kinds: (): readonly string[] => written.map((text) => String((JSON.parse(text) as Frame)['kind'])),
    hold: (bytes: number): void => {
      buffered = bytes;
    },
    vanish: (): void => {
      gone = true;
    },
    ended: () => ended,
  };
};

const hubAt = (options: Partial<Parameters<typeof liveHub>[0]> = {}): LiveHub =>
  liveHub({ clock: () => AT, ...options });

/** A joined connection and the peer it writes to, which is what nearly every assertion below needs.
 *  `guest` mirrors `LiveHub.join`'s own optional 4th argument (T81/T82): true only for a connection
 *  admitted through a capability, which is what tells a Guest's count apart from an ordinary Audience
 *  one in `connectionCounts()`. */
const joined = (hub: LiveHub, channel: LiveChannel, grant: LiveGrant = WATCHER, guest = false, clientId?: string) => {
  const far = peer();
  const connection = hub.join(far.transport, channel, grant, guest, clientId);
  return { far, connection };
};

const command = (fields: Partial<Frame> = {}): string =>
  JSON.stringify({
    kind: 'command',
    channel: 'live-control',
    id: 'command-1',
    idempotencyKey: 'key-1',
    type: 'current-slide-changed',
    clientStateRevision: 0,
    ...fields,
  });

/** Runs one command from a connection that may issue one, which is how the state moves in these tests. */
const moved = (hub: LiveHub, count: number): ReturnType<typeof joined> => {
  const control = joined(hub, 'live-control', OPERATOR);
  for (let issued = 0; issued < count; issued += 1) {
    control.connection?.receive(
      command({ id: `command-${issued}`, idempotencyKey: `key-${issued}`, clientStateRevision: issued }),
    );
  }
  return control;
};

describe('what a session is allowed to reach', () => {
  it('gives Control presentation the channel a service is run from, and the authority to command it', () => {
    expect(OPERATOR).toEqual({ watch: LIVE_CHANNELS, command: true });
  });

  it('gives every other session the surfaces a service is shown on, and no authority at all', () => {
    expect(WATCHER).toEqual({ watch: OUTPUT_CHANNELS, command: false });
    expect(WATCHER.watch).not.toContain('live-control');
  });

  it('scopes a capability-carrying session to exactly the one view it was issued for, and no other', () => {
    for (const view of OUTPUT_CHANNELS) {
      expect(VIEW_GRANTS[view]).toEqual({ watch: [view], command: false });
    }
  });

  it('joins the view a capability names, and is refused every channel it does not, receiving nothing from either', () => {
    const hub = hubAt();
    const admitted = joined(hub, 'singer', VIEW_GRANTS.singer);
    expect(admitted.connection).toBeDefined();
    expect(admitted.far.frames()).toMatchObject([{ kind: 'snapshot', channel: 'singer' }]);

    const attempts = (['audience', 'stage', 'live-control'] as const).map((channel) => joined(hub, channel, VIEW_GRANTS.singer));
    for (const attempt of attempts) {
      expect(attempt.connection).toBeUndefined();
      expect(attempt.far.frames()).toEqual([]);
    }

    // A channel this grant was refused never became a session in the first place, so a change published
    // afterwards has nowhere on it to reach: the same transport read as empty above stays that way.
    moved(hub, 1);
    for (const attempt of attempts) expect(attempt.far.frames()).toEqual([]);
  });
});

describe('adversarial: an output capability reaching past the channel it was issued for', () => {
  it('is ended, not answered, when a frame it sends declares a channel other than the one it joined', () => {
    const hub = hubAt();
    const stage = joined(hub, 'stage', VIEW_GRANTS.stage, true);
    expect(stage.connection).toBeDefined();

    // Nothing but the channel label changed here — command:false still governs anything this grant could
    // ever be allowed to do — but the isolation a capability's view is supposed to guarantee has to hold
    // even before authorization is checked: a connection scoped to `stage` must never be answered for a
    // frame that names any other channel, live-control included.
    stage.connection?.receive(command({ channel: 'live-control' }));
    expect(stage.far.ended()).toEqual({
      code: LIVE_CLOSE.refused,
      reason: 'command.channel: this session is connected to stage',
    });
    expect(hub.stateRevision()).toBe(0);

    // No other output channel's session saw anything from the attempt either: it reached no one but the
    // connection that made it, and closed only that one.
    const audience = joined(hub, 'audience');
    expect(audience.far.frames()).toMatchObject([{ kind: 'snapshot', channel: 'audience' }]);
  });
});

describe('joining a live session', () => {
  it('opens with a snapshot of the channel joined, at the revision and sequence the hub stands at', () => {
    const hub = hubAt();
    const { far, connection } = joined(hub, 'audience');
    expect(connection).toBeDefined();
    expect(far.frames()).toEqual([
      { kind: 'snapshot', channel: 'audience', stateRevision: 0, sequence: 0, at: AT },
    ]);
  });

  it('refuses a channel outside what the session may watch, and sends it nothing at all', () => {
    const hub = hubAt();
    const { far, connection } = joined(hub, 'live-control');
    expect(connection).toBeUndefined();
    expect(far.frames()).toEqual([]);
    expect(far.ended()).toEqual({
      code: LIVE_CLOSE.refused,
      reason: 'channel: this session may not watch live-control',
    });
  });

  it('opens every output surface for a session that carries no permission whatsoever', () => {
    const hub = hubAt();
    for (const channel of OUTPUT_CHANNELS) {
      const { far, connection } = joined(hub, channel);
      expect(connection).toBeDefined();
      expect(far.frames()).toMatchObject([{ kind: 'snapshot', channel }]);
    }
  });
});

describe('a command', () => {
  it('advances the state revision and reaches every surface as one event under one sequence', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    const singer = joined(hub, 'singer');
    const control = joined(hub, 'live-control', OPERATOR);

    control.connection?.receive(command());

    expect(hub.stateRevision()).toBe(1);
    expect(audience.far.frames()[1]).toEqual({
      kind: 'event',
      channel: 'audience',
      sequence: 1,
      stateRevision: 1,
      type: 'current-slide-changed',
      mutatesState: true,
      at: AT,
    });
    expect(singer.far.frames()[1]).toMatchObject({ kind: 'event', channel: 'singer', sequence: 1, stateRevision: 1 });
    expect(control.far.frames()[1]).toMatchObject({ kind: 'event', channel: 'live-control', sequence: 1 });
  });

  it('is acknowledged to the session that issued it, after the event it produced', () => {
    const hub = hubAt();
    const control = joined(hub, 'live-control', OPERATOR);
    control.connection?.receive(command());
    expect(control.far.kinds()).toEqual(['snapshot', 'event', 'ack']);
    expect(control.far.frames()[2]).toEqual({
      kind: 'ack',
      channel: 'live-control',
      id: 'command-1',
      outcome: 'applied',
      stateRevision: 1,
      sequence: 1,
      at: AT,
    });
  });

  it('moves the revision and the sequence one step at a time, never backwards', () => {
    const hub = hubAt();
    const control = moved(hub, 4);
    expect(hub.stateRevision()).toBe(4);
    expect(hub.sequence()).toBe(4);
    const revisions = control.far.frames().filter((frame) => frame['kind'] === 'event').map((frame) => frame['stateRevision']);
    expect(revisions).toEqual([1, 2, 3, 4]);
  });

  it('is refused as stale when the revision it was issued against is no longer the server’s', () => {
    const hub = hubAt();
    const control = moved(hub, 1);
    control.connection?.receive(command({ id: 'command-late', idempotencyKey: 'key-late', clientStateRevision: 0 }));
    expect(hub.stateRevision()).toBe(1);
    expect(control.far.frames().at(-1)).toMatchObject({
      kind: 'ack',
      id: 'command-late',
      outcome: 'stale',
      conflictCode: STALE_STATE_REVISION,
      stateRevision: 1,
    });
    // Nothing was published for it: the last event is still the one the first command produced.
    expect(control.far.frames().filter((frame) => frame['kind'] === 'event')).toHaveLength(1);
  });

  it('is refused the same way when the client claims a revision this server never reached', () => {
    const hub = hubAt();
    const control = joined(hub, 'live-control', OPERATOR);
    control.connection?.receive(command({ clientStateRevision: 9 }));
    expect(hub.stateRevision()).toBe(0);
    expect(control.far.frames().at(-1)).toMatchObject({
      outcome: 'stale',
      conflictCode: STALE_STATE_REVISION,
      stateRevision: 0,
    });
  });

  it('is refused as unauthorized when the session may watch but not command, and the session stays open', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    audience.connection?.receive(command({ channel: 'audience' }));
    expect(hub.stateRevision()).toBe(0);
    expect(audience.far.ended()).toBeUndefined();
    expect(audience.far.frames().at(-1)).toMatchObject({ kind: 'ack', outcome: 'unauthorized', channel: 'audience' });
  });
});

describe('a change no client commanded', () => {
  it('reaches every joined session, on every channel, as an event tagged with the type given', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    const singer = joined(hub, 'singer');
    const control = joined(hub, 'live-control', OPERATOR);

    const landed = hub.publish('run-state-changed');

    expect(landed).toEqual({ stateRevision: 1, sequence: 1 });
    expect(hub.stateRevision()).toBe(1);
    expect(audience.far.frames().at(-1)).toEqual({
      kind: 'event',
      channel: 'audience',
      sequence: 1,
      stateRevision: 1,
      type: 'run-state-changed',
      mutatesState: true,
      at: AT,
    });
    expect(singer.far.frames().at(-1)).toMatchObject({ channel: 'singer', type: 'run-state-changed' });
    expect(control.far.frames().at(-1)).toMatchObject({ channel: 'live-control', type: 'run-state-changed' });
  });

  it('is answered to no one: it is pushed, never a reply a session asked for', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    hub.publish('theme-changed');
    // Exactly the snapshot this session opened with, plus exactly one event — nothing it had to ask again
    // for, and nothing sent twice for the one change that happened.
    expect(audience.far.kinds()).toEqual(['snapshot', 'event']);
  });

  it('interleaves with operator commands in exactly the order the server processed them, never reordered', () => {
    const hub = hubAt();
    const control = joined(hub, 'live-control', OPERATOR);
    const audience = joined(hub, 'audience');

    control.connection?.receive(command({ id: 'c1', idempotencyKey: 'k1', type: 'current-slide-changed', clientStateRevision: 0 }));
    hub.publish('standby-changed');
    control.connection?.receive(command({ id: 'c2', idempotencyKey: 'k2', type: 'current-slide-changed', clientStateRevision: 2 }));
    hub.publish('theme-changed');

    const events = audience.far.frames().filter((frame) => frame['kind'] === 'event');
    expect(events.map((frame) => frame['type'])).toEqual([
      'current-slide-changed',
      'standby-changed',
      'current-slide-changed',
      'theme-changed',
    ]);
    expect(events.map((frame) => frame['sequence'])).toEqual([1, 2, 3, 4]);
  });
});

describe('publishTo: a change addressed to the one channel it concerns', () => {
  const audienceState: ChannelState = {
    view: 'audience',
    runId: 'r',
    snapshotId: 's',
    frame: { itemId: 'i', slideIndex: 0 },
    themeId: 'default',
    additionsRevision: 0,
  };

  it('sends a per-channel state only to members of that channel', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    const stage = joined(hub, 'stage');

    const landed = hub.publishTo('audience', 'current-slide-changed', (channel) =>
      channel === 'audience' ? audienceState : undefined,
    );

    expect(landed).toEqual({ stateRevision: 1, sequence: 1 });
    expect(audience.far.frames().at(-1)).toMatchObject({
      kind: 'event',
      channel: 'audience',
      type: 'current-slide-changed',
      state: { view: 'audience' },
    });
    // Never reached at all — not even with an event carrying no state — because this change was never
    // asked about the stage channel.
    expect(stage.far.kinds()).toEqual(['snapshot']);
  });

  it('publish (unchanged) still reaches every member on every channel with no state', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    const control = joined(hub, 'live-control', OPERATOR);

    hub.publish('run-state-changed');

    for (const member of [audience, control]) {
      const event = member.far.frames().at(-1) as Record<string, unknown>;
      expect(event['type']).toBe('run-state-changed');
      expect(event).not.toHaveProperty('state');
    }
  });

  it('leaves the hub unmoved, and reaches no one, when the channel it is asked about has nothing to say', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');

    const landed = hub.publishTo('audience', 'current-slide-changed', () => undefined);

    expect(landed).toEqual({ stateRevision: 0, sequence: 0 });
    expect(hub.stateRevision()).toBe(0);
    expect(audience.far.kinds()).toEqual(['snapshot']);
  });
});

describe('a command sent twice under one idempotency key', () => {
  it('applies commands with the same key from two different client identities', () => {
    const hub = hubAt();
    const first = joined(hub, 'live-control', OPERATOR, false, 'account:first');
    const second = joined(hub, 'live-control', OPERATOR, false, 'account:second');
    first.connection?.receive(command());
    expect(first.far.frames().at(-1)).toMatchObject({ kind: 'ack', outcome: 'applied', sequence: 1 });
    second.connection?.receive(command({ clientStateRevision: 1 }));
    expect(second.far.frames().at(-1)).toMatchObject({ kind: 'ack', outcome: 'applied', sequence: 2 });
    expect(hub.stateRevision()).toBe(2);
  });

  it('recognizes a replay after the same client identity reconnects', () => {
    const hub = hubAt();
    const first = joined(hub, 'live-control', OPERATOR, false, 'account:first');
    first.connection?.receive(command());
    first.connection?.leave();
    const second = joined(hub, 'live-control', OPERATOR, false, 'account:first');
    second.connection?.receive(command());
    expect(second.far.frames().at(-1)).toMatchObject({ kind: 'ack', outcome: 'duplicate', sequence: 1 });
    expect(hub.stateRevision()).toBe(1);
  });

  it('uses the capability identity ahead of the supplied client identity', () => {
    const hub = hubAt();
    const grant = { ...OPERATOR, capabilityId: 'capability:first' };
    const first = joined(hub, 'live-control', grant, false, 'account:first');
    const second = joined(hub, 'live-control', grant, false, 'account:second');
    first.connection?.receive(command());
    second.connection?.receive(command());
    expect(second.far.frames().at(-1)).toMatchObject({ kind: 'ack', outcome: 'duplicate', sequence: 1 });
    expect(hub.stateRevision()).toBe(1);
  });

  it('moves the state once and answers the replay with what the first one did', () => {
    const hub = hubAt();
    const control = moved(hub, 1);
    const applied = control.far.frames().at(-1);

    // The replay carries the revision it was first issued against, which by now is behind: a client that
    // never saw the acknowledgement retries exactly the frame it sent, not a freshly numbered one.
    control.connection?.receive(command({ id: 'command-0', idempotencyKey: 'key-0', clientStateRevision: 0 }));

    expect(hub.stateRevision()).toBe(1);
    expect(hub.sequence()).toBe(1);
    expect(control.far.frames().filter((frame) => frame['kind'] === 'event')).toHaveLength(1);
    expect(control.far.frames().at(-1)).toMatchObject({
      kind: 'ack',
      outcome: 'duplicate',
      stateRevision: applied?.['stateRevision'],
      sequence: applied?.['sequence'],
    });
  });

  it('answers a replay that reaches the server on a second connection, not only the one that issued it', () => {
    const hub = hubAt();
    moved(hub, 1);
    const second = joined(hub, 'live-control', OPERATOR);
    second.connection?.receive(command({ id: 'command-0', idempotencyKey: 'key-0', clientStateRevision: 0 }));
    expect(hub.stateRevision()).toBe(1);
    expect(second.far.frames().at(-1)).toMatchObject({ kind: 'ack', outcome: 'duplicate', sequence: 1 });
  });

  it('forgets the oldest key once more commands have run than it remembers', () => {
    const hub = hubAt({ rememberedCommands: 2 });
    const control = moved(hub, 3);
    control.connection?.receive(command({ id: 'command-0', idempotencyKey: 'key-0', clientStateRevision: 3 }));
    // Forgotten rather than remembered, so it is judged as a command in its own right and applied again.
    expect(hub.stateRevision()).toBe(4);
    expect(control.far.frames().at(-1)).toMatchObject({ outcome: 'applied' });
  });
});

describe('adversarial: a stale command injected from outside the run that produced it', () => {
  it('is rejected by the server’s own authoritative revision, not by anything the sender remembers', () => {
    const hub = hubAt();
    // Two independently connected Control sessions — the second stands in for an attacker holding a
    // second, Control-permissioned connection (a stolen credential, a compromised device) who was never
    // party to the first command at all. It captures that command's own event off the live-control
    // channel and replays it, moments later, as if it were issuing a fresh one of its own.
    const legitimate = joined(hub, 'live-control', OPERATOR);
    const intruder = joined(hub, 'live-control', OPERATOR);
    legitimate.connection?.receive(command({ id: 'command-a', idempotencyKey: 'key-a', clientStateRevision: 0 }));
    expect(hub.stateRevision()).toBe(1);
    const captured = intruder.far.frames().find((frame) => frame['kind'] === 'event');
    expect(captured).toMatchObject({ stateRevision: 1 });

    // Replayed under a key of the intruder's own choosing — an attacker rewriting the frame to dodge the
    // duplicate check gets no further: the revision it carries is the one that was current when it was
    // captured, and the hub has already moved past it.
    intruder.connection?.receive(
      command({ id: 'command-replayed', idempotencyKey: 'key-intruder-1', clientStateRevision: 0 }),
    );
    expect(hub.stateRevision()).toBe(1);
    expect(intruder.far.frames().at(-1)).toMatchObject({
      kind: 'ack',
      id: 'command-replayed',
      outcome: 'stale',
      conflictCode: STALE_STATE_REVISION,
      stateRevision: 1,
    });
    // Nothing landed for it: the one event either session has seen is still the legitimate command's own.
    expect(legitimate.far.frames().filter((frame) => frame['kind'] === 'event')).toHaveLength(1);
    expect(intruder.far.frames().filter((frame) => frame['kind'] === 'event')).toHaveLength(1);
  });
});

describe('resuming from the sequence a client last saw', () => {
  const resume = (fromSequence: number, channel: LiveChannel = 'audience'): string =>
    JSON.stringify({ kind: 'resume', channel, fromSequence });

  it('replays exactly what was missed, once each and in order, and nothing else', () => {
    const hub = hubAt();
    moved(hub, 3);
    const audience = joined(hub, 'audience');
    audience.connection?.receive(resume(1));

    const answered = audience.far.frames().slice(1);
    // The revision the snapshot carries is the one that was current at sequence 1, not the server's
    // present revision of 3 — the wire must never hand a resuming client a revision that then goes
    // backwards through the events replayed after it.
    expect(answered[0]).toEqual({ kind: 'snapshot', channel: 'audience', stateRevision: 1, sequence: 1, at: AT });
    expect(answered.slice(1)).toMatchObject([
      { kind: 'event', channel: 'audience', sequence: 2, stateRevision: 2 },
      { kind: 'event', channel: 'audience', sequence: 3, stateRevision: 3 },
    ]);
  });

  it('never hands a resuming client a revision that then goes backwards, resuming from before anything was published', () => {
    const hub = hubAt();
    // Joined before the first command runs, so this session's own first snapshot names sequence 0 — a
    // value every session legitimately resumes from later.
    const audience = joined(hub, 'audience');
    moved(hub, 3);
    const before = audience.far.frames().length;
    audience.connection?.receive(resume(0));

    const answered = audience.far.frames().slice(before);
    // The revision the snapshot carries must still be the one that was current at sequence 0 — 0 — and
    // not the server's present revision of 3.
    expect(answered[0]).toEqual({ kind: 'snapshot', channel: 'audience', stateRevision: 0, sequence: 0, at: AT });
    expect(answered.slice(1)).toMatchObject([
      { kind: 'event', channel: 'audience', sequence: 1, stateRevision: 1 },
      { kind: 'event', channel: 'audience', sequence: 2, stateRevision: 2 },
      { kind: 'event', channel: 'audience', sequence: 3, stateRevision: 3 },
    ]);
  });

  it('replays nothing at all for a client that missed nothing', () => {
    const hub = hubAt();
    moved(hub, 2);
    const audience = joined(hub, 'audience');
    audience.connection?.receive(resume(2));
    expect(audience.far.frames().slice(1)).toEqual([
      { kind: 'snapshot', channel: 'audience', stateRevision: 2, sequence: 2, at: AT },
    ]);
  });

  it('recovers the revision at a sequence the backlog window has already trimmed away, without it going backwards', () => {
    const hub = hubAt({ backlogFrames: 2 });
    moved(hub, 4);
    const audience = joined(hub, 'audience');
    // The oldest sequence still held is 3, one past fromSequence — reachable, but the backlog no longer
    // carries the entry named by fromSequence itself for revisionAt to read a stateRevision off of.
    audience.connection?.receive(resume(2));
    expect(audience.far.frames().slice(1)).toMatchObject([
      { kind: 'snapshot', channel: 'audience', stateRevision: 2, sequence: 2 },
      { kind: 'event', channel: 'audience', sequence: 3, stateRevision: 3 },
      { kind: 'event', channel: 'audience', sequence: 4, stateRevision: 4 },
    ]);
  });

  it('resynchronises a client whose missed window is no longer held, rather than skipping events silently', () => {
    const hub = hubAt({ backlogFrames: 2 });
    moved(hub, 4);
    const audience = joined(hub, 'audience');
    audience.connection?.receive(resume(1));
    // The snapshot lands at the server's own sequence, which is how the client sees its position jump
    // instead of being handed a stream with a hole in it.
    expect(audience.far.frames().slice(1)).toEqual([
      { kind: 'snapshot', channel: 'audience', stateRevision: 4, sequence: 4, at: AT },
    ]);
  });

  it('resynchronises a client claiming a sequence this server never issued', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    audience.connection?.receive(resume(7));
    expect(audience.far.frames().slice(1)).toEqual([
      { kind: 'snapshot', channel: 'audience', stateRevision: 0, sequence: 0, at: AT },
    ]);
  });

  it('closes a session resuming a channel it is not connected to', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    audience.connection?.receive(resume(0, 'stage'));
    expect(audience.far.ended()).toEqual({
      code: LIVE_CLOSE.refused,
      reason: 'resume.channel: this session is connected to audience',
    });
  });

  it('recovers a run a client was disconnected in the middle of, with no gap and no duplicate', () => {
    const hub = hubAt();
    const first = joined(hub, 'stage');
    const control = moved(hub, 1);
    expect(first.far.frames().at(-1)).toMatchObject({ kind: 'event', sequence: 1 });

    // The connection goes, the way a network does: without a word, while the run carries on.
    first.far.vanish();
    first.connection?.leave();
    control.connection?.receive(command({ id: 'command-x', idempotencyKey: 'key-x', clientStateRevision: 1 }));
    control.connection?.receive(command({ id: 'command-y', idempotencyKey: 'key-y', clientStateRevision: 2 }));

    const again = joined(hub, 'stage');
    again.connection?.receive(resume(1, 'stage'));
    expect(again.far.frames().slice(1)).toMatchObject([
      { kind: 'snapshot', sequence: 1, stateRevision: 1 },
      { kind: 'event', sequence: 2 },
      { kind: 'event', sequence: 3 },
    ]);
  });
});

describe('a frame this protocol will not read', () => {
  it('closes a session that sent something that is not JSON at all', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    audience.connection?.receive('{ not json');
    expect(audience.far.ended()).toEqual({ code: LIVE_CLOSE.unreadable, reason: 'frame: must be JSON' });
  });

  it('closes a session naming every defect it found, cut to what a close frame carries', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    audience.connection?.receive(JSON.stringify({ kind: 'resume', channel: 'audience', fromSequence: -1 }));
    expect(audience.far.ended()).toEqual({
      code: LIVE_CLOSE.unreadable,
      reason: 'resume.fromSequence: must be at least 0',
    });
  });

  it('cuts a reason longer than a close frame carries rather than dropping it', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    audience.connection?.receive(JSON.stringify({ kind: 'command', channel: 'audience' }));
    expect(audience.far.ended()?.reason.length).toBeLessThanOrEqual(MAX_CLOSE_REASON);
    expect(audience.far.ended()?.code).toBe(LIVE_CLOSE.unreadable);
  });

  it.each(['snapshot', 'event', 'ack'] as const)('closes a session that sent a %s, which is the server’s to send', (kind) => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    audience.connection?.receive(
      JSON.stringify({
        kind,
        channel: 'audience',
        id: 'command-1',
        outcome: 'applied',
        sequence: 1,
        stateRevision: 1,
        type: 'current-slide-changed',
        mutatesState: true,
        at: AT,
      }),
    );
    expect(audience.far.ended()).toEqual({
      code: LIVE_CLOSE.refused,
      reason: `${kind}: a client does not send this frame`,
    });
  });
});

describe('the heartbeat a session is held open by', () => {
  it('reaches every connection on every tick', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    hub.tick();
    expect(audience.far.frames().at(-1)).toEqual({ kind: 'heartbeat', channel: 'audience', at: AT });
  });

  it('holds a session open for as long as it keeps answering', () => {
    const hub = hubAt({ heartbeatLapses: 1 });
    const audience = joined(hub, 'audience');
    for (let tick = 0; tick < 6; tick += 1) {
      hub.tick();
      audience.connection?.receive(JSON.stringify({ kind: 'heartbeat', channel: 'audience', at: AT }));
    }
    expect(audience.far.ended()).toBeUndefined();
  });

  it('holds it open for a session that is busy sending something else instead', () => {
    const hub = hubAt({ heartbeatLapses: 1 });
    const control = joined(hub, 'live-control', OPERATOR);
    for (let tick = 0; tick < 4; tick += 1) {
      hub.tick();
      control.connection?.receive(command({ id: `command-${tick}`, idempotencyKey: `key-${tick}`, clientStateRevision: tick }));
    }
    expect(control.far.ended()).toBeUndefined();
  });

  it('closes a session that left more heartbeats unanswered than it is allowed to', () => {
    const hub = hubAt({ heartbeatLapses: 2 });
    const audience = joined(hub, 'audience');
    hub.tick();
    hub.tick();
    expect(audience.far.ended()).toBeUndefined();
    hub.tick();
    expect(audience.far.ended()).toEqual({
      code: LIVE_CLOSE.lapsed,
      reason: 'heartbeat: this session left 2 of them unanswered',
    });
  });

  it('stops writing to a session it closed for lapsing', () => {
    const hub = hubAt({ heartbeatLapses: 0 });
    const audience = joined(hub, 'audience');
    hub.tick();
    const written = audience.far.frames().length;
    moved(hub, 1);
    hub.tick();
    expect(audience.far.frames()).toHaveLength(written);
  });
});

describe('a consumer that cannot keep up', () => {
  it('queues for a transport that is already full rather than writing into it', () => {
    const hub = hubAt({ highWaterBytes: 10 });
    const audience = joined(hub, 'audience');
    audience.far.hold(64);
    moved(hub, 2);
    expect(audience.far.frames()).toHaveLength(1);
    expect(audience.far.ended()).toBeUndefined();
  });

  it('delivers what it queued, in order and in full, as soon as the transport drains', () => {
    const hub = hubAt({ highWaterBytes: 10 });
    const audience = joined(hub, 'audience');
    audience.far.hold(64);
    moved(hub, 2);
    audience.far.hold(0);
    hub.tick();
    expect(audience.far.frames().slice(1)).toMatchObject([
      { kind: 'event', sequence: 1 },
      { kind: 'event', sequence: 2 },
      { kind: 'heartbeat' },
    ]);
  });

  it('closes a session that falls further behind than the queue held for it', () => {
    const hub = hubAt({ highWaterBytes: 10, pendingFrames: 2 });
    const audience = joined(hub, 'audience');
    audience.far.hold(64);
    moved(hub, 3);
    expect(audience.far.ended()).toEqual({
      code: LIVE_CLOSE.overloaded,
      reason: 'backpressure: this session fell further behind than 2 frames',
    });
  });

  it('carries on serving everybody else while one consumer is behind', () => {
    const hub = hubAt({ highWaterBytes: 10, pendingFrames: 1 });
    const slow = joined(hub, 'audience');
    const quick = joined(hub, 'stage');
    slow.far.hold(64);
    moved(hub, 3);
    expect(slow.far.ended()?.code).toBe(LIVE_CLOSE.overloaded);
    expect(quick.far.frames().filter((frame) => frame['kind'] === 'event')).toHaveLength(3);
  });
});

describe('a connection that is no longer there', () => {
  it.each([false, true])('closes a transport after an encoding failure, even when close throws: %s', (closeThrows) => {
    const hub = hubAt();
    const lost = joined(hub, 'audience');
    const kept = joined(hub, 'stage');
    const send = vi.spyOn(lost.far.transport, 'send').mockImplementation(() => {
      throw new TypeError('encoding failed');
    });
    const close = vi.spyOn(lost.far.transport, 'close');
    if (closeThrows) close.mockImplementation(() => { throw new Error('close failed'); });

    expect(() => moved(hub, 2)).not.toThrow();
    expect(close).toHaveBeenCalledExactlyOnceWith(
      LIVE_CLOSE.overloaded, 'transport: this session could not be written to',
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(hub.connectionCounts().audience).toBe(0);
    expect(kept.far.frames().filter((frame) => frame['kind'] === 'event')).toHaveLength(2);
    expect(hub.stateRevision()).toBe(2);
  });

  it('is dropped when a write to it fails, and the run carries on for everyone else', () => {
    const hub = hubAt();
    const lost = joined(hub, 'audience');
    const kept = joined(hub, 'stage');
    lost.far.vanish();
    moved(hub, 2);
    expect(lost.far.frames()).toHaveLength(1);
    expect(kept.far.frames().filter((frame) => frame['kind'] === 'event')).toHaveLength(2);
    expect(hub.stateRevision()).toBe(2);
  });

  it('is written to no more once it has left', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    audience.connection?.leave();
    moved(hub, 1);
    hub.tick();
    expect(audience.far.kinds()).toEqual(['snapshot']);
  });

  it('reads nothing more from a session that already left, rather than answering it', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    audience.connection?.leave();
    audience.connection?.receive('{ not json');
    expect(audience.far.ended()).toBeUndefined();
  });
});

describe('connection counts by view type', () => {
  it('starts at zero for every view type, with nothing open yet', () => {
    const hub = hubAt();
    expect(hub.connectionCounts()).toEqual({ control: 0, audience: 0, guest: 0, stage: 0, singer: 0 });
  });

  it('counts each channel a session joins under its own view type', () => {
    const hub = hubAt();
    joined(hub, 'live-control', OPERATOR);
    joined(hub, 'audience');
    joined(hub, 'audience');
    joined(hub, 'stage');
    joined(hub, 'singer');
    expect(hub.connectionCounts()).toEqual({ control: 1, audience: 2, guest: 0, stage: 1, singer: 1 });
  });

  it('counts a capability-admitted connection as Guest rather than Audience, though both watch the same channel', () => {
    const hub = hubAt();
    joined(hub, 'audience');
    joined(hub, 'audience', VIEW_GRANTS.audience, true);
    expect(hub.connectionCounts()).toEqual({ control: 0, audience: 1, guest: 1, stage: 0, singer: 0 });
  });

  it('drops a connection from its count the moment it leaves', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    expect(hub.connectionCounts().audience).toBe(1);
    audience.connection?.leave();
    expect(hub.connectionCounts().audience).toBe(0);
  });

  it('counts a reconnection the same as any other join, once a prior one has left', () => {
    const hub = hubAt();
    const first = joined(hub, 'stage');
    first.connection?.leave();
    joined(hub, 'stage');
    expect(hub.connectionCounts().stage).toBe(1);
  });

  it('stops counting a connection once its heartbeat has lapsed, the same instant it is ended', () => {
    const hub = hubAt({ heartbeatLapses: 1 });
    joined(hub, 'audience');
    expect(hub.connectionCounts().audience).toBe(1);
    hub.tick();
    expect(hub.connectionCounts().audience).toBe(1);
    hub.tick();
    expect(hub.connectionCounts().audience).toBe(0);
  });

  it('answers counts only, never a per-connection row a Guest could be picked out of', () => {
    const hub = hubAt();
    joined(hub, 'live-control', OPERATOR);
    joined(hub, 'audience', VIEW_GRANTS.audience, true);
    const counts = hub.connectionCounts();
    expect(Object.keys(counts).sort()).toEqual(['audience', 'control', 'guest', 'singer', 'stage']);
    expect(Object.values(counts).every((value) => typeof value === 'number')).toBe(true);
  });
});

describe('resume amplification budget', () => {
  it('allows one replay per five seconds per member, without heartbeats resetting the budget', () => {
    let clock = Date.parse(AT);
    const hub = hubAt({ clock: () => new Date(clock).toISOString() });
    for (let index = 0; index < 256; index += 1) hub.publish('current-slide-changed');
    const first = joined(hub, 'audience');
    const second = joined(hub, 'audience');
    const resume = JSON.stringify({ kind: 'resume', channel: 'audience', fromSequence: 0 });
    first.connection?.receive(resume);
    expect(first.far.frames()).toHaveLength(258);
    for (let index = 0; index < 20; index += 1) first.connection?.receive(resume);
    first.connection?.receive(JSON.stringify({ kind: 'heartbeat', channel: 'audience', at: AT }));
    clock += 4999;
    first.connection?.receive(resume);
    expect(first.far.frames()).toHaveLength(258);
    second.connection?.receive(resume);
    expect(second.far.frames()).toHaveLength(258);
    clock += 1;
    first.connection?.receive(resume);
    expect(first.far.frames()).toHaveLength(515);
    expect(first.far.ended()).toBeUndefined();
  });

  it('also limits resumes that fall outside the replay window', () => {
    const hub = hubAt();
    const audience = joined(hub, 'audience');
    const resume = JSON.stringify({ kind: 'resume', channel: 'audience', fromSequence: 999 });
    audience.connection?.receive(resume);
    audience.connection?.receive(resume);
    expect(audience.far.kinds()).toEqual(['snapshot', 'snapshot']);
  });
});

describe('private control command isolation', () => {
  it.each(['private-search', 'passage-preview', 'draft-edit', 'constructor'])('never publishes or replays %s to output views', (type) => {
    const hub = hubAt();
    const surfaces = OUTPUT_CHANNELS.map((channel) => joined(hub, channel));
    const guest = joined(hub, 'audience', VIEW_GRANTS.audience, true);
    const control = joined(hub, 'live-control', OPERATOR);
    control.connection?.receive(command({ type }));
    expect(control.far.frames().at(-1)).toMatchObject({ kind: 'ack', outcome: 'unauthorized' });
    expect(hub.stateRevision()).toBe(0);
    expect(hub.sequence()).toBe(0);
    for (const surface of [...surfaces, guest]) expect(surface.far.kinds()).toEqual(['snapshot']);
    guest.connection?.receive(JSON.stringify({ kind: 'resume', channel: 'audience', fromSequence: 0 }));
    expect(guest.far.kinds()).toEqual(['snapshot', 'snapshot']);
  });

  it.each(['current-slide-changed', 'standby-changed', 'theme-changed', 'run-state-changed'])('allows the public change %s', (type) => {
    const hub = hubAt();
    const guest = joined(hub, 'audience', VIEW_GRANTS.audience, true);
    const control = joined(hub, 'live-control', OPERATOR);
    control.connection?.receive(command({ type }));
    expect(guest.far.frames().at(-1)).toMatchObject({ kind: 'event', type });
    expect(control.far.frames().at(-1)).toMatchObject({ outcome: 'applied' });
  });
});

describe('revoked live members', () => {
  it('ends only matching capabilities, discards queued access, and preserves ordinary sessions', () => {
    const hub = hubAt({ highWaterBytes: 1 });
    const grant = { ...VIEW_GRANTS.audience, capabilityId: 'revoked-id' };
    const first = joined(hub, 'audience', grant, true);
    const second = joined(hub, 'audience', grant, true);
    const other = joined(hub, 'audience', { ...VIEW_GRANTS.audience, capabilityId: 'other-id' }, true);
    const ordinary = joined(hub, 'audience');
    first.far.hold(2);
    hub.publish('theme-changed');
    hub.revokeCapability('revoked-id');
    hub.revokeCapability('revoked-id');
    expect(first.far.ended()?.code).toBe(LIVE_CLOSE.refused);
    expect(second.far.ended()?.code).toBe(LIVE_CLOSE.refused);
    expect(other.far.ended()).toBeUndefined();
    expect(ordinary.far.ended()).toBeUndefined();
    expect(hub.connectionCounts()).toMatchObject({ guest: 1, audience: 1 });
    first.far.hold(0);
    first.connection?.receive(JSON.stringify({ kind: 'resume', channel: 'audience', fromSequence: 0 }));
    hub.tick();
    hub.publish('standby-changed');
    expect(first.far.kinds()).toEqual(['snapshot']);
    expect(second.far.kinds()).toEqual(['snapshot', 'event']);
    hub.revokeCapability(undefined);
    expect(other.far.ended()?.code).toBe(LIVE_CLOSE.refused);
    expect(ordinary.far.ended()).toBeUndefined();
    expect(hub.connectionCounts()).toMatchObject({ guest: 0, audience: 1 });
  });
});

describe('delegated commands', () => {
  it('seeds the revision monotonically without moving sequence', () => {
    const hub = hubAt();
    hub.seedStateRevision(12);
    hub.seedStateRevision(3);
    expect(hub.stateRevision()).toBe(12);
    expect(hub.sequence()).toBe(0);
    hub.publish('run-state-changed');
    expect(hub.stateRevision()).toBe(13);
  });

  it('delegates command policy and remembers only applied commands', async () => {
    const hub = hubAt();
    const received: unknown[] = [];
    hub.useCommands(async (member, frame) => {
      received.push({ member, frame });
      hub.publish('run-state-changed');
      return { outcome: frame.type === 'pause' ? 'applied' : 'invalid' };
    });
    const { connection, far } = joined(hub, 'live-control', OPERATOR, false, 'operator');
    connection?.receive(command({ type: 'pause', clientStateRevision: 999 }));
    await Promise.resolve();
    expect(far.frames().at(-1)).toMatchObject({ outcome: 'applied', stateRevision: 1 });
    expect(received).toMatchObject([{ member: { channel: 'live-control', grant: OPERATOR, identity: 'operator' } }]);
    connection?.receive(command({ type: 'pause' }));
    expect(far.frames().at(-1)).toMatchObject({ outcome: 'duplicate' });
    expect(received).toHaveLength(1);
    for (let i = 0; i < 2; i += 1) {
      connection?.receive(command({ type: 'unknown', idempotencyKey: 'invalid' }));
      await Promise.resolve();
      expect(far.frames().at(-1)).toMatchObject({ outcome: 'invalid' });
    }
    expect(received).toHaveLength(3);
  });

  it('refuses unprivileged commands before delegation', () => {
    const hub = hubAt();
    hub.useCommands(async () => { throw new Error('must not delegate'); });
    const { connection, far } = joined(hub, 'stage');
    connection?.receive(command({ channel: 'stage', type: 'pause' }));
    expect(far.frames().at(-1)).toMatchObject({ outcome: 'unauthorized' });
  });

  it('acks failed, and keeps serving, when the command handler rejects', async () => {
    const hub = hubAt();
    hub.useCommands(async () => { throw new Error('mongo went away'); });
    const { connection, far } = joined(hub, 'live-control', OPERATOR);
    const watcher = joined(hub, 'audience');
    connection?.receive(command({ type: 'pause' }));
    await vi.waitFor(() => expect(far.frames().at(-1)).toMatchObject({ kind: 'ack', outcome: 'failed' }));
    expect(far.ended()).toBeUndefined();
    hub.publish('run-state-changed');
    expect(watcher.far.kinds()).toEqual(['snapshot', 'event']);
  });

  it('does not acknowledge a connection that closes while the command is pending', async () => {
    const hub = hubAt();
    let finish: (() => void) | undefined;
    hub.useCommands(() => new Promise((resolve) => { finish = () => resolve({ outcome: 'applied' }); }));
    const { connection, far } = joined(hub, 'live-control', OPERATOR);
    connection?.receive(command({ type: 'pause' }));
    connection?.leave();
    finish?.();
    await Promise.resolve();
    expect(far.kinds()).toEqual(['snapshot']);
  });
});
