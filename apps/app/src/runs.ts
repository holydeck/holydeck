// Presentation run lifecycle: starting a run from a Ready prepared snapshot, ending one explicitly, and
// resuming it — spec LIVE-01, plan invariant 6 (unresolved to exact text in this checkout; treated as
// advisory, the same gap `snapshots.ts`'s own header names for ADRs 0003/0005/0006).
//
// "Resuming" reports exactly the same thing after an application restart as it does right after `start`,
// because nothing about a run is held in a JS closure: every read goes back through the same Mongo-backed
// repository every other domain module reads through, and that repository already re-reads on restart —
// no second persistence mechanism is built here for that alone.
//
// The Operator gate follows THR-11 exactly as `snapshots.ts`'s override does: Control presentation is
// checked before a single record is read or written, so a session without it is refused the same as a
// surface that never drew the control at all.
//
// What this module does not decide: whether a snapshot is Ready is `snapshots.ts`'s `PreparationStore`
// alone (ADR 0003's checklist, ADR 0005's Outdated), which this module asks and never recomputes; what a
// run's clients are shown is the WebSocket protocol T77/T78 build on top of this — `start` fixes a run's
// mode and its position at zero, and nothing here ever moves the position again. A run's own history lives
// in `presentationRuns`, a record class of its own — not `runEvents`, which `snapshots.ts`'s override
// already writes to and a later task (LIVE-12) owns populating with every shown slide and operator change;
// a run starting or ending is recorded once, here, and is not also duplicated into that log.

import { randomBytes } from 'node:crypto';

import { auditOn } from './audit.js';
import { requestContext } from './context.js';
import { permissionsFor as recordPermissions } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';
import { PRESENTATION_CONTROL } from './roles.js';
import { SERVICE_RECORD, subjectFor } from './services.js';
import { SNAPSHOT_PERMISSIONS, preparationOn } from './snapshots.js';

import type { RequestContext } from './context.js';
import type { RepositoryDb } from './repositories.js';
import type { OperatorSession, PreparationStore, ReadinessObservation } from './snapshots.js';

export const RUN_RECORD = 'presentationRuns';
export const RUN_PERMISSIONS = recordPermissions(RUN_RECORD);

/** One name for the trail entry both `start` and `end` write, distinguished only by `detail` — the same
 *  way `services.ts`'s `restamp` files archive and unarchive under one action. */
export const RUN_ACTION = 'presentation.run';

export const RUN_MODES = ['rehearsal', 'live'] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const RUN_PHASES = ['active', 'ended'] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

export interface RunIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

const DECLARED_INDEXES: readonly RunIndex[] = [
  { name: 'presentation_run_order', keys: { runId: 1, sequence: 1 }, options: { unique: true } },
];

export const RUN_INDEXES = Object.freeze(DECLARED_INDEXES);

export type RunRefusal = 'permission' | 'state' | 'conflict' | 'corrupt';

export class RunError extends Error {
  readonly kind: RunRefusal;

  constructor(kind: RunRefusal, message: string) {
    super(message);
    this.name = 'RunError';
    this.kind = kind;
  }
}

/** The context a run is read and written under: its own record, the manifest and Service it reads
 *  readiness from, and its trail. Never `runEvents` — this module does not write there (see header). */
export function runContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [
      ...Object.values(RUN_PERMISSIONS),
      ...Object.values(SNAPSHOT_PERMISSIONS),
      recordPermissions(SERVICE_RECORD).read,
      recordPermissions('auditEvents').append,
    ],
    correlationId,
  });
}

export interface RunRecord {
  readonly runId: string;
  readonly serviceId: string;
  readonly snapshotId: string;
  readonly phase: RunPhase;
  readonly mode: RunMode;
  /** A 0-based ordinal into whatever a run replays. Fixed at 0 by `start`; nothing here moves it — the
   *  WebSocket protocol this lifecycle sits under (T77/T78) is what would advance it. */
  readonly position: number;
  /** When this row — the latest lifecycle change, start or end — was written. */
  readonly at: string;
}

export interface StartRunRequest {
  readonly serviceId: string;
  readonly mode: RunMode;
}

export interface RunStore {
  /** Starts a fresh run from a Ready prepared snapshot. Refuses with a named error from anything else,
   *  Outdated included (spec LIVE-01). Requires Control presentation, checked before anything is read. */
  start(session: OperatorSession, request: StartRunRequest): Promise<RunRecord>;
  /** Ends a run explicitly. Nothing written before this row is rewritten — the run's history is exactly
   *  as it was, with one more row appended. Nothing for a run this code has never heard of. */
  end(session: OperatorSession, runId: string): Promise<RunRecord | undefined>;
  /** A run's persisted state: the same answer whether this is the first read right after `start` or the
   *  first read after this process restarted, since nothing here is held between calls. */
  resume(context: unknown, runId: string): Promise<RunRecord | undefined>;
}

export interface RunOptions {
  readonly now: () => string;
  readonly newId?: () => string;
  /** How this deployment observes the readiness `snapshots.ts` cannot compute for itself — see
   *  `PreparationOptions.observe`, which this mirrors exactly and passes straight through to `readiness`. */
  readonly observe?: (context: unknown, serviceId: string) => Promise<ReadinessObservation> | ReadinessObservation;
}

const RUN_ID_BYTES = 16;
const SEQUENCE_SEPARATOR = '#';

interface StandingRow extends RunRecord {
  readonly sequence: number;
}

function refusalFor(error: unknown): unknown {
  if (error instanceof RepositoryError && error.kind === 'duplicate') {
    return new RunError('conflict', `${error.message}, so another writer already changed this run`);
  }
  return error;
}

const own = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw refusalFor(error);
  }
};

export function runsOn(db: RepositoryDb, options: RunOptions): RunStore {
  const runs = repositoriesOn(db)[RUN_RECORD];
  const trail = auditOn(db, { now: options.now, ...(options.newId === undefined ? {} : { newId: options.newId }) });
  const preparation: PreparationStore = preparationOn(db, { now: options.now });
  const newId = options.newId ?? ((): string => randomBytes(RUN_ID_BYTES).toString('base64url'));
  const observe = options.observe ?? ((): ReadinessObservation => ({}));

  const author = (context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> => {
    const { actor, correlationId } = context as RequestContext;
    return { actor, correlationId };
  };

  const rowFrom = (found: Record<string, unknown>): StandingRow => {
    const { runId, sequence, at, serviceId, snapshotId, phase, mode, position } = found;
    if (
      typeof runId !== 'string' ||
      typeof sequence !== 'number' ||
      typeof at !== 'string' ||
      typeof serviceId !== 'string' ||
      typeof snapshotId !== 'string' ||
      typeof phase !== 'string' ||
      !RUN_PHASES.includes(phase as RunPhase) ||
      typeof mode !== 'string' ||
      !RUN_MODES.includes(mode as RunMode) ||
      typeof position !== 'number' ||
      !Number.isInteger(position) ||
      position < 0
    ) {
      throw new RunError('corrupt', `${String(runId)} holds a run row this code cannot read`);
    }
    return { runId, sequence, at, serviceId, snapshotId, phase: phase as RunPhase, mode: mode as RunMode, position };
  };

  const standing = async (context: unknown, runId: string): Promise<StandingRow | undefined> => {
    const [found] = await runs.read(context, { runId }, { sort: { sequence: -1 }, limit: 1 });
    return found === undefined ? undefined : rowFrom(found);
  };

  const append = async (
    context: unknown,
    fields: Omit<StandingRow, 'at'>,
  ): Promise<RunRecord> => {
    const at = options.now();
    await runs.append(context, { _id: `${fields.runId}${SEQUENCE_SEPARATOR}${fields.sequence}`, at, ...fields, ...author(context) });
    const { runId, serviceId, snapshotId, phase, mode, position } = fields;
    return { runId, serviceId, snapshotId, phase, mode, position, at };
  };

  const store: RunStore = {
    start: (session, request) =>
      own(async () => {
        // THR-11: checked first, before a single read, so the refusal is this server's and not a client's.
        if (!session.permissions.includes(PRESENTATION_CONTROL)) {
          throw new RunError('permission', `starting a run is the Operator's alone, which needs ${PRESENTATION_CONTROL}`);
        }
        const context = runContext(session.actor, session.correlationId);
        const record = await preparation.prepared(context, request.serviceId);
        if (record === undefined) {
          throw new RunError('state', `${request.serviceId} has no prepared manifest to start a run from`);
        }
        const checklist = await preparation.readiness(context, request.serviceId, await observe(context, request.serviceId));
        if (checklist === undefined || checklist.state !== 'ready') {
          const state = checklist?.state ?? 'not prepared';
          throw new RunError('state', `a run starts only from a Ready prepared snapshot, and ${request.serviceId} is ${state}`);
        }
        const runId = newId();
        if ((await standing(context, runId)) !== undefined) {
          throw new RunError('conflict', `${runId} is a run another writer named first`);
        }
        const started = await append(context, {
          runId,
          sequence: 1,
          serviceId: request.serviceId,
          snapshotId: record.snapshot.id,
          phase: 'active',
          mode: request.mode,
          position: 0,
        });
        await trail.record(context, {
          action: RUN_ACTION,
          subject: subjectFor(request.serviceId),
          outcome: 'allowed',
          detail: `Started a ${request.mode} presentation run`,
        });
        return started;
      }),

    end: (session, runId) =>
      own(async () => {
        if (!session.permissions.includes(PRESENTATION_CONTROL)) {
          throw new RunError('permission', `ending a run is the Operator's alone, which needs ${PRESENTATION_CONTROL}`);
        }
        const context = runContext(session.actor, session.correlationId);
        const row = await standing(context, runId);
        if (row === undefined) return undefined;
        if (row.phase === 'ended') {
          throw new RunError('state', `${runId} has already ended, and a run is never ended twice`);
        }
        const record = await append(context, {
          runId,
          sequence: row.sequence + 1,
          serviceId: row.serviceId,
          snapshotId: row.snapshotId,
          phase: 'ended',
          mode: row.mode,
          position: row.position,
        });
        await trail.record(context, {
          action: RUN_ACTION,
          subject: subjectFor(row.serviceId),
          outcome: 'allowed',
          detail: 'Ended a presentation run',
        });
        return record;
      }),

    resume: (context, runId) =>
      own(async () => {
        const row = await standing(context, runId);
        if (row === undefined) return undefined;
        const { runId: id, serviceId, snapshotId, phase, mode, position, at } = row;
        return { runId: id, serviceId, snapshotId, phase, mode, position, at };
      }),
  };
  return Object.freeze(store);
}
