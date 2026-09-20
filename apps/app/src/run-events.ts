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
//
// One field has since been added for LIVE-13: `shown`, what an event put in front of the room. It is not
// that migration either — it names an item and the reference a person reads it as, not a translation,
// book, chapter and verse list, and `reference-routes.ts` still writes nowhere near here. It is what makes
// a review of the exact references a run showed derivable from this log alone (`run-review.ts`): the seven
// pins are one digest of the whole bound manifest, identical on every event of a run, so they say what the
// run could show and never which item it was on, and the Service definition is the one place that would
// otherwise hold the answer — the place LIVE-13 says a review may not read it from.

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

/** What one event put in front of the room. Only `current-slide-changed` carries one — the other three
 *  change classes move nothing into view — and the reference is stored rather than looked up later, so a
 *  review of what a run showed (LIVE-13, `run-review.ts`) never has to consult the Service definition the
 *  run may have outlived, and never has to guess what a pin that is invariant across a whole run meant. */
export interface ShownItem {
  /** What the run moved to: a Service item's own id, or the content id of a mid-service addition. */
  readonly itemId: string;
  /** What a person reads it as — 'Psalm 23:1-6' — exactly as the room was shown it. */
  readonly reference: string;
}

/** What a shown slide or an operator state change appends. `kind` is `live-events.ts`'s own vocabulary — the
 *  four classes an authorized view is ever pushed — so a caller cannot log an event no view was told about. */
export interface RunEventInput {
  readonly runId: string;
  readonly kind: LiveEventType;
  /** Every one of `SNAPSHOT_PINS`, exactly as the run's prepared manifest pinned them at this moment. */
  readonly pinnedRevisions: Readonly<Record<SnapshotPin, string>>;
  /** Present exactly when this event showed something, which is `current-slide-changed` and nothing else. */
  readonly shown?: ShownItem;
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
  /** Absent on every event that moved nothing into view — the override rows included. */
  readonly shown?: ShownItem;
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

const shownFrom = (value: unknown, refusal: RunEventRefusal, id: string): ShownItem | undefined => {
  if (value === undefined) return undefined;
  const candidate = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const { itemId, reference } = candidate;
  if (typeof itemId !== 'string' || itemId.trim() === '' || typeof reference !== 'string' || reference.trim() === '') {
    throw new RunEventError(refusal, `${id}: an event that showed something names the item it showed and the reference a person reads it as`);
  }
  return { itemId, reference };
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
    const id = `${runId}${SEQUENCE_SEPARATOR}${sequence}`;
    const pinnedRevisions = pinsFrom(found['pinnedRevisions'], 'corrupt', id);
    const shown = shownFrom(found['shown'], 'corrupt', id);
    return { runId, sequence, at, kind, pinnedRevisions, actor, ...(shown === undefined ? {} : { shown }) };
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
        const shown = shownFrom(input.shown, 'schema', input.runId);
        // A change class that moves nothing into view may not claim it showed something: the review this
        // field exists for (LIVE-13) is only as true as the log, and a lie here is one no later read can see.
        if (shown !== undefined && input.kind !== LIVE_EVENT_TYPES.slide) {
          throw new RunEventError('schema', `${input.kind} moves nothing into view, so it shows no reference`);
        }
        const context = runEventContext(session.actor, session.correlationId);
        const sequence = (await runEvents.count(context, { runId: input.runId })) + 1;
        const at = options.now();
        const carried = shown === undefined ? {} : { shown };
        await runEvents.append(context, {
          _id: `${input.runId}${SEQUENCE_SEPARATOR}${sequence}`,
          runId: input.runId,
          sequence,
          at,
          kind: input.kind,
          pinnedRevisions,
          ...carried,
          actor: session.actor,
          correlationId: session.correlationId,
        });
        return { runId: input.runId, sequence, at, kind: input.kind, pinnedRevisions, actor: session.actor, ...carried };
      }),

    log: (context, runId) =>
      own(async () => {
        const found = await runEvents.read(context, { runId }, { sort: { sequence: 1 } });
        return found.map(rowFrom);
      }),
  };
  return Object.freeze(store);
}
