// A single-document lease naming whether a restore is being applied to production right now (OPS-06).
//
// Modeled directly on `scheduler-state.ts`: operational bookkeeping, not a durable record, so it is kept
// outside the repositories in `records.ts` the same way and for the same reason (ADR 0009 — that layer has
// no update verb, and a lease is nothing but an update). Gated by no `RequestContext`/`permit()` either,
// for the same reason `scheduler-state.ts` is not: nothing here is an actor's to be granted or refused,
// only the worker that acquires the lease around `applyRestore` and the route guard that reads whether one
// is held.
//
// `guardMaintenance` is this module's other half: a hook mirroring `csrf.ts`'s `guardMutations` in shape,
// refusing every mutating request with 503 `server.maintenance_active` while the lease is held — the one
// moment this deployment asks a client to wait rather than to fix its request, because production is
// mid-restore underneath it.

import { MAINTENANCE_ACTIVE, errorEnvelope } from '@holydeck/contracts/http';
import { mutates } from '@holydeck/contracts/sessions';

import type { FastifyInstance } from 'fastify';
import type { Db } from 'mongodb';

import type { Document, Filter } from './repositories.js';

export const MAINTENANCE_COLLECTION = 'maintenance';
const DOC_ID = 'maintenance';

// The lease has no heartbeat of its own — the job holding it may run for a long time and nothing here
// renews it mid-job. This TTL is a safety net, not a per-job timeout: generous enough that no real restore
// or media migration ever hits it, so it only ever fires for a lease a crashed worker (SIGKILL, OOM,
// container restart) left behind with no `finally` left to run. `releaseOrphanedLease` below is the other
// half of the same problem, for the deployment's normal path back from that: a worker that restarts.
export const MAINTENANCE_LEASE_TTL_MS = 60 * 60 * 1000;

export interface MaintenanceState {
  readonly active: boolean;
  readonly reason?: string;
  readonly startedAt?: string;
}

const IDLE: MaintenanceState = { active: false };

/** The slice of a Mongo collection maintenance uses. Narrow on purpose: a test can supply all of it. */
export interface MaintenanceCollection {
  findOne(filter: Filter): Promise<Document | null>;
  findOneAndUpdate(
    filter: Filter,
    update: Document,
    options: { readonly upsert: true; readonly returnDocument: 'after' },
  ): Promise<Document>;
}

export interface MaintenanceDb {
  collection(name: string): MaintenanceCollection;
}

export interface MaintenanceStore {
  read(): Promise<MaintenanceState>;
  /** Acquires the lease. Idempotent by design — a second acquire while one is held just restates it. */
  acquire(reason: string, at: string): Promise<void>;
  release(): Promise<void>;
}

export function maintenanceOn(db: MaintenanceDb): MaintenanceStore {
  const doc = (): MaintenanceCollection => db.collection(MAINTENANCE_COLLECTION);
  const store: MaintenanceStore = {
    async read() {
      const found = await doc().findOne({ _id: DOC_ID });
      if (found === null) return IDLE;
      return {
        active: Boolean(found['active']),
        ...(typeof found['reason'] === 'string' ? { reason: found['reason'] } : {}),
        ...(typeof found['startedAt'] === 'string' ? { startedAt: found['startedAt'] } : {}),
      };
    },
    async acquire(reason, at) {
      await doc().findOneAndUpdate(
        { _id: DOC_ID },
        { $set: { active: true, reason, startedAt: at } },
        { upsert: true, returnDocument: 'after' },
      );
    },
    async release() {
      await doc().findOneAndUpdate(
        { _id: DOC_ID },
        { $set: { active: false }, $unset: { reason: '', startedAt: '' } },
        { upsert: true, returnDocument: 'after' },
      );
    },
  };
  return Object.freeze(store);
}

export function maintenanceDb(db: Db): MaintenanceDb {
  return { collection: (name) => db.collection(name) as unknown as MaintenanceCollection };
}

/**
 * Clears a lease left behind by a worker process that never reached its handler's `finally` — the crash
 * case `release()` there cannot cover. Safe to call unconditionally at worker startup: this deployment runs
 * one worker, so a lease still active when a fresh process starts up was necessarily orphaned by whichever
 * process held it before, never a sibling actually mid-job.
 */
export async function releaseOrphanedLease(store: MaintenanceStore, report: (line: string) => void): Promise<void> {
  const state = await store.read();
  if (!state.active) return;
  await store.release();
  report(`released an orphaned maintenance lease (${state.reason ?? 'no reason recorded'})`);
}

export interface GuardMaintenanceOptions {
  /** Absent in a deployment that keeps no durable records, which is a deployment no restore can apply to. */
  readonly maintenance: MaintenanceStore | undefined;
  /** Compared against the lease's `startedAt` to age it out past `MAINTENANCE_LEASE_TTL_MS`. */
  readonly now: () => string;
}

const REFUSED_MESSAGE = 'A restore is being applied to production. Try again once it finishes.';

/** Never the lease's own `reason` — that can carry a filesystem path or a backupId, and this runs before auth. */
const REFUSED_DETAIL = 'a restore is applying';

/** A lease is stale once it has outlived `MAINTENANCE_LEASE_TTL_MS`, `startedAt` included. */
const isStale = (state: MaintenanceState, now: string): boolean =>
  state.startedAt !== undefined && Date.parse(now) - Date.parse(state.startedAt) > MAINTENANCE_LEASE_TTL_MS;

/**
 * Refuses every mutating request while a restore holds the lease, the same reach `guardMutations` has —
 * every route registered after this one is covered, which is why `app.ts` installs it beside that guard.
 */
export function guardMaintenance(app: FastifyInstance, { maintenance, now }: GuardMaintenanceOptions): void {
  if (maintenance === undefined) return;
  app.addHook('onRequest', async (request, reply) => {
    if (!mutates(request.method)) return;
    const state = await maintenance.read();
    if (!state.active || isStale(state, now())) return;
    await reply
      .code(503)
      .send(
        errorEnvelope(MAINTENANCE_ACTIVE, REFUSED_MESSAGE, request.id, [
          { path: 'maintenance', code: MAINTENANCE_ACTIVE, message: REFUSED_DETAIL },
        ]),
      );
  });
}
