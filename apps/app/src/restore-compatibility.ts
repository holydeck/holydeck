// A single-document marker naming when a restore was last applied to production (OPS-06). Read by
// `csrf.ts`'s session-failure path to tell a client its session ended *because of* that restore, rather
// than by ordinary expiry — the one case a stale session should be answered `client.update_required`
// (426) instead of `auth.session.expired` (401), so the client reloads instead of just signing back in.
//
// Modeled directly on `maintenance.ts`: operational bookkeeping, not a durable record, kept outside the
// repositories in `records.ts` for the same reason (ADR 0009 — no update verb there, and this is nothing
// but an update). Gated by no `RequestContext`/`permit()` either, for the same reason: nothing here is an
// actor's to be granted or refused, only the worker that records a restore and the guard that reads it.
//
// This is deliberately coarser than a per-session-token record of exactly which sessions a restore ended:
// `sessions.ts`'s `revokeEvery` is hardened, already-tested destructive-path code (plan R5), and a precise
// tombstone would mean touching it. Instead, any session lookup that fails within
// `RESTORE_COMPATIBILITY_WINDOW_MS` of the last recorded restore is treated as restore-caused. The
// trade-off is a false positive for an unrelated stale/garbage cookie presented in that same window — it
// gets told to update rather than to sign in again, which is a difference no client currently acts on, and
// either way the user ends up re-authenticating.

import type { Db } from 'mongodb';

import type { Document, Filter } from './repositories.js';

export const RESTORE_COMPATIBILITY_COLLECTION = 'restore_compatibility';
const DOC_ID = 'restore_compatibility';

// Bounds the grace window on the same constant a session's own absolute lifetime is bounded by
// (`@holydeck/contracts/sessions`'s `SESSION_ABSOLUTE_HOURS`) rather than a new, unrelated magic number:
// a session old enough to predate a restore by more than that has either already reconnected and been
// told, or has expired on its own regardless of any restore.
const SESSION_ABSOLUTE_HOURS = 24;
export const RESTORE_COMPATIBILITY_WINDOW_MS = SESSION_ABSOLUTE_HOURS * 60 * 60 * 1000;

/** The slice of a Mongo collection this store uses. Narrow on purpose: a test can supply all of it. */
export interface RestoreCompatibilityCollection {
  findOne(filter: Filter): Promise<Document | null>;
  findOneAndUpdate(
    filter: Filter,
    update: Document,
    options: { readonly upsert: true; readonly returnDocument: 'after' },
  ): Promise<Document>;
}

export interface RestoreCompatibilityDb {
  collection(name: string): RestoreCompatibilityCollection;
}

export interface RestoreCompatibilityStore {
  /** Whether a production restore was recorded within the grace window of `now()`. */
  restoredRecently(): Promise<boolean>;
  /** Records that a production restore just finished applying, as of `now()`. */
  record(): Promise<void>;
}

export function restoreCompatibilityOn(db: RestoreCompatibilityDb, { now }: { readonly now: () => string }): RestoreCompatibilityStore {
  const doc = (): RestoreCompatibilityCollection => db.collection(RESTORE_COMPATIBILITY_COLLECTION);
  const store: RestoreCompatibilityStore = {
    async restoredRecently() {
      const found = await doc().findOne({ _id: DOC_ID });
      const restoredAt = found?.['restoredAt'];
      if (typeof restoredAt !== 'string') return false;
      return Date.parse(now()) - Date.parse(restoredAt) <= RESTORE_COMPATIBILITY_WINDOW_MS;
    },
    async record() {
      await doc().findOneAndUpdate(
        { _id: DOC_ID },
        { $set: { restoredAt: now() } },
        { upsert: true, returnDocument: 'after' },
      );
    },
  };
  return Object.freeze(store);
}

export function restoreCompatibilityDb(db: Db): RestoreCompatibilityDb {
  return { collection: (name) => db.collection(name) as unknown as RestoreCompatibilityCollection };
}
