// Content added to a service that is already on — the reading somebody asks for from the front, the extra
// verse nobody planned — and the provenance that says it happened that way (spec LIVE-14).
//
// Two things this module is careful not to do, because both would quietly cost something the product
// promises elsewhere.
//
// It does not touch the reusable library unless somebody decided to keep the content. `library.ts` mints
// an identifier and stamps it into the discoverable library in one atomic act, so asking it for an
// identifier is the same as publishing one — which is why the identifier a mid-service addition is saved
// under is minted here instead, exactly the way that store mints its own, and the body goes straight to
// the already-generic `revisionsOn()` store under it. `library.ts`'s own header anticipates this split:
// content can have a revision without the library ever knowing about it. An explicit save decision is the
// one thing that reaches `create`, and what it mints is a second, library-owned identifier of its own —
// that store cannot be handed one, and nothing here pretends the two are the same id.
//
// It does not recompute what the run is pinned to. `snapshots.ts` writes one manifest per preparation and
// never rewrites it, and a run is past preparation by the time anything is added mid-service, so the seven
// pinned revisions a run event carries are read back from the run's own manifest and passed through
// unchanged — the `content` pin included, which is a digest over what preparation baked in rather than a
// running tally of what has been shown since. The addition joins the run the way any shown item does, by
// appending `live-events.ts`'s `current-slide-changed` to the immutable log in `run-events.ts`, and the
// record that it was added mid-service is this module's own row rather than a flag on something else:
// `revisions.ts`'s `RevisionOrigin` says how a save was triggered, never when in a service's life it
// happened, and folding the two together would leave neither answerable on its own.
//
// The writes are ordered so that nothing durable ever claims something that did not happen: the body
// first, then the run event, and the provenance last. The body leads because a run event pinned to a body
// that was never written is a run that cannot be reconstructed (ADR 0007). The provenance trails because
// neither record class can be taken back — two Operators adding to the same run at the same moment race
// for the same ordinal in the log, and the one that loses must not leave a row saying an addition joined
// a run it never joined. What a loser does leave is a saved body nothing points at, which claims nothing;
// what an interruption leaves is at worst a missing row, which an Operator notices as the addition not
// appearing and adds again. A record kept to be believed is better silent than wrong.

import { randomBytes } from 'node:crypto';

import { parseLibraryDraft } from '@holydeck/contracts/library';
import { SNAPSHOT_PINS } from '@holydeck/contracts/snapshots';

import { requestContext } from './context.js';
import { LIBRARY_PERMISSIONS, libraryOn } from './library.js';
import { LIVE_EVENT_TYPES } from './live-events.js';
import { permissionsFor as recordPermissions } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';
import { REVISION_PERMISSIONS, revisionsOn } from './revisions.js';
import { PRESENTATION_CONTROL } from './roles.js';
import { RunEventError } from './run-events.js';
import { RUN_PERMISSIONS } from './runs.js';
import { SNAPSHOT_PERMISSIONS, SNAPSHOT_RECORD } from './snapshots.js';

import type { LibraryKind } from '@holydeck/contracts/library';
import type { RevisionBody, RevisionRecord } from '@holydeck/contracts/revisions';
import type { SnapshotPin } from '@holydeck/contracts/snapshots';

import type { RequestContext } from './context.js';
import type { RepositoryDb } from './repositories.js';
import type { RunEventRecord, RunEventStore } from './run-events.js';
import type { RunRecord, RunStore } from './runs.js';
import type { OperatorSession } from './snapshots.js';

export const MID_SERVICE_RECORD = 'midServiceAdditions';

export const MID_SERVICE_PERMISSIONS = recordPermissions(MID_SERVICE_RECORD);

export interface MidServiceIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// One index, and the one read this store makes is served by it: everything one run took on, in the order
// it took it. Not unique — a run takes on as many as it takes on — and the identifier each row is keyed
// by is the content's own, which the collection's `_id` already keeps unique.
const DECLARED_INDEXES: readonly MidServiceIndex[] = [
  { name: 'mid_service_addition_run', keys: { runId: 1, at: 1 }, options: {} },
];

export const MID_SERVICE_INDEXES = Object.freeze(DECLARED_INDEXES);

export type MidServiceRefusal = 'permission' | 'schema' | 'state' | 'conflict' | 'corrupt';

/** Carries why the call was refused, so a caller can tell a defect from a race it lost fairly. */
export class MidServiceError extends Error {
  readonly kind: MidServiceRefusal;

  constructor(kind: MidServiceRefusal, message: string) {
    super(message);
    this.name = 'MidServiceError';
    this.kind = kind;
  }
}

/** The context an addition is made under: its own record, the run and manifest it reads, the body it
 *  saves, and the library the one explicit save decision reaches. */
export function midServiceContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [
      ...Object.values(MID_SERVICE_PERMISSIONS),
      ...Object.values(RUN_PERMISSIONS),
      ...Object.values(SNAPSHOT_PERMISSIONS),
      ...Object.values(REVISION_PERMISSIONS),
      ...Object.values(LIBRARY_PERMISSIONS),
    ],
    correlationId,
  });
}

/** What a run is asked to take on: what the content is, what it is called, its body, and the one
 *  decision that is not implied by adding it — whether the library keeps it afterwards. */
export interface MidServiceRequest {
  readonly runId: string;
  readonly kind: LibraryKind;
  readonly title: string;
  readonly body: RevisionBody;
  /** Absent or false: the content joins this run and the library never hears of it (spec CONT-01). */
  readonly saveToLibrary?: boolean;
}

/** The provenance itself. That a row exists at all is what says the content was added mid-service; the
 *  fields say which content, which run, by whom, and when. */
export interface MidServiceAddition {
  readonly contentId: string;
  readonly runId: string;
  readonly actor: string;
  readonly at: string;
  /** The library item an explicit save decision created, and nothing at all when none was made. */
  readonly libraryId?: string;
}

export interface MidServiceOutcome {
  readonly addition: MidServiceAddition;
  /** The body as history holds it, saved under the identifier this module minted. */
  readonly revision: RevisionRecord;
  /** The run event this addition appended, the same one any shown item appends. */
  readonly event: RunEventRecord;
}

export interface MidServiceStore {
  /** Adds content to a run that is on. Refused for a session without Control presentation (THR-11),
   *  checked before anything is read or written. */
  add(session: OperatorSession, request: MidServiceRequest): Promise<MidServiceOutcome>;
  /** Everything one run took on mid-service, oldest first. */
  additions(context: unknown, runId: string): Promise<readonly MidServiceAddition[]>;
}

export interface MidServiceOptions {
  readonly now: () => string;
  /** Mints the identifier the body is saved under. Injected so a test can pin it; never the library's. */
  readonly newId?: () => string;
  /** Where a run's own row is read back from (runs.resume), injected rather than built here so every
   *  caller of this module shares one store instead of each constructing its own over the same database. */
  readonly runs: Pick<RunStore, 'resume'>;
  /** Where the addition is logged into the run's own event log, injected for the same reason. */
  readonly runEvents: Pick<RunEventStore, 'record'>;
}

const CONTENT_ID_BYTES = 16;

const readable = (problem: { readonly path: string; readonly message: string }): string =>
  `${problem.path} ${problem.message}`;
const problems = (list: readonly { readonly path: string; readonly message: string }[]): string =>
  list.map(readable).join('; ');

const byTime = (left: MidServiceAddition, right: MidServiceAddition): number =>
  Number(left.at > right.at) - Number(left.at < right.at);

function refusalFor(error: unknown): unknown {
  if (error instanceof RepositoryError && error.kind === 'duplicate') {
    return new MidServiceError('conflict', `${error.message}, so another writer added this content first`);
  }
  // The run event is the one write every check above cannot rule out: two Operators adding to the same run
  // at the same moment race for the same ordinal in the log. Its refusal is carried over under this
  // store's own name rather than leaking a second vocabulary to the caller.
  if (error instanceof RunEventError) {
    return new MidServiceError(error.kind, `${error.message}, so this addition never joined the run`);
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

export function midServiceOn(db: RepositoryDb, options: MidServiceOptions): MidServiceStore {
  const repositories = repositoriesOn(db);
  const records = repositories[MID_SERVICE_RECORD];
  const snapshots = repositories[SNAPSHOT_RECORD];
  const { runs, runEvents } = options;
  const revisions = revisionsOn(db, { now: options.now });
  const library = libraryOn(db, { now: options.now });
  const newId = options.newId ?? ((): string => randomBytes(CONTENT_ID_BYTES).toString('base64url'));

  const rowFrom = (found: Record<string, unknown>): MidServiceAddition => {
    const { contentId, runId, at, actor, libraryId } = found;
    if (
      typeof contentId !== 'string' ||
      typeof runId !== 'string' ||
      typeof at !== 'string' ||
      typeof actor !== 'string' ||
      (libraryId !== undefined && typeof libraryId !== 'string')
    ) {
      throw new MidServiceError('corrupt', `${String(contentId)} holds a mid-service addition this code cannot read`);
    }
    return { contentId, runId, actor, at, ...(typeof libraryId === 'string' ? { libraryId } : {}) };
  };

  const standing = async (context: unknown, contentId: string): Promise<MidServiceAddition | undefined> => {
    const [found] = await records.read(context, { contentId }, { limit: 1 });
    return found === undefined ? undefined : rowFrom(found);
  };

  /**
   * The run's own pins, read back from the manifest it replays from rather than from whichever manifest
   * that Service last prepared: preparation may have run again since this run went live, and a run event
   * pins what its run is showing from. Nothing here is recomputed — a pin that is not readable text is a
   * manifest something went around, since preparation refuses to write one (`parsePreparedSnapshot`).
   */
  const standingPins = async (context: unknown, run: RunRecord): Promise<Record<SnapshotPin, string>> => {
    const [found] = await snapshots.read(context, { _id: run.snapshotId }, { limit: 1 });
    if (found === undefined) {
      throw new MidServiceError('state', `${run.runId} replays from ${run.snapshotId}, which is not a manifest this server holds`);
    }
    const held = found['pins'];
    const candidate = typeof held === 'object' && held !== null ? (held as Record<string, unknown>) : {};
    const pins: Partial<Record<SnapshotPin, string>> = {};
    for (const pin of SNAPSHOT_PINS) {
      const pinned = candidate[pin];
      if (typeof pinned !== 'string' || pinned.trim() === '') {
        throw new MidServiceError(
          'corrupt',
          `${run.snapshotId} pins no ${pin} this code can read, and a run event pins every one of ${SNAPSHOT_PINS.join(', ')}`,
        );
      }
      pins[pin] = pinned;
    }
    return pins as Record<SnapshotPin, string>;
  };

  const store: MidServiceStore = {
    add: (session, request) =>
      own(async () => {
        // THR-11: checked first, before a single read, so the refusal is this server's and not a client's.
        if (!session.permissions.includes(PRESENTATION_CONTROL)) {
          throw new MidServiceError(
            'permission',
            `adding content to a run in flight is the Operator's alone, which needs ${PRESENTATION_CONTROL}`,
          );
        }
        // Graded to the library's own rule whether or not the library ever sees it, so a decision to keep
        // it later cannot be refused for a title this addition was already allowed to carry.
        const parsed = parseLibraryDraft({ kind: request.kind, title: request.title }, 'addition');
        if (!parsed.ok) throw new MidServiceError('schema', `this is not content a run can show: ${problems(parsed.problems)}`);
        const context = midServiceContext(session.actor, session.correlationId);
        const run = await runs.resume(context, request.runId);
        if (run === undefined) throw new MidServiceError('state', `${request.runId} is not a run this server started`);
        if (run.phase !== 'active') {
          throw new MidServiceError('state', `${request.runId} has ended, and content joins a run that is on`);
        }
        const pinnedRevisions = await standingPins(context, run);
        const contentId = newId();
        if ((await standing(context, contentId)) !== undefined) {
          throw new MidServiceError('conflict', `${contentId} is content another writer added first`);
        }
        const saved = await revisions.save(context, { contentId, body: request.body, origin: 'manual-checkpoint' });
        // The run event names the addition the way it names any shown item, so LIVE-13's review of what a
        // run showed reads this back from the log alone — which is the only place it could be read from:
        // no Service definition ever held this content.
        const event = await runEvents.record(session, {
          runId: run.runId,
          kind: LIVE_EVENT_TYPES.slide,
          pinnedRevisions,
          shown: { itemId: contentId, reference: parsed.value.title },
        });
        const libraryId =
          request.saveToLibrary === true ? (await library.create(context, parsed.value)).stamp.id : undefined;
        const addition: MidServiceAddition = {
          contentId,
          runId: run.runId,
          actor: session.actor,
          at: options.now(),
          ...(libraryId === undefined ? {} : { libraryId }),
        };
        // Last, and only once the run has actually taken the content on: the row is the whole claim.
        await records.append(context, { _id: contentId, ...addition, correlationId: session.correlationId });
        return { addition, revision: saved.revision, event };
      }),

    additions: (context, runId) =>
      own(async () => {
        const found = await records.read(context, { runId });
        // Ordered here rather than by the query: an ISO instant compares as text, and which addition came
        // first should not depend on a collation — the same care `snapshots.ts` takes over `preparedAt`.
        return found.map(rowFrom).sort(byTime);
      }),
  };
  return Object.freeze(store);
}
