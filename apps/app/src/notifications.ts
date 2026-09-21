// OPER-02: who gets told that something happened, and on which of the ways they asked to be reached.
//
// The one thing this module must never become is a second history. A product that grows a notification
// store starts answering "what happened here" out of it — because that store is the one with the read
// model, the delivery state and the nice index — and from that day the trail and the notifications drift,
// and the answer an administrator gets depends on which of the two they happened to open. So the trail
// stays the record and a notification is a *pointer into it*: the identifier of the entry it came from,
// its instant, its correlation identifier, and the four facts (`action`, `category`, `subject`,
// `outcome`) a surface needs to say what it is about. Nothing here is written anywhere.
//
// Three deliberate constructions hold that in place rather than describing it.
//
// *The consumer cannot be the producer.* `NotifiableEventReader` is a read method and nothing else. A
// real `Repository` assigns to it — `repositories.ts` gives every record class an `append` too — but this
// module only ever holds the narrower type, so appending to the trail from here is a compile error, not
// a review finding. The only value this file imports at run time is `audit.ts`'s category map; the
// repository layer appears in type position, where it is erased.
//
// *An event is a row the trail wrote.* `notifiableEventOf` refuses any document that does not carry the
// trail's own identity — the record's `_id`, its `at`, the `actor` and `correlationId` a repository
// writes from the context rather than from a caller — and refuses an action `AUDIT_ACTIONS` does not
// declare. There is no other door in. A handler cannot mint an event for itself and then notify on it,
// because the only events this module can see are ones something else already appended.
//
// *Order comes from the data, not from a schedule.* A notification is dated at its source event, never
// at the moment it was derived, and the derivation reads a bounded page that by construction holds only
// entries already committed. The caller carries the watermark between runs, which is why there is no
// cursor stored here either: the position in the stream is the consumer's, and a consumer that loses it
// re-derives rather than losing events.
//
// Severity is read through `CATEGORY_OF`, so an action added to the trail tomorrow is already graded by
// the category the trail files it under — there is no second list here to fall out of step with it.
//
// Nothing here is localized, and nothing here is prose. A notification carries codes and identifiers and
// not one sentence, the same separation `preparation-storage.ts` keeps: whichever surface eventually
// delivers one owns the wording in the reader's own language. The trail's `detail` — free text a caller
// wrote, in whatever language that caller used — is deliberately not carried across for the same reason,
// and because a notification that repeats it has started to be a copy of the trail instead of a pointer
// to it.

import { AUDIT_ACTIONS, CATEGORY_OF } from './audit.js';

import type { AuditAction, AuditCategory, AuditOutcome } from './audit.js';
import type { Document, ReadOptions } from './repositories.js';

/** The ways a person asks to be reached. A name here is a routing target, never a transport: nothing in this file delivers anything. */
export const NOTIFICATION_CHANNELS = ['inApp', 'email', 'webhook'] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** How much of an interruption one notification is worth, least first. */
export const NOTIFICATION_SEVERITIES = ['notice', 'warning', 'critical'] as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

const SEVERITY_RANK: Readonly<Record<NotificationSeverity, number>> = Object.freeze({
  notice: 0,
  warning: 1,
  critical: 2,
});

/**
 * What each of the trail's eight categories is worth, allowed and refused.
 *
 * Keyed by category rather than by action on purpose: the trail owns which actions exist and which
 * category each belongs to, and a per-action table here would be a second copy of `CATEGORY_OF` that a
 * new action silently falls out of. A refusal is never graded below the same category allowed — the test
 * asserts that ordering — because "somebody was stopped" is the half of the trail an operator is least
 * able to reconstruct afterwards.
 *
 * Two rows are worth their reasoning. `settings` is a warning even when it succeeded: a configuration
 * change that nobody noticed is the thing most likely to be discovered on a Sunday. `restore` allowed is
 * likewise a warning rather than a notice, because a restore that ran put data back over what was there.
 */
export const SEVERITY_OF = Object.freeze({
  authentication: { allowed: 'notice', refused: 'warning' },
  authorization: { allowed: 'notice', refused: 'critical' },
  settings: { allowed: 'warning', refused: 'warning' },
  content: { allowed: 'notice', refused: 'notice' },
  presentation: { allowed: 'notice', refused: 'warning' },
  backup: { allowed: 'notice', refused: 'critical' },
  restore: { allowed: 'warning', refused: 'critical' },
  integration: { allowed: 'notice', refused: 'warning' },
} as const satisfies Readonly<Record<AuditCategory, Readonly<Record<AuditOutcome, NotificationSeverity>>>>);

/**
 * One audit entry, as the trail persisted it and as this module is allowed to see it.
 *
 * Every field is one a repository wrote rather than one a caller supplied: `id` is the record's own,
 * `actor` and `correlationId` come from the request context, and `action` is out of the trail's declared
 * list. That is what makes this shape unforgeable without going through the trail first.
 */
export interface NotifiableEvent {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly correlationId: string;
  readonly action: AuditAction;
  readonly subject: string;
  readonly outcome: AuditOutcome;
}

/** One channel a recipient keeps open, and what they want to come through it. */
export interface ChannelPreference {
  readonly channel: NotificationChannel;
  /** The categories this channel carries. An empty list carries none, which is a mute of one channel. */
  readonly categories: readonly AuditCategory[];
  /** The least severity worth reaching them on this channel for. */
  readonly minimumSeverity: NotificationSeverity;
}

/** What one person asked to be told. */
export interface NotificationPreference {
  /** The actor identifier the trail would write for them, so a recipient is the same name as an actor. */
  readonly recipient: string;
  /** Nothing reaches them at all while this is true, whatever the channels below would otherwise carry. */
  readonly muted: boolean;
  readonly channels: readonly ChannelPreference[];
  /** Whether to hear about what they did themselves. Absent is no: an operator knows what they just did. */
  readonly ownActions?: boolean;
}

/** One thing to tell one person on one channel, and where in the trail it came from. */
export interface Notification {
  readonly sourceEventId: string;
  /** The source event's instant, never the derivation's: a notification is as old as what it is about. */
  readonly at: string;
  readonly recipient: string;
  readonly channel: NotificationChannel;
  readonly category: AuditCategory;
  readonly action: AuditAction;
  readonly subject: string;
  readonly outcome: AuditOutcome;
  readonly severity: NotificationSeverity;
  /** The source event's, so a surface can put this next to everything else that request caused. */
  readonly correlationId: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/**
 * One stored document read as an event, or nothing.
 *
 * Nothing is repaired and nothing is defaulted: a row missing any part of the trail's identity is not a
 * half-readable event, it is a document some other writer put in front of this module, and notifying on
 * it would be exactly the invention this module exists not to make.
 */
export function notifiableEventOf(document: Document): NotifiableEvent | undefined {
  const id = text(document['_id']);
  const at = text(document['at']);
  const actor = text(document['actor']);
  const correlationId = text(document['correlationId']);
  const subject = text(document['subject']);
  const outcome = document['outcome'];
  const action = document['action'] as AuditAction;
  if (id === undefined || at === undefined || actor === undefined || correlationId === undefined) return undefined;
  if (subject === undefined || !AUDIT_ACTIONS.includes(action)) return undefined;
  if (outcome !== 'allowed' && outcome !== 'refused') return undefined;
  return Object.freeze({ id, at, actor, correlationId, action, subject, outcome });
}

/** How serious one event is, read through the category the trail itself files its action under. */
export function severityOf(event: NotifiableEvent): NotificationSeverity {
  return SEVERITY_OF[CATEGORY_OF[event.action]][event.outcome];
}

// Plain code-point order, not `localeCompare`: every instant here is the trail's own ISO-8601 in UTC, a
// format that sorts chronologically as text, and a collation that folds punctuation would make two
// instants differing only in their separators compare equal.
const compare = (left: string, right: string): number => {
  if (left < right) return -1;
  return left > right ? 1 : 0;
};

// Oldest first, and by identifier where two entries share an instant, so one page of the trail derives
// to one sequence of notifications however the store happened to hand the rows back.
const inOrder = (left: NotifiableEvent, right: NotifiableEvent): number =>
  left.at === right.at ? compare(left.id, right.id) : compare(left.at, right.at);

/**
 * Every notification a set of events owes a set of recipients. Pure, and a function of its arguments
 * only: the same events and the same preferences derive the same notifications, on any machine, at any
 * hour, with no store consulted and none written.
 */
export function notificationsFrom(
  events: readonly NotifiableEvent[],
  preferences: readonly NotificationPreference[],
): readonly Notification[] {
  const derived: Notification[] = [];
  for (const event of [...events].sort(inOrder)) {
    const category = CATEGORY_OF[event.action];
    const severity = severityOf(event);
    for (const preference of preferences) {
      if (preference.muted) continue;
      if (event.actor === preference.recipient && preference.ownActions !== true) continue;
      const sent = new Set<NotificationChannel>();
      for (const channel of preference.channels) {
        if (sent.has(channel.channel)) continue;
        if (!channel.categories.includes(category)) continue;
        if (SEVERITY_RANK[severity] < SEVERITY_RANK[channel.minimumSeverity]) continue;
        sent.add(channel.channel);
        derived.push(
          Object.freeze({
            sourceEventId: event.id,
            at: event.at,
            recipient: preference.recipient,
            channel: channel.channel,
            category,
            action: event.action,
            subject: event.subject,
            outcome: event.outcome,
            severity,
            correlationId: event.correlationId,
          }),
        );
      }
    }
  }
  return Object.freeze(derived);
}

/**
 * The trail, as much of it as this module is given: one read and no way to write.
 *
 * The audit repository satisfies this and carries a write method besides — which is the point. The wider
 * object is what a caller has; the narrower type is what this module holds, so the write path is
 * unreachable from here rather than merely unused.
 */
export interface NotifiableEventReader {
  read(context: unknown, filter?: Readonly<Record<string, unknown>>, options?: ReadOptions): Promise<Document[]>;
}

/**
 * How much of the trail one derivation reads. The bound `queue.ts` caps a page of jobs at, for the same
 * reason: enough that an ordinary run sees everything since the last one, small enough that a trail years
 * deep is never read at once.
 */
export const NOTIFICATION_PAGE_LIMIT = 500;

export interface DerivationOptions {
  /** The instant the caller last derived up to. Entries at or before it are ones they have already had. */
  readonly since?: string;
  readonly limit?: number;
}

export interface NotificationDerivation {
  readonly notifications: readonly Notification[];
  /**
   * What the caller carries into its next run as `since`, when there is one.
   *
   * Absent from a truncated page on purpose. The page is read newest first, so a full one is missing the
   * *oldest* entries since `since` — precisely the ones a caller advancing its cursor would skip forever.
   * A caller that gets no watermark keeps the one it had and reads again with more room.
   */
  readonly watermark?: string;
  /** Whether the page filled, meaning there are entries since `since` this derivation did not reach. */
  readonly truncated: boolean;
}

/**
 * Derives the notifications a page of the trail owes, and says how far it got.
 *
 * Holds nothing between calls. Everything that makes this repeatable — where the caller had got to, how
 * much to read, who wants what — arrives as an argument, so two deployments deriving from one trail
 * cannot disagree about it and a restart cannot lose it.
 */
export async function deriveNotifications(
  events: NotifiableEventReader,
  context: unknown,
  preferences: readonly NotificationPreference[],
  options: DerivationOptions = {},
): Promise<NotificationDerivation> {
  const limit = options.limit ?? NOTIFICATION_PAGE_LIMIT;
  const documents = await events.read(context, {}, { limit, sort: { at: -1 } });
  const truncated = documents.length >= limit;

  const readable: NotifiableEvent[] = [];
  for (const document of documents) {
    const event = notifiableEventOf(document);
    // A row this module cannot read is left where it is rather than skipped past: it never counts towards
    // the watermark, so whatever can read it still sees it.
    if (event !== undefined && (options.since === undefined || event.at > options.since)) readable.push(event);
  }

  const newest = readable.reduce<string | undefined>(
    (latest, event) => (latest === undefined || event.at > latest ? event.at : latest),
    undefined,
  );
  return Object.freeze({
    notifications: notificationsFrom(readable, preferences),
    ...(truncated || newest === undefined ? {} : { watermark: newest }),
    truncated,
  });
}
