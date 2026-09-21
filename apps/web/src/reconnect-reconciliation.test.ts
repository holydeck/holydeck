import { STALE_STATE_REVISION } from '@holydeck/contracts/http';
import { LIVE_CONTROL_CHANNEL } from '@holydeck/contracts/live';
import { describe, expect, it, vi } from 'vitest';

import { createLiveClient } from './live-client.js';
import { createReconnectReconciler, type ReconciledReader, type ReconciliationLiveClient } from './reconnect-reconciliation.js';

import type { LiveSnapshot } from './live-client.js';
import type { SnapshotFrame } from '@holydeck/contracts/live';
import type { LiveChannel } from '@holydeck/contracts/live';
import type { LiveClientOptions, LiveCredentials, SocketEventLike, WebSocketLike } from './live-client.js';

const AT = '2026-09-19T10:00:00.000Z';
const ORIGIN = 'https://deployment.invalid';

const frame = (overrides: Partial<SnapshotFrame> = {}): SnapshotFrame => ({
  kind: 'snapshot',
  channel: 'audience',
  stateRevision: 1,
  sequence: 1,
  at: AT,
  ...overrides,
});

/** A live context double exposing only what `ReconciliationLiveClient` names (`onSnapshot`) — this
 *  module has no reference to a mutating `LiveClient` member to call, so that guarantee is enforced
 *  structurally by the narrowed type, not by a runtime spy on a fuller double (the same reasoning
 *  `audience-offline.test.ts` settled on for its own narrowed double). */
function fakeLiveClient(): { live: ReconciliationLiveClient; emit: (snapshot: LiveSnapshot) => void } {
  const listeners = new Set<(snapshot: LiveSnapshot) => void>();
  return {
    live: {
      onSnapshot(listener: (snapshot: LiveSnapshot) => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(snapshot: LiveSnapshot): void {
      for (const listener of [...listeners]) listener(snapshot);
    },
  };
}

describe('createReconnectReconciler', () => {
  it('tells a registered reader to discard on a resynchronising snapshot', () => {
    const { live, emit } = fakeLiveClient();
    const reconciler = createReconnectReconciler(live);
    const discard = vi.fn();
    reconciler.register({ discard });

    const correction = frame({ stateRevision: 5, sequence: 5 });
    emit({ frame: correction, resynchronised: true });

    expect(discard).toHaveBeenCalledExactlyOnceWith(correction);
  });

  it('does nothing on an ordinary snapshot that answered the replay this context asked for', () => {
    const { live, emit } = fakeLiveClient();
    const reconciler = createReconnectReconciler(live);
    const discard = vi.fn();
    reconciler.register({ discard });

    emit({ frame: frame(), resynchronised: false });

    expect(discard).not.toHaveBeenCalled();
  });

  it('replaces a reader’s local state with the server truth rather than merging the two', () => {
    const { live, emit } = fakeLiveClient();
    const reconciler = createReconnectReconciler(live);

    // What this reader is holding: an edit made while offline, and the source it re-reads from once
    // told its copy is stale. A merge would keep something of `localValue`; a replace keeps none of it.
    let localValue = 'offline-edit';
    const truth = new Map([[9, 'server-value']]);
    const reader: ReconciledReader = {
      discard(snapshotFrame): void {
        localValue = truth.get(snapshotFrame.stateRevision) ?? 'unknown';
      },
    };
    reconciler.register(reader);

    emit({ frame: frame({ stateRevision: 9, sequence: 9 }), resynchronised: true });

    expect(localValue).toBe('server-value');
    expect(localValue).not.toBe('offline-edit');
  });

  it('notifies every registered reader, not only the first', () => {
    const { live, emit } = fakeLiveClient();
    const reconciler = createReconnectReconciler(live);
    const first = vi.fn();
    const second = vi.fn();
    reconciler.register({ discard: first });
    reconciler.register({ discard: second });

    emit({ frame: frame(), resynchronised: true });

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('stops telling a reader once it unregisters', () => {
    const { live, emit } = fakeLiveClient();
    const reconciler = createReconnectReconciler(live);
    const discard = vi.fn();
    const unregister = reconciler.register({ discard });

    unregister();
    emit({ frame: frame(), resynchronised: true });

    expect(discard).not.toHaveBeenCalled();
  });

  it('stops watching the live context once disposed', () => {
    const { live, emit } = fakeLiveClient();
    const reconciler = createReconnectReconciler(live);
    const discard = vi.fn();
    reconciler.register({ discard });

    reconciler.dispose();
    emit({ frame: frame(), resynchronised: true });

    expect(discard).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------
// Against a real client and a real (faked) socket: a reconnect that resynchronises alongside a command
// the server had already refused as stale (T77), proving the two coexist without reconciliation ever
// putting a frame on the wire of its own.
// ---------------------------------------------------------------------------------------------------

type Frame = Record<string, unknown>;

interface FarSide {
  readonly socket: WebSocketLike;
  sent(): readonly Frame[];
  accept(): void;
  deliver(raw: Frame): void;
}

/** Trimmed to what this file needs from `live-client.test.ts`'s own `far`/`sockets`/`clientOn` — each
 *  test file in this module keeps its own doubles rather than importing another file's test-only
 *  fixtures, the same precedent `audience-offline.test.ts` follows. */
const far = (): FarSide => {
  const listeners = new Map<string, ((event: SocketEventLike) => void)[]>();
  const written: string[] = [];
  let readyState = 0;

  const fire = (type: string, event: SocketEventLike): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  };

  const socket: WebSocketLike = {
    get readyState(): number {
      return readyState;
    },
    send(data: string): void {
      written.push(data);
    },
    close(): void {
      readyState = 3;
    },
    addEventListener(type: string, listener: (event: SocketEventLike) => void): void {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };

  return {
    socket,
    sent: (): readonly Frame[] => written.map((text) => JSON.parse(text) as Frame),
    accept: (): void => {
      readyState = 1;
      fire('open', {});
    },
    deliver: (rawFrame: Frame): void => fire('message', { data: JSON.stringify(rawFrame) }),
  };
};

const clientOn = (channel: LiveChannel, overrides: Partial<LiveClientOptions> = {}) => {
  const side = far();
  const client = createLiveClient({
    channel,
    origin: ORIGIN,
    credentials: async (): Promise<LiveCredentials> => ({ kind: 'ticket', ticket: 'ticket-1' }),
    open: (): WebSocketLike => side.socket,
    clock: () => AT,
    retry: () => undefined,
    ...overrides,
  });
  return { client, side };
};

describe('reconciliation alongside a stale command refusal', () => {
  it('discards local state on reconnect without resurrecting the command the server refused as stale', async () => {
    const { client, side } = clientOn(LIVE_CONTROL_CHANNEL);
    await client.connect();
    side.accept();
    side.deliver({ kind: 'snapshot', channel: LIVE_CONTROL_CHANNEL, stateRevision: 1, sequence: 1, at: AT });

    const refused = client.command('show-slide', 'key-1');
    const sent = side.sent().at(-1);
    side.deliver({
      kind: 'ack',
      channel: LIVE_CONTROL_CHANNEL,
      id: String(sent?.['id']),
      outcome: 'stale',
      conflictCode: STALE_STATE_REVISION,
      stateRevision: 7,
      sequence: 7,
      at: AT,
    });

    // T77's own guarantee, re-asserted here rather than assumed: the refusal is not silently applied.
    expect(await refused).toMatchObject({ outcome: 'stale', conflictCode: STALE_STATE_REVISION });

    const reconciler = createReconnectReconciler(client);
    const discard = vi.fn();
    reconciler.register({ discard });
    const sentBeforeReconnect = side.sent().length;

    // The server answers with its own standing rather than the replay this context asked for.
    side.deliver({ kind: 'snapshot', channel: LIVE_CONTROL_CHANNEL, stateRevision: 9, sequence: 9, at: AT });

    expect(discard).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ stateRevision: 9, sequence: 9 }),
    );
    // Reconciliation never re-issues or resurrects the command the server already refused, nor issues
    // any command of its own: nothing new reached the wire.
    expect(side.sent()).toHaveLength(sentBeforeReconnect);
  });
});
