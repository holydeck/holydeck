// The immutable run event log: every shown slide and every operator state change, one row per event,
// carrying who did it, when, and the pinned revisions the run was showing at that moment (spec LIVE-12;
// ADR 0002's delivery immutability; ADR 0007's immutable run event log).
//
// `runs.ts`'s header already names this table and this task; `snapshots.ts`'s `override` is the first
// writer into it, appending a `readiness.override` row beside the trail entry an override always leaves.
// This module is the second writer, not a competing one: both go through the same `runEvents` repository,
// which offers no update or delete verb at all (repositories.ts), so nothing either writer appends can
// ever be rewritten by the other, and `log` reads every row regardless of who wrote it. What this module
// adds is the general case neither of those one-off call sites needed: an append for whichever future
// domain moves a run's position, opens or closes Standby, changes its theme, or moves its own phase —
// `live-events.ts`'s four change classes, the same vocabulary that module's header already anticipated
// this log would group and search by — and the ordered read a run is exactly reconstructed from.
//
// Reconstruction is a property of what is stored, not a function this module runs: a pinned revision is a
// content-addressed name (ADR 0001, `revisions.ts`), so resolving one always yields the same bytes back,
// and `log`'s ascending-sequence order is the order a run showed them in. Replaying the pins in that order
// through the one deterministic renderer (`@holydeck/renderer`, REND-01) is exactly the original run —
// this module proves it holds the pins and the order; its own test proves the replay against real render
// output, since wiring a pin to a live output surface is a later task's build, not this one's.
//
// `shown-references.ts`'s own header names this task as the point where its narrower record of an
// explicitly shown Bible reference could migrate into this log or be dropped. It is left in place: its
// row shape is a translation, book, chapter and verse list plus one corpus revision, nothing like the
// seven-pin snapshot this log carries per event, and it has no run to key a row under — reference lookup
// stays a domain of its own (`reference-routes.ts`) until a later task binds it to a run in flight. Folding
// it in now would mean inventing that binding and reworking a route this task does not own, for a shape
// this task's own tests never ask for.

import { SNAPSHOT_PINS } from '@holydeck/contracts/snapshots';

import { requestContext } from './context.js';
import { LIVE_EVENT_TYPES } from './live-events.js';
import { permissionsFor as recordPermissions } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';
import { PRESENTATION_CONTROL } from './roles.js';
import { RUN_EVENT_RECORD } from './snapshots.js';

import type { SnapshotPin } from '@holydeck/contracts/snapshots';
import type { RequestContext } from './context.js';
import type { LiveEventType } from './live-events.js';
import type { RepositoryDb } from './repositories.js';
import type { OperatorSession } from './snapshots.js';

export const RUN_EVENT_PERMISSIONS = recordPermissions(RUN_EVENT_RECORD);

const SEQUENCE_SEPARATOR = '#';

export type RunEventRefusal = 'permission' | 'schema' | 'conflict' | 'corrupt';

export class RunEventError extends Error {
  readonly kind: RunEventRefusal;

  constructor(kind: RunEventRefusal, message: string) {
    super(message);
    this.name = 'RunEventError';
    this.kind = kind;
  }
}

/** The context this log is read and written under: `runEvents` alone. */
export function runEventContext(actor: string, correlationId: string): RequestContext {
  return requestContext({ actor, permissions: Object.values(RUN_EVENT_PERMISSIONS), correlationId });
}

/** What a shown slide or an operator state change appends. `kind` is `live-events.ts`'s own vocabulary — the
 *  four classes an authorized view is ever pushed — so a caller cannot log an event no view was told about. */
export interface RunEventInput {
  readonly runId: string;
  readonly kind: LiveEventType;
  /** Every one of `SNAPSHOT_PINS`, exactly as the run's prepared manifest pinned them at this moment. */
  readonly pinnedRevisions: Readonly<Record<SnapshotPin, string>>;
}

/** A row as read back. `kind` widens to `string` here: the log also carries `snapshots.ts`'s own
 *  `readiness.override` rows, which are not one of `live-events.ts`'s four classes but are still part of
 *  the run a reconstruction has to replay. */
export interface RunEventRecord {
  readonly runId: string;
  readonly sequence: number;
  readonly at: string;
  readonly kind: string;
  readonly pinnedRevisions: Readonly<Record<SnapshotPin, string>>;
  readonly actor: string;
}

export interface RunEventStore {
  /** Appends one immutable event. Refused for a session without Control presentation (THR-11), checked
   *  before anything is read or written — the same gate `runs.ts` and `snapshots.ts`'s override use for
   *  every other act of control. */
  record(session: OperatorSession, input: RunEventInput): Promise<RunEventRecord>;
  /** A run's whole event log, in the order the server wrote it — sequence ascending, unbroken from one —
   *  which is what makes it a log a run is exactly reconstructed from rather than a bag of rows. */
  log(context: unknown, runId: string): Promise<readonly RunEventRecord[]>;
}

export interface RunEventOptions {
  readonly now: () => string;
}

const pinsFrom = (value: unknown, refusal: RunEventRefusal, id: string): Record<SnapshotPin, string> => {
  const candidate = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const pins: Partial<Record<SnapshotPin, string>> = {};
  for (const pin of SNAPSHOT_PINS) {
    const pinned = candidate[pin];
    if (typeof pinned !== 'string' || pinned.trim() === '') {
      throw new RunEventError(refusal, `${id}: a run event pins every one of ${SNAPSHOT_PINS.join(', ')}, and ${pin} is not one`);
    }
    pins[pin] = pinned;
  }
  return pins as Record<SnapshotPin, string>;
};

function refusalFor(error: unknown): unknown {
  if (error instanceof RepositoryError && error.kind === 'duplicate') {
    return new RunEventError('conflict', `${error.message}, so another writer already logged this run event`);
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

export function runEventsOn(db: RepositoryDb, options: RunEventOptions): RunEventStore {
  const runEvents = repositoriesOn(db)[RUN_EVENT_RECORD];

  const rowFrom = (found: Record<string, unknown>): RunEventRecord => {
    const { runId, sequence, at, kind, actor } = found;
    if (
      typeof runId !== 'string' ||
      typeof sequence !== 'number' ||
      typeof at !== 'string' ||
      typeof kind !== 'string' ||
      kind.trim() === '' ||
      typeof actor !== 'string'
    ) {
      throw new RunEventError('corrupt', `${String(runId)}${SEQUENCE_SEPARATOR}${String(sequence)} holds a run event this code cannot read`);
    }
    const pinnedRevisions = pinsFrom(found['pinnedRevisions'], 'corrupt', `${runId}${SEQUENCE_SEPARATOR}${sequence}`);
    return { runId, sequence, at, kind, pinnedRevisions, actor };
  };

  const store: RunEventStore = {
    record: (session, input) =>
      own(async () => {
        // THR-11: checked first, before a single read, so the refusal is this server's and not a client's.
        if (!session.permissions.includes(PRESENTATION_CONTROL)) {
          throw new RunEventError('permission', `logging a run event is the Operator's alone, which needs ${PRESENTATION_CONTROL}`);
        }
        if (!Object.values(LIVE_EVENT_TYPES).includes(input.kind)) {
          throw new RunEventError('schema', `${input.kind} is not one of the change classes live-events.ts names`);
        }
        const pinnedRevisions = pinsFrom(input.pinnedRevisions, 'schema', input.runId);
        const context = runEventContext(session.actor, session.correlationId);
        const sequence = (await runEvents.count(context, { runId: input.runId })) + 1;
        const at = options.now();
        await runEvents.append(context, {
          _id: `${input.runId}${SEQUENCE_SEPARATOR}${sequence}`,
          runId: input.runId,
          sequence,
          at,
          kind: input.kind,
          pinnedRevisions,
          actor: session.actor,
          correlationId: session.correlationId,
        });
        return { runId: input.runId, sequence, at, kind: input.kind, pinnedRevisions, actor: session.actor };
      }),

    log: (context, runId) =>
      own(async () => {
        const found = await runEvents.read(context, { runId }, { sort: { sequence: 1 } });
        return found.map(rowFrom);
      }),
  };
  return Object.freeze(store);
}
