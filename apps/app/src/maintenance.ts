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

export interface GuardMaintenanceOptions {
  /** Absent in a deployment that keeps no durable records, which is a deployment no restore can apply to. */
  readonly maintenance: MaintenanceStore | undefined;
}

const REFUSED_MESSAGE = 'A restore is being applied to production. Try again once it finishes.';

/**
 * Refuses every mutating request while a restore holds the lease, the same reach `guardMutations` has —
 * every route registered after this one is covered, which is why `app.ts` installs it beside that guard.
 */
export function guardMaintenance(app: FastifyInstance, { maintenance }: GuardMaintenanceOptions): void {
  if (maintenance === undefined) return;
  app.addHook('onRequest', async (request, reply) => {
    if (!mutates(request.method)) return;
    const state = await maintenance.read();
    if (!state.active) return;
    await reply
      .code(503)
      .send(
        errorEnvelope(MAINTENANCE_ACTIVE, REFUSED_MESSAGE, request.id, [
          { path: 'maintenance', code: MAINTENANCE_ACTIVE, message: state.reason ?? 'a restore is applying' },
        ]),
      );
  });
}
