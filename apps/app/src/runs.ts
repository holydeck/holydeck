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

import { DEFAULT_THEMES, THEME_SURFACES } from '@holydeck/contracts/live-theme';
import { LIVE_MODES, initialLiveModeState } from '@holydeck/contracts/live-mode';
import { RUN_MODES, type RunMode } from '@holydeck/contracts/runs';

import { auditOn } from './audit.js';
import { requestContext } from './context.js';
import { permissionsFor as recordPermissions } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';
import { PRESENTATION_CONTROL } from './roles.js';
import { SERVICE_RECORD, subjectFor } from './services.js';
import { PreparationError, SNAPSHOT_PERMISSIONS, preparationOn } from './snapshots.js';

import type { LiveMode } from '@holydeck/contracts/live-mode';
import type { LivePosition, LiveState } from '@holydeck/contracts/live-state';
import type { ThemeSurface } from '@holydeck/contracts/live-theme';
import type { RunStartBody } from '@holydeck/contracts/runs';
import type { RequestContext } from './context.js';
import type { RepositoryDb } from './repositories.js';
import type { OperatorSession, PreparationStore, ReadinessObservation } from './snapshots.js';

export const RUN_RECORD = 'presentationRuns';
export const RUN_PERMISSIONS = recordPermissions(RUN_RECORD);

export { RUN_MODES };
export type { RunMode };

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
  /** A 0-based ordinal into whatever a run replays. Once `live` (below) exists on a row, this is a
   *  derived read from `live.public` — not a second, independently moving value — kept only so a row
   *  written before this field existed still answers the same shape (spec Design §4). */
  readonly position: number;
  /** The authoritative live state — LIVE-01's `select`/pause/standby model over this run's own
   *  positions, exactly what `live-state.ts`'s `projectFor` privacy-projects for every viewer. */
  readonly live: LiveState;
  /** Moves by exactly one on every accepted `advance`, and never any other way — the compare-and-set
   *  token a caller's own `advance` races on (see `RunStore.advance`). */
  readonly stateRevision: number;
  /** When this row — the latest lifecycle change, start, end, or state advance — was written. */
  readonly at: string;
}

/** What starts a run: `@holydeck/contracts/runs`'s own wire shape, `override` included (D-8) — a live
 *  start over a blocked checklist is refused unless one is given, exactly the same reason and shape the
 *  standalone override route (`preparation-routes.ts`) already takes. */
export type StartRunRequest = RunStartBody;

export interface RunStore {
  active(context: unknown): Promise<readonly RunRecord[]>;
  /** Starts a fresh run from a Ready prepared snapshot. Refuses with a named error from anything else,
   *  Outdated included (spec LIVE-01). Requires Control presentation, checked before anything is read. */
  start(session: OperatorSession, request: StartRunRequest): Promise<RunRecord>;
  /** Ends a run explicitly. Nothing written before this row is rewritten — the run's history is exactly
   *  as it was, with one more row appended. Nothing for a run this code has never heard of. */
  end(session: OperatorSession, runId: string): Promise<RunRecord | undefined>;
  /** A run's persisted state: the same answer whether this is the first read right after `start` or the
   *  first read after this process restarted, since nothing here is held between calls. */
  resume(context: unknown, runId: string): Promise<RunRecord | undefined>;
  /** Moves a run's live state on, compare-and-set style: accepted only when `expectedRevision` still
   *  matches this run's current `stateRevision`, the same way `start` races `standing` to claim a fresh
   *  `runId`. Answers `'stale'` — never a thrown error — when another writer moved first, so a caller
   *  racing normal contention (the run engine, Task 8) can branch on the answer instead of a catch. */
  advance(context: unknown, runId: string, expectedRevision: number, next: LiveState): Promise<RunRecord | 'stale' | undefined>;
}

export interface RunOptions {
  readonly now: () => string;
  readonly newId?: () => string;
  /** How this deployment observes the readiness `snapshots.ts` cannot compute for itself — see
   *  `PreparationOptions.observe`, which this mirrors exactly and passes straight through to `readiness`. */
  readonly observe?: (context: unknown, serviceId: string) => Promise<ReadinessObservation> | ReadinessObservation;
  /** Told once a run's phase has actually moved — started or ended — so a live session watching
   *  run-state (`live-events.ts`'s `publishRunStateChanged`) can be pushed the change without this
   *  module knowing anything about how. Absent where nothing is listening yet: this store is what a
   *  run's phase actually is, whether or not anyone is watching it move. */
  readonly onRunStateChange?: () => void;
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

const isLivePosition = (value: unknown): value is LivePosition =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>)['itemId'] === 'string' &&
  typeof (value as Record<string, unknown>)['slideIndex'] === 'number';

const isPublicPosition = (value: unknown): value is LiveState['public'] =>
  isLivePosition(value) ||
  (typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)['standby'] === 'string');

/** A best-effort structural check, not a full re-parse: enough to refuse a row this code cannot read back
 *  (the same promise `rowFrom`'s scalar checks already make), without duplicating `problems.ts`'s wire
 *  parsers for a shape nothing here ever receives off the wire — `live` is only ever written by this
 *  module's own `initialLiveState`/`advance`, never parsed from client input. */
function isLiveState(value: unknown): value is LiveState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['runId'] === 'string' &&
    typeof v['snapshotId'] === 'string' &&
    typeof v['mode'] === 'string' &&
    LIVE_MODES.includes(v['mode'] as LiveMode) &&
    isPublicPosition(v['public']) &&
    isLivePosition(v['selected']) &&
    typeof v['additionsRevision'] === 'number' &&
    Number.isInteger(v['additionsRevision']) &&
    (v['additionsRevision'] as number) >= 0 &&
    typeof v['themes'] === 'object' &&
    v['themes'] !== null &&
    THEME_SURFACES.every((surface) => typeof (v['themes'] as Record<string, unknown>)[surface] === 'string')
  );
}

const positionOf = (live: LiveState): number => (isLivePosition(live.public) ? live.public.slideIndex : 0);

const defaultThemes = (): Readonly<Record<ThemeSurface, string>> =>
  Object.fromEntries(THEME_SURFACES.map((surface): [ThemeSurface, string] => [surface, DEFAULT_THEMES[surface].id])) as Readonly<
    Record<ThemeSurface, string>
  >;

/** A fresh run's `live`: LIVE-01's own fresh-run rule (`initialLiveModeState`), read onto `LiveState`'s
 *  shape — `public`/`selected` share one `LivePosition` literal rather than `initialLiveModeState`'s
 *  single generic position, since `LiveState.public` (unlike `.selected`) may also be a standby screen;
 *  nothing about a brand new run is that yet. Every surface starts under its shipped default theme
 *  (`live-theme.ts`'s `DEFAULT_THEMES`), and nothing has been added mid-service. */
const initialLiveState = (runId: string, snapshotId: string): LiveState => {
  const emptyScreen: LivePosition = { itemId: '', slideIndex: 0 };
  const seed = initialLiveModeState<LivePosition>(emptyScreen);
  return {
    runId,
    snapshotId,
    mode: seed.mode,
    public: seed.publicPosition,
    selected: seed.selectedPosition,
    themes: defaultThemes(),
    additionsRevision: 0,
  };
};

/** A row written before this task shipped `live` at all: there is truly nothing to derive one from, so
 *  this synthesizes the same shape `initialLiveState` would have written, over the row's own `position`
 *  (spec Design §4's "derived read for old records") rather than pinning a guess at what was selected. */
const legacyLiveState = (runId: string, snapshotId: string, position: number): LiveState => ({
  runId,
  snapshotId,
  mode: 'live',
  public: { itemId: '', slideIndex: position },
  selected: { itemId: '', slideIndex: position },
  themes: defaultThemes(),
  additionsRevision: 0,
});

export function runsOn(db: RepositoryDb, options: RunOptions): RunStore {
  const runs = repositoriesOn(db)[RUN_RECORD];
  const trail = auditOn(db, { now: options.now, ...(options.newId === undefined ? {} : { newId: options.newId }) });
  const preparation: PreparationStore = preparationOn(db, {
    now: options.now,
    ...(options.observe === undefined ? {} : { observe: options.observe }),
  });
  const newId = options.newId ?? ((): string => randomBytes(RUN_ID_BYTES).toString('base64url'));
  const observe = options.observe ?? ((): ReadinessObservation => ({}));
  const onRunStateChange = options.onRunStateChange ?? ((): void => {});

  const author = (context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> => {
    const { actor, correlationId } = context as RequestContext;
    return { actor, correlationId };
  };

  const rowFrom = (found: Record<string, unknown>): StandingRow => {
    const { runId, sequence, at, serviceId, snapshotId, phase, mode, position, live, stateRevision } = found;
    if (
      typeof runId !== 'string' ||
      typeof sequence !== 'number' ||
      typeof at !== 'string' ||
      typeof serviceId !== 'string' ||
      typeof snapshotId !== 'string' ||
      typeof phase !== 'string' ||
      !RUN_PHASES.includes(phase as RunPhase) ||
      typeof mode !== 'string' ||
      !RUN_MODES.includes(mode as RunMode)
    ) {
      throw new RunError('corrupt', `${String(runId)} holds a run row this code cannot read`);
    }
    const runPhase = phase as RunPhase;
    const runMode = mode as RunMode;

    // A row this task's own `start`/`end`/`advance` wrote: `live`/`stateRevision` are authoritative, and
    // `position` is a derived read off `live.public`, never stored.
    if (live !== undefined || stateRevision !== undefined) {
      if (!isLiveState(live) || typeof stateRevision !== 'number' || !Number.isInteger(stateRevision) || stateRevision < 0) {
        throw new RunError('corrupt', `${runId} holds a run row this code cannot read`);
      }
      return { runId, sequence, at, serviceId, snapshotId, phase: runPhase, mode: runMode, live, stateRevision, position: positionOf(live) };
    }

    // A row written before this task shipped: no `live` at all, so `position` is what it has always
    // been — read as-is, and never as anything the row cannot support deriving.
    if (typeof position !== 'number' || !Number.isInteger(position) || position < 0) {
      throw new RunError('corrupt', `${String(runId)} holds a run row this code cannot read`);
    }
    return {
      runId,
      sequence,
      at,
      serviceId,
      snapshotId,
      phase: runPhase,
      mode: runMode,
      position,
      live: legacyLiveState(runId, snapshotId, position),
      stateRevision: 0,
    };
  };

  const standing = async (context: unknown, runId: string): Promise<StandingRow | undefined> => {
    const [found] = await runs.read(context, { runId }, { sort: { sequence: -1 }, limit: 1 });
    return found === undefined ? undefined : rowFrom(found);
  };

  const append = async (
    context: unknown,
    fields: Omit<StandingRow, 'at' | 'position'>,
  ): Promise<RunRecord> => {
    const at = options.now();
    await runs.append(context, { _id: `${fields.runId}${SEQUENCE_SEPARATOR}${fields.sequence}`, at, ...fields, ...author(context) });
    const { runId, serviceId, snapshotId, phase, mode, live, stateRevision } = fields;
    return { runId, serviceId, snapshotId, phase, mode, live, stateRevision, position: positionOf(live), at };
  };

  const store: RunStore = {
    active: async (context) => {
      const found = await runs.read(context, {});
      const latest = new Map<unknown, Record<string, unknown>>();
      for (const row of found) {
        const previous = latest.get(row['runId']);
        if (previous === undefined || Number(row['sequence']) > Number(previous['sequence'])) {
          latest.set(row['runId'], row);
        }
      }
      return [...latest.values()].map(rowFrom).filter((run) => run.phase === 'active');
    },

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
        const state = checklist?.state ?? 'not prepared';
        // D-8: going live over an open blocker is this one operation, not a separate call the client
        // must sequence against a runId it does not yet have. An override offered when nothing is
        // blocked is refused outright — mirrors `snapshots.ts`'s own override rule for the standalone
        // route (`snapshots.ts:508`), so the two paths never disagree about when an override belongs.
        if (state === 'ready' && request.override !== undefined) {
          throw new RunError('state', 'an override is accepted only when a blocker is open, and none is');
        }
        const overriding = state === 'blocked' && request.mode === 'live' && request.override !== undefined;
        if (checklist === undefined || (state !== 'ready' && !overriding)) {
          throw new RunError('state', `a run starts only from a Ready prepared snapshot, and ${request.serviceId} is ${state}`);
        }
        const runId = newId();
        if ((await standing(context, runId)) !== undefined) {
          throw new RunError('conflict', `${runId} is a run another writer named first`);
        }
        if (overriding && request.override !== undefined) {
          // Only after this resolves does a run row get written, so a run is never created for a blocked
          // service without a recorded, validated override under its own minted runId (D-8).
          try {
            await preparation.override(session, { serviceId: request.serviceId, runId, reason: request.override.reason });
          } catch (error) {
            if (!(error instanceof PreparationError)) throw error;
            if (error.kind === 'corrupt') throw error;
            throw new RunError(error.kind === 'permission' ? 'permission' : 'state', error.message);
          }
        }
        const started = await append(context, {
          runId,
          sequence: 1,
          serviceId: request.serviceId,
          snapshotId: record.snapshot.id,
          phase: 'active',
          mode: request.mode,
          live: initialLiveState(runId, record.snapshot.id),
          stateRevision: 0,
        });
        await trail.record(context, {
          action: 'run.start',
          subject: subjectFor(request.serviceId),
          outcome: 'allowed',
          detail: `Started a ${request.mode} presentation run`,
        });
        onRunStateChange();
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
          live: row.live,
          stateRevision: row.stateRevision,
        });
        await trail.record(context, {
          action: 'run.end',
          subject: subjectFor(row.serviceId),
          outcome: 'allowed',
          detail: 'Ended a presentation run',
        });
        onRunStateChange();
        return record;
      }),

    resume: (context, runId) =>
      own(async () => {
        const row = await standing(context, runId);
        if (row === undefined) return undefined;
        const { runId: id, serviceId, snapshotId, phase, mode, position, live, stateRevision, at } = row;
        return { runId: id, serviceId, snapshotId, phase, mode, position, live, stateRevision, at };
      }),

    advance: (context, runId, expectedRevision, next) =>
      own(async () => {
        const row = await standing(context, runId);
        if (row === undefined) return undefined;
        if (row.stateRevision !== expectedRevision) return 'stale';
        try {
          return await append(context, {
            runId,
            sequence: row.sequence + 1,
            serviceId: row.serviceId,
            snapshotId: row.snapshotId,
            phase: row.phase,
            mode: row.mode,
            live: next,
            stateRevision: expectedRevision + 1,
          });
        } catch (error) {
          // Lost a race to another writer's own `advance` landing the same next sequence first — the
          // caller's `expectedRevision` was current when read and is stale now, not an error to throw.
          if (error instanceof RepositoryError && error.kind === 'duplicate') return 'stale';
          throw error;
        }
      }),
  };
  return Object.freeze(store);
}
