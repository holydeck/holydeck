// Preparation: turning a Service into the immutable manifest a run replays from, and the severity-aware
// checklist that says whether it may go anywhere near a congregation (spec PREP-01).
//
// Three rules from the architecture decisions are this module's to keep, and each is kept by construction
// rather than by promise:
//
//   * ADR 0006 — the manifest pins all seven revisions plus the geometry it resolved once, so nothing is
//     recomputed on a Sunday morning. `parsePreparedSnapshot` is what refuses a manifest missing a pin,
//     and `preparedSnapshots` is an immutable record class whose repository offers no update or delete —
//     a second manifest written over the one already there is a duplicate key, not a rewrite.
//   * ADR 0003 — readiness is a checklist of blockers, warnings and completed checks grouped by what they
//     are about. There is no score anywhere here, deliberately: a percentage lets one blocker be averaged
//     away by nine green checks, and the blocker is the whole of what matters.
//   * ADR 0005, by way of `slide-layout-propagation.ts` — a prepared manifest pins its Slide Layout, and
//     goes Outdated the moment that Layout moves past the revision it pinned. Outdated is not Ready.
//
// The Operator override is the one way past an open blocker, and it is authorized here rather than by a
// client declining to draw the control (THR-11): Control presentation is checked before anything is read
// or written, so an Admin, an Editor, a Member, a guest or an output window asking for it directly — none
// of which holds that permission for being what it is — is refused exactly as if it had asked through a
// surface that never offered it. The Operator is whoever was granted Control presentation, whatever role
// they hold, which is the same permission `capability-routes.ts`, `reference-routes.ts` and `palette.ts`
// already run the live desk from.
//
// What the override is measured against is the server's own checklist, never a checklist that arrived
// with the request: one a caller could write is one a caller could clear, and the blockers it carries
// into the run event and the trail would then be a claim about what was open rather than a record of it.

import { createHash } from 'node:crypto';

import { HASH_ALGORITHM, revisionAddress, revisionBytes } from '@holydeck/contracts/revisions';
import { parseService } from '@holydeck/contracts/services';
import {
  DEFAULT_SAFE_AREA_MARGINS,
  aspectRatioLabel,
  aspectRatioOf,
  parsePreparedSnapshot,
} from '@holydeck/contracts/snapshots';

import { auditOn } from './audit.js';
import { requestContext } from './context.js';
import { permissionsFor as recordPermissions } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';
import { PRESENTATION_CONTROL } from './roles.js';
// The Service a manifest is prepared from is named in the trail the one way it is already named there.
import { SERVICE_RECORD, subjectFor } from './services.js';
import { OUTDATED_REQUIRES, isOutdated } from './slide-layout-propagation.js';

import type { PreparedSnapshot, SafeAreaMargins } from '@holydeck/contracts/snapshots';

import type { RequestContext } from './context.js';
import type { RepositoryDb } from './repositories.js';

export const SNAPSHOT_RECORD = 'preparedSnapshots';
export const RUN_EVENT_RECORD = 'runEvents';

export const SNAPSHOT_PERMISSIONS = recordPermissions(SNAPSHOT_RECORD);
export const RUN_EVENT_PERMISSIONS = recordPermissions(RUN_EVENT_RECORD);

/** What a run is called while it is on. The second is the whole visible consequence of an override. */
export const LIVE_LABEL = 'live';
export const LIVE_OVERRIDDEN_LABEL = 'live overridden';

/** One name for the trail entry an override writes and the run event it appends beside it. */
export const OVERRIDE_ACTION = 'readiness.override';

/** ADR 0003's groups. A check belongs to exactly one, and there are no others. */
export const READINESS_GROUPS = ['Content', 'Media', 'Bible', 'Offline', 'Outputs', 'Rehearsal'] as const;
export type ReadinessGroup = (typeof READINESS_GROUPS)[number];

/** How severe a check is. Three kinds, never a number — see the header. */
export const CHECK_SEVERITIES = ['blocker', 'warning', 'complete'] as const;
export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];

export const READINESS_STATES = ['not prepared', 'preparing', 'ready', 'outdated', 'blocked'] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

/** The three things an open blocker stands between a Service and. */
export const READINESS_TARGETS = ['Ready', 'Rehearsal', 'Go Live'] as const;
export type ReadinessTarget = (typeof READINESS_TARGETS)[number];

export interface ReadinessCheck {
  /** How the check reads to a person, and the name an override has to carry it under. */
  readonly name: string;
  readonly group: ReadinessGroup;
  readonly severity: CheckSeverity;
  /** Why it is in the state it is in. An override carries this verbatim; rewriting it is refused. */
  readonly cause: string;
}

export interface ReadinessChecklist {
  readonly state: ReadinessState;
  readonly blockers: readonly ReadinessCheck[];
  readonly warnings: readonly ReadinessCheck[];
  readonly completed: readonly ReadinessCheck[];
}

export interface ReadinessOverride {
  /** The Operator, named. An override nobody is answerable for is not one. */
  readonly operator: string;
  readonly reason: string;
  readonly auditEntry: string;
  readonly runLabel: string;
  readonly carried: readonly ReadinessCheck[];
}

/** A Slide Layout pin: the Layout, and the ordinal of the revision this manifest froze it at. */
export interface PinnedLayout {
  readonly id: string;
  readonly revision: number;
}

/**
 * What preparation cannot work out for itself. A Service names its own items and nothing else — no Slide
 * Layout, no Service Template, no settings, no media set and no corpus — so the five revisions those pin
 * arrive from whoever is preparing, and the manifest refuses to be written if any of them is missing.
 */
export interface PreparationInputs {
  readonly slideLayout: PinnedLayout;
  readonly serviceTemplate: string;
  readonly settings: string;
  readonly media: string;
  readonly corpus: string;
  /** A ratio of two counts, such as `16:9`. Resolved to what it is, not kept as it arrived. */
  readonly aspectRatio: string;
  readonly safeAreaMargins?: SafeAreaMargins;
}

export interface PreparedRecord {
  readonly serviceId: string;
  readonly preparedAt: string;
  readonly snapshot: PreparedSnapshot;
}

/**
 * What the surfaces around readiness have seen that this module cannot see for itself: the checks media,
 * Bible, offline and output readiness contribute (their own tasks), and the revision the pinned Slide
 * Layout currently stands at. Asking `readiness` what a given observation amounts to reads nothing back
 * into a record; the override is the one caller that writes, and it observes for itself instead.
 */
export interface ReadinessObservation {
  readonly checks?: readonly ReadinessCheck[];
  readonly slideLayoutRevision?: number;
}

/**
 * Everything an override takes, and nothing about what is open: which Service, which run, and why. What
 * was blocking is the server's to establish (THR-11), so there is deliberately nowhere here to say it.
 */
export interface OverrideRequest {
  readonly serviceId: string;
  readonly runId: string;
  readonly reason: string;
}

export interface OverrideOutcome {
  readonly runId: string;
  readonly runLabel: string;
  readonly override: ReadinessOverride;
  /** The manifest the run goes live from, untouched: an override changes what is allowed, never what is pinned. */
  readonly snapshot: PreparedSnapshot;
}

/** A proven session, as the surface above hands it over. The permissions are what this module checks. */
export interface OperatorSession {
  readonly actor: string;
  readonly permissions: readonly string[];
  readonly correlationId: string;
}

export type PreparationRefusal = 'schema' | 'permission' | 'state' | 'reason' | 'conflict' | 'corrupt';

export class PreparationError extends Error {
  readonly kind: PreparationRefusal;

  constructor(kind: PreparationRefusal, message: string) {
    super(message);
    this.name = 'PreparationError';
    this.kind = kind;
  }
}

export interface PreparationStore {
  /** Writes the manifest, or nothing for an identifier no Service holds. Never rewrites one. */
  prepare(context: unknown, serviceId: string, inputs: PreparationInputs): Promise<PreparedRecord | undefined>;
  /** The standing manifest: the last one prepared for this Service, or nothing. */
  prepared(context: unknown, serviceId: string): Promise<PreparedRecord | undefined>;
  readiness(context: unknown, serviceId: string, observed?: ReadinessObservation): Promise<ReadinessChecklist | undefined>;
  /**
   * The one way past an open blocker. Refused for every session without Control presentation, and
   * measured against the checklist this server observes rather than one the request brought with it.
   */
  override(session: OperatorSession, request: OverrideRequest): Promise<OverrideOutcome>;
  /** What a run is called, decided by its own events rather than by anything a caller passes in. */
  runLabel(context: unknown, runId: string): Promise<string>;
}

export interface PreparationOptions {
  readonly now: () => string;
  readonly newId?: () => string;
  /**
   * How this deployment observes, for itself, the readiness this module cannot compute — what media,
   * Bible, offline and output readiness report, and the revision the pinned Slide Layout stands at now.
   * The override's checklist is built from this and from the Service as stored, never from the request.
   * Left out, the server sees only what it can read for itself and refuses to override a blocker it
   * cannot see, which is the safe way round: an unobserved blocker stops the run rather than being
   * waved through on a caller's word that it is not there.
   */
  readonly observe?: (context: unknown, serviceId: string) => Promise<ReadinessObservation> | ReadinessObservation;
}

const LAYOUT_PIN_SEPARATOR = '@';
const SNAPSHOT_KEY_SEPARATOR = '#';

const NOTHING_TO_SHOW = 'Content: nothing is enabled to show';
const EVERYTHING_PINNED = 'Content: every enabled item is pinned';
const LAYOUT_MOVED_ON = 'Content: the Slide Layout moved on';
const LAYOUT_CURRENT = 'Content: the Slide Layout pinned is still current';

/** An item as the content pin reads it: what it is, and the exact revision it points at. */
interface PinnableItem {
  readonly id: string;
  readonly kind: string;
  readonly enabled: boolean;
  readonly content: unknown;
}

interface StandingService {
  /** The Service's own revision: the ordinal its standing stamp holds (see `services.ts`). */
  readonly sequence: number;
  readonly items: readonly PinnableItem[];
}

const readable = (problem: { readonly path: string; readonly message: string }): string =>
  `${problem.path} ${problem.message}`;

const problems = (list: readonly { readonly path: string; readonly message: string }[]): string =>
  list.map(readable).join('; ');

/** The context preparation reads and writes under: the two records it owns, the Service it reads, its trail. */
export function preparationContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [
      ...Object.values(SNAPSHOT_PERMISSIONS),
      ...Object.values(RUN_EVENT_PERMISSIONS),
      recordPermissions(SERVICE_RECORD).read,
      recordPermissions('auditEvents').append,
    ],
    correlationId,
  });
}

const pinnedLayoutOf = (pin: string): PinnedLayout | undefined => {
  const at = pin.lastIndexOf(LAYOUT_PIN_SEPARATOR);
  const revision = Number(pin.slice(at + 1));
  return at < 1 || !Number.isInteger(revision) ? undefined : { id: pin.slice(0, at), revision };
};

/**
 * What ADR 0003 asks of an override, said as the first thing wrong with one. Every clause is a way an
 * override could be incomplete and still look like one: nobody answerable for it, no reason a person can
 * read, no trail entry, a run that would report as an ordinary live run, a blocker quietly left off the
 * list, or a blocker carried under a cause that is not the one it blocked for.
 */
export function overrideProblem(checklist: ReadinessChecklist, override: ReadinessOverride): string | undefined {
  const open = checklist.blockers;
  const refusal = (why: string): string => `transition to Go Live: ${why}`;
  if (override.operator.trim() === '') return refusal('overridden by nobody, not an Operator');
  if (override.reason.trim() === '') return refusal('overridden without a reason');
  if (override.auditEntry !== OVERRIDE_ACTION) return refusal('overridden without an audit entry');
  if (override.runLabel !== LIVE_OVERRIDDEN_LABEL) {
    const label = override.runLabel.trim() === '' ? 'nothing' : override.runLabel;
    return refusal(`the run is labelled ${label}, not ${LIVE_OVERRIDDEN_LABEL}`);
  }
  if (override.carried.length < open.length) {
    return refusal(`${override.carried.length} check(s) carried against ${open.length} open blocker(s)`);
  }
  for (const blocker of open) {
    const carried = override.carried.find((check) => check.name === blocker.name);
    if (carried === undefined) return refusal(`${blocker.name} was blocking and is not carried`);
    if (carried.cause !== blocker.cause) return refusal(`${blocker.name} is carried with a cause it did not block for`);
  }
  return undefined;
}

/**
 * Whether the state machine may take this step, said as the first thing standing in the way. An open
 * blocker stops Ready and Rehearsal outright — no override exists for either, with or without a reason —
 * and stops Go Live unless a complete Operator override carries every one of them.
 */
export function transitionProblem(
  from: ReadinessState,
  to: ReadinessTarget,
  checklist: ReadinessChecklist,
  override?: ReadinessOverride,
): string | undefined {
  const open = checklist.blockers;
  if (to === 'Ready' && (from === 'outdated' || checklist.state === 'outdated')) {
    return 'transition to Ready: Outdated is not Ready and must not report as Ready';
  }
  if (to !== 'Go Live') {
    return open.length === 0 ? undefined : `transition to ${to}: bypassed ${open.length} blocker(s)`;
  }
  if (open.length === 0) return undefined;
  if (override === undefined) return `transition to Go Live: bypassed ${open.length} blocker(s) with no override`;
  return overrideProblem(checklist, override);
}

export function preparationOn(db: RepositoryDb, options: PreparationOptions): PreparationStore {
  const repositories = repositoriesOn(db);
  const snapshots = repositories[SNAPSHOT_RECORD];
  const runEvents = repositories[RUN_EVENT_RECORD];
  const services = repositories[SERVICE_RECORD];
  const trail = auditOn(db, { now: options.now, ...(options.newId === undefined ? {} : { newId: options.newId }) });
  const observe = options.observe ?? ((): ReadinessObservation => ({}));

  const author = (context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> => {
    const { actor, correlationId } = context as RequestContext;
    return { actor, correlationId };
  };

  /** The Service's standing stamp: its items, and the ordinal that is the Service's own revision. */
  const standing = async (context: unknown, serviceId: string): Promise<StandingService | undefined> => {
    const [found] = await services.read(context, { serviceId }, { sort: { sequence: -1 }, limit: 1 });
    if (found === undefined) return undefined;
    const sequence = found['sequence'];
    if (typeof sequence !== 'number') {
      throw new PreparationError('corrupt', `${serviceId} is stamped with an ordinal this code cannot read`);
    }
    const parsed = parseService({ ...found, id: serviceId });
    if (!parsed.ok) {
      throw new PreparationError('corrupt', `${serviceId} holds a Service this code cannot read: ${problems(parsed.problems)}`);
    }
    const items = parsed.value.sections.flatMap((section) =>
      section.items.map((item) => ({ id: item.id, kind: item.kind, enabled: item.enabled, content: item.content ?? null })),
    );
    return { sequence, items };
  };

  /**
   * One address over everything a run would show, in the order it would show it. Two Services that would
   * replay the same slides from the same revisions pin the same content; enabling, disabling, reordering
   * or revising an item is a different manifest, which is the point of pinning it at all.
   */
  const contentPin = (items: readonly PinnableItem[]): string => {
    const shown = items.filter((item) => item.enabled).map(({ id, kind, content }) => ({ id, kind, content }));
    return revisionAddress(createHash(HASH_ALGORITHM).update(revisionBytes({ items: shown })).digest('hex'));
  };

  const snapshotFrom = (found: Record<string, unknown>): PreparedSnapshot => {
    const parsed = parsePreparedSnapshot({
      id: found['_id'],
      pins: found['pins'],
      resolved: { aspectRatio: found['aspectRatio'], safeAreaMargins: found['safeArea'] },
      immutable: true,
    });
    if (!parsed.ok) {
      throw new PreparationError('corrupt', `a prepared manifest this code cannot read: ${problems(parsed.problems)}`);
    }
    return parsed.value;
  };

  const store: PreparationStore = {
    async prepare(context, serviceId, inputs) {
      const row = await standing(context, serviceId);
      if (row === undefined) return undefined;
      const ratio = aspectRatioOf(inputs.aspectRatio);
      const preparedAt = options.now();
      const id = `${serviceId}${SNAPSHOT_KEY_SEPARATOR}${preparedAt}`;
      const parsed = parsePreparedSnapshot({
        id,
        pins: {
          service: `${serviceId}${LAYOUT_PIN_SEPARATOR}${row.sequence}`,
          content: contentPin(row.items),
          slideLayout:
            inputs.slideLayout.id.trim() === ''
              ? ''
              : `${inputs.slideLayout.id}${LAYOUT_PIN_SEPARATOR}${inputs.slideLayout.revision}`,
          serviceTemplate: inputs.serviceTemplate,
          settings: inputs.settings,
          media: inputs.media,
          corpus: inputs.corpus,
        },
        resolved: {
          // Resolved once, here, and recorded — never recomputed while a run is on (ADR 0006).
          aspectRatio: ratio === undefined ? inputs.aspectRatio : aspectRatioLabel(ratio),
          safeAreaMargins: inputs.safeAreaMargins ?? DEFAULT_SAFE_AREA_MARGINS,
        },
        immutable: true,
      });
      if (!parsed.ok) {
        throw new PreparationError('schema', `this is not a prepared manifest: ${problems(parsed.problems)}`);
      }
      const snapshot = parsed.value;
      try {
        await snapshots.append(context, {
          _id: id,
          serviceId,
          preparedAt,
          pins: snapshot.pins,
          aspectRatio: snapshot.resolved.aspectRatio,
          safeArea: snapshot.resolved.safeAreaMargins,
          ...author(context),
        });
      } catch (error) {
        if (error instanceof RepositoryError && error.kind === 'duplicate') {
          throw new PreparationError('conflict', `${id} is already prepared, and a prepared manifest is never rewritten`);
        }
        throw error;
      }
      return { serviceId, preparedAt, snapshot };
    },

    async prepared(context, serviceId) {
      // The index is `serviceId` then `preparedAt` descending, but which manifest is the standing one is
      // decided here rather than by the sort: an ISO instant compares as text, and the answer should not
      // depend on a collation. Preparation is rare enough per Service that reading them all is cheap.
      const found = await snapshots.read(context, { serviceId }, { sort: { preparedAt: -1 } });
      const latest = found.reduce<Record<string, unknown> | undefined>(
        (standingRow, row) =>
          standingRow === undefined || String(row['preparedAt']) > String(standingRow['preparedAt'])
            ? (row as Record<string, unknown>)
            : standingRow,
        undefined,
      );
      if (latest === undefined) return undefined;
      return { serviceId, preparedAt: String(latest['preparedAt']), snapshot: snapshotFrom(latest) };
    },

    async readiness(context, serviceId, observed = {}) {
      const row = await standing(context, serviceId);
      if (row === undefined) return undefined;
      const record = await store.prepared(context, serviceId);
      const checks: ReadinessCheck[] = [];
      const shown = row.items.filter((item) => item.enabled);
      checks.push(
        shown.length === 0
          ? { name: NOTHING_TO_SHOW, group: 'Content', severity: 'blocker', cause: `${serviceId} has no enabled item to show` }
          : {
              name: EVERYTHING_PINNED,
              group: 'Content',
              severity: 'complete',
              cause: `${shown.length} enabled item(s) are pinned at the revision this manifest froze`,
            },
      );
      const pinned = record === undefined ? undefined : pinnedLayoutOf(record.snapshot.pins.slideLayout);
      const current = observed.slideLayoutRevision;
      let outdated = false;
      if (pinned !== undefined && current !== undefined) {
        outdated = isOutdated(pinned.revision, current);
        checks.push(
          outdated
            ? {
                name: LAYOUT_MOVED_ON,
                group: 'Content',
                severity: 'blocker',
                cause: `${pinned.id} moved from revision ${pinned.revision} to ${current}, which needs ${OUTDATED_REQUIRES.join(' and ')}`,
              }
            : {
                name: LAYOUT_CURRENT,
                group: 'Content',
                severity: 'complete',
                cause: `${pinned.id} is still at revision ${pinned.revision}, the one this manifest pinned`,
              },
        );
      }
      checks.push(...(observed.checks ?? []));
      const of = (severity: CheckSeverity): readonly ReadinessCheck[] => checks.filter((check) => check.severity === severity);
      const blockers = of('blocker');
      const state: ReadinessState =
        record === undefined ? 'not prepared' : outdated ? 'outdated' : blockers.length > 0 ? 'blocked' : 'ready';
      return { state, blockers, warnings: of('warning'), completed: of('complete') };
    },

    async override(session, request) {
      // THR-11: checked first, before a single read, so the refusal is this server's and not a client's.
      if (!session.permissions.includes(PRESENTATION_CONTROL)) {
        throw new PreparationError(
          'permission',
          `going live over an open blocker is the Operator's alone, which needs ${PRESENTATION_CONTROL}`,
        );
      }
      const reason = request.reason.trim();
      if (reason === '') {
        throw new PreparationError('reason', 'an override carries a reason a person can read, and this one is empty');
      }
      const context = preparationContext(session.actor, session.correlationId);
      const record = await store.prepared(context, request.serviceId);
      if (record === undefined) {
        throw new PreparationError('state', `${request.serviceId} has no prepared manifest to go live from`);
      }
      // Observed here rather than taken from the request, and then run through the same checklist the
      // Service's own state would produce for anyone asking: a caller that leaves a blocker out of its
      // account of the world does not thereby leave it out of the trail.
      const checklist = await store.readiness(context, request.serviceId, await observe(context, request.serviceId));
      if (checklist === undefined || checklist.blockers.length === 0) {
        throw new PreparationError('state', `${request.serviceId} has no open blocker to override`);
      }
      const override: ReadinessOverride = {
        operator: session.actor,
        reason,
        auditEntry: OVERRIDE_ACTION,
        runLabel: LIVE_OVERRIDDEN_LABEL,
        // Every open blocker the server saw, by name and with the cause it blocked for. Carried, not cleared.
        carried: checklist.blockers,
      };
      const problem = transitionProblem(checklist.state, 'Go Live', checklist, override);
      if (problem !== undefined) throw new PreparationError('state', problem);
      const sequence = (await runEvents.count(context, { runId: request.runId })) + 1;
      await runEvents.append(context, {
        _id: `${request.runId}${SNAPSHOT_KEY_SEPARATOR}${sequence}`,
        runId: request.runId,
        sequence,
        at: options.now(),
        kind: OVERRIDE_ACTION,
        // The run event carries what the run replays from, which is the manifest this override did not touch.
        pinnedRevisions: record.snapshot.pins,
        ...author(context),
      });
      const carried = override.carried.map((check) => `${check.name} (${check.cause})`).join('; ');
      await trail.record(context, {
        action: OVERRIDE_ACTION,
        subject: subjectFor(request.serviceId),
        outcome: 'allowed',
        detail: `${session.actor} went live over ${override.carried.length} open blocker(s) — ${reason}. Carried: ${carried}`,
      });
      return { runId: request.runId, runLabel: LIVE_OVERRIDDEN_LABEL, override, snapshot: record.snapshot };
    },

    async runLabel(context, runId) {
      // Read from the run's own events, so the label holds for the run's whole duration: the override is
      // an event that happened, and no later event can un-happen it.
      const events = await runEvents.read(context, { runId });
      return events.some((event) => event['kind'] === OVERRIDE_ACTION) ? LIVE_OVERRIDDEN_LABEL : LIVE_LABEL;
    },
  };
  return Object.freeze(store);
}
