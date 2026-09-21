// Reconnect reconciliation (OFFL-05, invariant 8): "Reconnect replaces stale local state from the
// server and never uploads offline edits or stale live commands." T98's `audience-offline.ts` already
// covers the live-session half of a reconnect — recovering the `live` reading once `LiveStatus.state`
// resynchronises. This module is the other half: the *content* a surface read while it was behind the
// server, which a status flip alone says nothing about discarding.
//
// The signal this keys off is `LiveSnapshot.resynchronised` (`live-client.ts`), not `LiveStatus` at all:
// "the server answered with its own standing rather than the replay this context asked for — the
// divergence correction. Anything a surface rendered from local state is stale and is re-read." An
// ordinary resume snapshot (`resynchronised: false`) answers exactly the replay a surface asked for, so
// there is nothing here to correct and nothing is done.
//
// A `SnapshotFrame` carries a channel, a revision and a sequence — never content. So "discard, here's the
// truth" cannot mean handing a reader a value to adopt; it means telling a reader plainly that whatever
// it is holding is no longer trustworthy, so it goes back to wherever its own truth actually lives (a
// fresh read, a re-fetch, a re-derivation) rather than keep showing what it had. That is also why this
// never *merges*: a reader given both an old value and a new frame could try to reconcile the two itself,
// which is exactly the second source of truth `live-client.ts`'s header forbids. `discard` takes no value
// to weigh against the old one — only the frame naming the revision the discard is *as of*.
//
// This module never becomes a fourth way to reach `command()`. It is not itself a queue, a cache or a
// store: it is the one place a reader registers to be told "stop trusting what you have," and nothing
// more. Its dependency on `LiveClient` is narrowed to `Pick<LiveClient, 'onSnapshot'>` — the same
// structural-guarantee pattern `audience-offline.ts` uses for `AudienceOfflineLiveClient` — so `command`,
// `connect` and `close` are not merely unused here, they are unnamed: there is no path in this file that
// could reach them, which is what keeps a reconnect from ever re-issuing or resurrecting a stale command
// (T77's `STALE_STATE_REVISION` refusal) on its own initiative.

import type { SnapshotFrame } from '@holydeck/contracts/live';

import type { LiveClient } from './live-client.js';

/** The only thing this module reads off a live context: the resynchronisation signal. No `status`, no
 *  `onStatus` even — connectivity is T98's concern, this one only content. */
export type ReconciliationLiveClient = Pick<LiveClient, 'onSnapshot'>;

/**
 * One surface's own way of being told its local state is stale. `discard` is called with the frame the
 * server just answered with, purely as the revision this discard is as of — not as a value to merge with
 * whatever the reader was holding. What a reader does inside it (clear a field, trigger its own re-fetch,
 * drop a cache) is entirely its own; this module neither knows nor cares.
 */
export interface ReconciledReader {
  discard(frame: SnapshotFrame): void;
}

export interface ReconnectReconciler {
  /** Adds one reader. Returns a function that removes it, the same unsubscribe shape every `on*` listener
   *  in this codebase returns. */
  register(reader: ReconciledReader): () => void;
  /** Stops watching the live context. Readers already registered are simply never called again — nothing
   *  is told to discard on the way out, because closing this down is not the server answering. */
  dispose(): void;
}

/**
 * Watches one live context and tells every registered reader to discard its local state exactly when
 * `resynchronised` says the server corrected this context's standing rather than answered the replay it
 * asked for. Readers are notified in registration order and every one of them is told, never only the
 * first or only while some condition holds — a reconnect that resynchronises is stale for everyone
 * holding local state, not for whichever reader happened to ask first.
 */
export function createReconnectReconciler(live: ReconciliationLiveClient): ReconnectReconciler {
  const readers = new Set<ReconciledReader>();

  const unsubscribe = live.onSnapshot((snapshot) => {
    if (!snapshot.resynchronised) return;
    // Copied before it is walked: the same reason `live-client.ts`'s own `announce` copies its listener
    // set first — a reader is free to unregister itself from inside `discard`.
    for (const reader of [...readers]) reader.discard(snapshot.frame);
  });

  return {
    register(reader: ReconciledReader): () => void {
      readers.add(reader);
      return () => readers.delete(reader);
    },
    dispose(): void {
      unsubscribe();
    },
  };
}
